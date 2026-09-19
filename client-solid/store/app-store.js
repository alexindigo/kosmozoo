// client-solid/store/app-store.js — the single global store.
//
// One makeAppStore created at boot, provided via context at the app root.
// Views read store.state.* and call store.actions.* — nothing else. The store
// owns the model: api.mjs is a store-internal dependency; views never fetch.
//
// Reactivity shape: createStore for tree structures (hosts, images with
// meta/judgments, settings mirrors) — path-level updates touch only
// dependents of that path; createSignal for scalar atoms (host, current,
// currentStack, filter, menu flags, confirmDelete).
// Note: the store ROOT is not assignable (st.x = v is silently ignored) —
// root-level replacement goes through setSt("x", v); nested paths assign.

import { createSignal, createMemo, createEffect, onCleanup, createContext, useContext, untrack } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { api } from "/js/api.mjs";
import { metaFromPngBytes } from "/shared/extractor.mjs";
import { makeKeymap, comboFromEvent } from "/js/keys.mjs";
import {
  parseUrl,
  stripHostPrefix,
  planDeleteCurrent,
  diffUrl,
} from "/js/route-parse.mjs";
import { fieldList, nodeImages } from "./fields.js";
import { makeImageWindow } from "./image-window.js";
import { makeSizes } from "./sizes.js";
import { snapTidy, SNAP_QUIET_MS } from "./scroll-snap.js";

// stored host if still present, else first online, else first
function initialHost(hosts, stored) {
  if (stored && hosts[stored]) return stored;
  const names = Object.keys(hosts);
  return names.find((n) => hosts[n].online) ?? names[0] ?? null;
}

// the info-panel split is bounded — a readable text column needs the floor,
// and the images column the ceiling; every write site (drag, boot hydration)
// routes through this
export const clampSplit = (v) => Math.min(0.8, Math.max(0.2, v));

export function makeAppStore() {
  // app data tree — engine-side state
  const [st, setSt] = createStore({
    hosts: {},            // name -> { address, kind, online, capabilities }
    nodesRegistry: {},    // discovered node types (/api/nodes)
    scraper: null,        // { enabled, paused, pending: {host: n} }
    deletePrefs: { useAssetsPlus: true },
    ui: {},               // core.ui settings (stored host, ...)
    judgmentPrefs: { downvoteHides: true, revealThumbedDown: false, hideUp: false },
    images: [],           // [{ id, host, filename, size, meta, judgment }]
    selected: {},         // id -> true (bulk actions; session-only)
    anchors: [],          // [{ name, src(dataURL), meta? }] — local drops, persisted
    views: {},            // per-image zoom views — key -> { s, txf, tyf, … } ( fold)
    diff: { open: false },                  // workbench: single-image viewer
    variations: { open: false, images: [], key: null }, // modal session
    infoOverlay: { open: false, name: "", meta: null }, // anchor ⓘ params
    chips: [],            // status stack: { slot, kind, msg }
    metaPending: 0,
    drafts: {},           // unsaved note text: { "<id>:<cls>": text } — session-only, NOT persisted
  });

  // UI state tree — separate reactive graph, moves here as directed
  const [uiSt, setUiSt] = createStore({
    info: { split: 0.66 }, // info panel: images/nodes split, divider-adjusted
    // collapsed metadata groups: { [group]: true } — persisted
    infoGroups: (() => {
      try { return JSON.parse(localStorage.getItem("kosmozoo.infoGroups.v1")) ?? {}; }
      catch { return {}; }
    })(),
  });

  // scalar atoms
  const [host, setHost] = createSignal(null);
  const [current, setCurrentSig] = createSignal(null); // { remote, image } | null
  const [currentStack, setCurrentStack] = createSignal([]); // trail, oldest first
  const [filter, setFilter] = createSignal("");
  const [hostMenuOpen, setHostMenuOpen] = createSignal(false);
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [confirmDelete, setConfirmDelete] = createSignal(null); // { image } | { images }
  const [keysPanelOpen, setKeysPanelOpen] = createSignal(false);
  const [capturing, setCapturing] = createSignal(null); // action id awaiting a keypress
  // the key-layer stack: open modals push { id, onEscape } and the ONE key
  // dispatcher hands Escape to the TOP layer only ( — no per-modal
  // listeners, no double-close, capture-cancel outranks the panel's own
  // Esc-close binding). An onEscape returning false declines the event
  // (dispatch continues).
  const [keyLayers, setKeyLayers] = createSignal([]);
  const [keysFilter, setKeysFilter] = createSignal("");
  const [menuFilter, setMenuFilter] = createSignal("");
  const [anchorPaneWidth, setAnchorPaneWidth] = createSignal(300); // px, divider-adjusted, persisted
  // the feed's scroll container — Grid hands it over via feed.register; a
  // signal so late registration still lands
  const [feedScrollEl, setFeedScrollEl] = createSignal(null);
  // the feed's virtualizer — the scroll-state data source (visible range,
  // total size); components derive from it instead of walking the DOM
  const [feedVirtualizer, setFeedVirtualizer] = createSignal(null);
  // a divider drag is in flight — App renders the body-level cursor class
  // from this ONE signal : no component touches document.body directly)
  const [resizing, setResizing] = createSignal(false);

  // right-column space + details layout — persisted (workspaceState contract).
  // Read once at construction: the persisted space must be set before the
  // first paint of the pane.
  const [workspace, setWorkspaceSig] = createSignal((() => {
    try {
      return localStorage.getItem("kosmozoo.workspace.v1") === "anchors" ? "anchors" : "details";
    } catch { return "details"; }
  })());
  const [infoLayout, setInfoLayoutSig] = createSignal((() => {
    try {
      const l = localStorage.getItem("kosmozoo.infoLayout.v1");
      return l === "rev" || l === "stacked" ? l : "split";
    } catch { return "split"; }
  })());

  // --- fields derivation (registry) --------------------------------------------
  const fieldsList = createMemo(() => fieldList(st.nodesRegistry));

  // --- feed view: filter + judgment visibility, derived -----------------------
  function isVisible(img) {
    const jp = st.judgmentPrefs;
    if (jp.hideUp && img.judgment?.vote === "up") return false;
    const down = img.judgment?.vote === "down";
    if (!down) return true;
    if (!jp.downvoteHides) return true;
    return !!jp.revealThumbedDown;
  }
  // view = display order of image indices (filtered + visible)
  const view = createMemo(() => {
    const q = filter().toLowerCase();
    const out = [];
    for (let i = 0; i < st.images.length; i++) {
      const img = st.images[i];
      if (q && !img.filename.toLowerCase().includes(q)) continue;
      if (!isVisible(img)) continue;
      out.push(i);
    }
    return out;
  });

  // --- current pointer + trail -------------------------------------------------
  // A { remote, image } pointer → its feed entry (anchors are not feed
  // entries) — the ONE derivation; components used to each carry their own
  // copy of this find . Indexed by the (host, filename) map next to
  // imageIdxById — never a scan.
  function entryFor(c) {
    if (!c || c.remote === "anchor") return null;
    const idx = imageIdxByFile().get(`${c.remote}:${stripHostPrefix(c.remote, c.image ?? "")}`) ?? -1;
    return idx < 0 ? null : { index: idx, entry: st.images[idx], collection: c.remote };
  }
  // the current feed entry: { index, entry, collection } | null
  const currentEntry = createMemo(() => entryFor(current()));
  // the current entry's discovered node images (Header's layout switcher and
  // the details pane read the SAME derivation)
  const currentNodeImages = createMemo(() => {
    const ce = currentEntry();
    return ce ? nodeImages(ce.entry.meta ?? null, ce.entry.host) : [];
  });

  // The current pointer never names an entry the feed has hidden. This is
  // the ONE guard — enforced against the view, never per action: a vote, a
  // pref toggle, a filter, or any future visibility rule all land here by
  // construction. A hidden current advances to the next visible entry in
  // view order (else the previous, else nothing).
  createEffect(() => {
    const c = current();
    if (!c?.image || c.remote !== host()) return;
    if (!st.images.length) return; // a reload in flight, not a visibility change
    const v = view();
    const idx = findByFile(c.image);
    if (idx >= 0 && v.includes(idx)) return;
    const next = idx >= 0
      ? (v.find((i) => i > idx) ?? v[v.length - 1] ?? null)
      : (v[0] ?? null);
    assignCurrent(next != null ? { remote: host(), image: st.images[next].filename } : null, { push: false });
    mirrorCurrentHash();
  });

  // Trail bound: a scroll-through-the-feed session turns over the pointer
  // constantly — the stack is a bounded window, not a full history.
  const STACK_CAP = 200;

  // The single writer for current. On an actual change the replaced pointer
  // goes onto the stack (oldest first) unless push is false (deletion
  // navigation: the outgoing pointer is dead, it must not linger).
  function assignCurrent(next, { push = true } = {}) {
    const prev = current();
    if (push && prev && (prev.remote !== next?.remote || prev.image !== next?.image)) {
      const stack = [...currentStack(), prev];
      if (stack.length > STACK_CAP) stack.shift();
      setCurrentStack(stack);
    }
    setCurrentSig(next ?? null);
  }

  // Walk the trail back: the popped entry leaves the stack (a back-navigation,
  // not a change — the outgoing pointer is NOT pushed). Returns the popped
  // pointer, or null when the trail is empty (current untouched then).
  function popCurrent() {
    const stack = currentStack();
    if (!stack.length) return null;
    const prev = stack[stack.length - 1];
    setCurrentStack(stack.slice(0, -1));
    setCurrentSig(prev);
    return prev;
  }

  // The URL hash MIRRORS current (replaceState → no hashchange loop).
  // Anchors are not feed URLs, so they are not mirrored.
  function mirrorCurrentHash() {
    const c = current();
    if (!c || c.remote === "anchor") return;
    const file = c.image ? stripHostPrefix(c.remote, c.image) : null;
    const want = "#" + encodeURIComponent(c.remote)
      + (file ? "#" + encodeURIComponent(file) : "");
    if (location.hash !== want) history.replaceState(history.state, "", want);
  }

  function findByFile(file) {
    if (!file) return -1;
    return imageIdxByFile().get(`${host()}:${stripHostPrefix(host(), file)}`) ?? -1;
  }

  // one resolver for every source kind; new feeds plug in here. Accepts
  // either a {source,file} side or a current {remote,image} pointer.
  function resolveSide(side) {
    if (!side) return null;
    const source = side.source ?? side.remote;
    const file = side.file ?? side.image;
    if (source === "anchor") {
      const a = st.anchors.find((x) => x.name === file);
      return a ? { name: a.name, src: a.src, meta: a.meta ?? null } : null;
    }
    // input-dir images (node references from the info panel): remote carries
    // the source as "input:<host>"
    if (source.startsWith("input:")) {
      const h = source.slice("input:".length);
      if (!st.hosts[h]) return null;
      return {
        name: file,
        host: h,
        src: api.inputBytesUrl(h, file),
        meta: null,
      };
    }
    if (st.hosts[source]) {
      return {
        name: file,
        host: source,
        src: api.entryBytesUrl(source, file),
        meta: null,
      };
    }
    return null;
  }

  // --- feed seams (the Grid registers its handles here) -------------------------
  const seams = { virtualizer: null };
  // the scroll-activity seam: while a gesture is active the feed renders and
  // the rail tracks — the model (current selection, snap tidy) moves only at
  // settle. One debounce, owned here; Grid just calls feed.scrolled(top) per
  // scroll event.
  const [feedActivity, setFeedActivity] = createSignal("settled");
  // the feed's scroll position — Grid's scroll handler is the ONLY writer;
  // the rail's wave bounds are the other consumer (one signal, both consumers)
  const [feedScrollTop, setFeedScrollTop] = createSignal(0);
  // a programmatic scroll in flight (the snap's quiet window) — a store
  // signal, set by restoreToIndex/scrollTop/the settle tidy, read by settle;
  // no module global 
  const [programmaticScrollUntil, setProgrammaticScrollUntil] = createSignal(0);
  const scrollQuiet = () => Date.now() < programmaticScrollUntil();
  const quietScrolls = (ms = SNAP_QUIET_MS) =>
    setProgrammaticScrollUntil(Math.max(programmaticScrollUntil(), Date.now() + ms));
  let feedSettleTimer = 0;
  let gestureStart = null; // scrollTop at the gesture's origin
  const FEED_SETTLE_MS = 150;

  function feedScrolled(top) {
    if (feedActivity() !== "scrolling") {
      setFeedActivity("scrolling");
      gestureStart = feedScrollEl()?.scrollTop ?? 0;
    }
    setFeedScrollTop(top ?? feedScrollEl()?.scrollTop ?? 0);
    clearTimeout(feedSettleTimer);
    feedSettleTimer = setTimeout(feedSettle, FEED_SETTLE_MS);
  }

  // the settle pipeline — does exactly: (1) current from the stopped
  // range, (2) the snap tidy (pure; the quiet window is the store signal),
  // (3) resolveAhead for the new range, (4) want for it. No mid-gesture meta
  // buffer — meta patches never change geometry (size is listing data), so
  // they apply on arrival ( dead). No bottom guard — with exact estimates
  // getTotalSize is exact ( dead).
  function feedSettle() {
    feedSettleTimer = 0;
    setFeedActivity("settled");
    const col = feedScrollEl();
    const vz = feedVirtualizer();
    if (!col || !vz) { gestureStart = null; return; }
    // 1. current selection — a consequence of a STOPPED scroll
    actions.current.settleFromRange(vz.getVirtualItems(), col.scrollTop, col.clientHeight);
    // 2. snap tidy — small, directional, capped; never while a programmatic
    // scroll is in flight or the workbench is open
    const net = gestureStart == null ? 0 : col.scrollTop - gestureStart;
    gestureStart = null;
    if (!scrollQuiet() && !st.diff.open) {
      if (snapTidy(col, vz.getVirtualItems(), { direction: Math.sign(net), net })) quietScrolls();
    }
    // 3. sizes resolve around the stopped range…
    stageResolveAhead();
    // 4. …and metas are wanted for it (the mid-gesture throttle is folded
    // into this debounce — dead); the want flush rides the same settle
    wantRangeNow();
    flushWant();
  }

  function restoreToIndex(idx) {
    if (idx < 0) return;
    // the virtualizer's index space is the size-known list (a subset of
    // view) — map into IT, not the view (they only coincide when every
    // entry's size is known)
    const knownPos = entriesWithKnownSize().indexOf(idx);
    if (knownPos < 0) return;
    seams.virtualizer?.scrollToIndex(knownPos, { align: "center" });
    // a programmatic center, not user scrolling — keep the snap from
    // immediately pulling the centered card back to the top edge
    quietScrolls();
    wantRangeNow();
  }

  // --- metadata channel: want + poll + patch in place ---------------------------
  let metaVersion = 0;
  const wantSet = new Set();
  let metaPollTimer = null;

  // wants only collect — the flush rides the settle debounce : no timer
  // of its own; feedSettle calls flushWant after wantRangeNow)
  function wantMeta(image) {
    if (image.meta || wantSet.has(image.filename)) return;
    wantSet.add(image.filename);
  }

  async function flushWant() {
    if (!host()) return;
    const files = [...wantSet];
    wantSet.clear();
    if (!files.length) return;
    try {
      const r = await api.want(host(), files);
      if (typeof r.pending === "number") {
        setSt("metaPending", r.pending);
        if (r.pending > 0) scheduleMetaPoll();
      }
    } catch { /* next sweep re-wants */ }
  }

  function scheduleMetaPoll(delay = 5000) {
    clearTimeout(metaPollTimer);
    metaPollTimer = setTimeout(pollMetadata, delay);
  }

  async function pollMetadata() {
    if (!host()) return;
    try {
      const r = await api.meta(host(), metaVersion);
      if (r.pending !== undefined) setSt("metaPending", r.pending);
      if (r.changed) {
        metaVersion = r.v;
        const byId = imageIdxById();
        for (const [name, meta] of Object.entries(r.items ?? {})) {
          const idx = byId.get(`${host()}:${name}`);
          if (idx === undefined || st.images[idx].meta) continue;
          // meta patches never change geometry (size is listing data) — they
          // apply on arrival; the settle buffer is dead 
          setSt("images", idx, "meta", meta);
        }
        // dims ride the same poll : an entry the dims pass reached
        // after the listing loaded gets its width/height patched in — the
        // size-known view extends without a reload
        for (const [name, d] of Object.entries(r.dims ?? {})) {
          const idx = byId.get(`${host()}:${name}`);
          if (idx === undefined || !d) continue;
          const img = st.images[idx];
          if (img.width && img.height) continue;
          setSt("images", idx, "width", d.width);
          setSt("images", idx, "height", d.height);
        }
        // the node registry grows as the engine extracts — refresh it
        // alongside so newly discovered node types materialize without a
        // reload (a fresh engine boots with an empty registry)
        api.nodes().then((reg) => setSt("nodesRegistry", reg)).catch(() => {});
      }
    } catch { /* transient; next poll retries */ }
    if (st.metaPending > 0) scheduleMetaPoll();
  }

  // the scraper status poll (the menu row reads it) lives ONLY while ingest
  // work is pending — the forever-setInterval is dead ; the effect owns
  // its timer and cleans it up
  createEffect(() => {
    if (!(st.metaPending > 0)) return;
    const t = setInterval(async () => {
      setSt("scraper", reconcile(await api.prefetch().catch(() => st.scraper)));
    }, 2000);
    onCleanup(() => clearInterval(t));
  });

  // meta-want follows the viewport: from a little behind the current window
  // to a few screens ahead of it, so most sizes resolve BEFORE those cards
  // render. Called at settle, at restore, and after a load — the scroll-path
  // throttle is folded into the settle debounce .
  const WANT_LOOKAHEAD = 60, WANT_BEHIND = 10;

  function wantRangeNow() {
    const v = view();
    const vz = feedVirtualizer();
    const startIdx = vz?.getVirtualItems()[0]?.index ?? 0;
    const from = Math.max(0, startIdx - WANT_BEHIND);
    for (let i = from; i < Math.min(startIdx + WANT_LOOKAHEAD, v.length); i++) {
      const image = st.images[v[i]];
      if (image) wantMeta(image);
    }
  }

  // --- image list load -----------------------------------------------------------
  async function loadImages(name) {
    // a host switch must not leave the previous host's feed on screen —
    // and its per-entry error state dies with the list (id-keyed, cleared)
    setSt("images", reconcile([]));
    setSt("selected", reconcile({}));
    window_.clear();
    if (!name) return;
    actions.status.active("load", `loading image list from ${name}…`);
    try {
      setSt("images", reconcile((await api.entries(name)).map((e) => ({
        // collection:name string keys exist only here, derived (plan )
        id: `${name}:${e.name}`, host: name, filename: e.name,
        size: e.size, hash: e.hash, state: e.state,
        meta: e.meta, extracted: e.extracted, judgment: e.judgment,
        width: e.width, height: e.height,
      }))));
      // the URL is adopted into current after every (re)fetch, then the feed
      // centers on it. Only a first visit with no hash at all invents a
      // current image (top card); a hash stripped to #host stays file-less.
      const file = parseUrl().file;
      let idx = file ? findByFile(file) : -1;
      if (idx < 0 && !location.hash) {
        const first = view()[0];
        if (first != null) idx = first;
      }
      if (idx >= 0) {
        assignCurrent({ remote: name, image: st.images[idx].filename });
        mirrorCurrentHash();
        restoreToIndex(idx);
      } else {
        // URL names a file the list doesn't have (yet) — keep it, no center
        assignCurrent(file ? { remote: name, image: file } : null);
        mirrorCurrentHash();
      }
      wantRangeNow();
      flushWant(); // the no-restore path has no scroll to settle the flush
      await pollMetadata();
      actions.status.clear("load");
      if (st.images.length === 0) {
        actions.status.info(`no output images on ${name}`);
      } else {
        const hidden = st.images.filter((i) => i.judgment?.vote === "down").length;
        const base = filter()
          ? `${view().length} of ${st.images.length} matching “${filter()}” from ${name}`
          : `${st.images.length} images from ${name}`;
        actions.status.info(base + (hidden ? ` (${hidden} hidden)` : ""));
      }
    } catch (err) {
      actions.status.clear("load");
      actions.status.error(`couldn't load images from ${name}: ${err?.message ?? err}`);
    }
  }

  // --- deletion --------------------------------------------------------------------
  // Port of the ConfirmDelete confirm path: delete, plan the pointer, scrub the
  // trail, patch the list, then navigate. Computed against the PRE-delete list
  // (adjacency needs the original indices), executed after it.
  async function deleteImages(images) {
    // the workbench may be sitting on one of these images
    if (st.diff.open) {
      const sideMatches = (side, img) => !!side && side.source === img.host &&
        (side.file === img.filename || side.file === img.host + "#" + img.filename);
      if (images.some((i) => sideMatches(st.diff.left, i) || sideMatches(st.diff.right, i))) {
        setSt("diff", "open", false);
      }
    }
    const results = await Promise.allSettled(images.map((img) => api.deleteEntry(img.host, img.filename)));
    const okIds = new Set();
    results.forEach((r, i) => {
      if (r.status === "fulfilled") {
        okIds.add(images[i].id);
        setSt("selected", images[i].id, undefined);
      } else {
        console.error(`delete failed: ${images[i].filename}: ${r.reason?.message ?? r.reason}`);
      }
    });
    if (okIds.size === 0) return false; // nothing succeeded
    const hostName = images[0].host;
    const deletedFiles = new Set(images.filter((i) => okIds.has(i.id)).map((i) => i.filename));
    const plan = planDeleteCurrent(
      st.images, deletedFiles, hostName, current(), currentStack().at(-1) ?? null);
    // deleted images are dead ends — scrub them from the back-trail
    const deletedStripped = new Set([...deletedFiles].map((f) => stripHostPrefix(hostName, f)));
    setCurrentStack(currentStack().filter((p) =>
      p.remote !== hostName || p.image == null || !deletedStripped.has(stripHostPrefix(hostName, p.image))));
    setSt("images", (imgs) => imgs.filter((i) => !okIds.has(i.id)));
    if (plan) {
      if (plan.kind === "pop") popCurrent();
      else if (plan.kind === "set") assignCurrent({ remote: hostName, image: plan.image }, { push: false });
      else assignCurrent(null, { push: false });
      mirrorCurrentHash();
    }
    if (plan && plan.kind !== "clear") {
      // the pointer moved — the feed follows it (scrolling IS browsing: an
      // off-viewport pointer is overridden by the next scroll settle)
      const idx = findByFile(current()?.image);
      if (idx >= 0) restoreToIndex(idx);
    }
    return true;
  }

  const imageIdx = (id) => imageIdxById().get(id) ?? -1;

  // the ONE download-name convention : <host>#<filename>, unless the
  // filename already carries the tag
  function downloadName(img) {
    return img.filename.startsWith(img.host + "#") ? img.filename : img.host + "#" + img.filename;
  }
  // the ONE transient-anchor download : download and bulk.save share it
  function triggerDownload(url, name) {
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  // note autosave: one timer per note key, owned by the store 
  const noteTimers = {};
  const NOTE_SAVE_MS = 500;

  // : every card's size is DATA before it renders — listing dims →
  // meta dims → off-DOM measurement (sizes store). The virtualizer's item
  // list is the size-known view; the pending set drives the resolver. Both
  // memos are reactive over the listing (store paths) and the sizes store
  // (version signal), so landings recompute both by construction.
  //
  // THE TWO INDEX SPACES. The state array (st.images) is indexed by IMAGE
  // INDEX (listing order); the feed renders a filtered view of it
  // (entriesWithKnownSize), indexed by FEED POSITION. On a dense list they
  // coincide; while dims are still arriving the list is sparse and image
  // index > feed position — so they are NEVER interchangeable. The rule:
  //   feed code (Grid, Card, the src window, the rail, settle, staging)
  //   handles feed positions and entry ids only; image indices exist only
  //   in state-level code (judgment actions, bulk ops, entryFor).
  // The crossing is exactly these named conversions — nothing else maps
  // between spaces:
  //   imageIdxById / imageIdxByFile — id/file → image index (state space)
  //   feedPositionOf / feedEntryAt  — id ↔ feed position (feed space)
  // (stageResolveAhead is the one further crossing, feed → view, for the
  // size loader, which must see pending entries too.)
  const imageIdxById = createMemo(() => {
    const m = new Map();
    for (let i = 0; i < st.images.length; i++) m.set(st.images[i].id, i);
    return m;
  });
  // (host, filename) → index — entryFor/findByFile's lookup; the filename
  // is normalized (the "host#" tag is stripped) so either form hits
  const imageIdxByFile = createMemo(() => {
    const m = new Map();
    for (let i = 0; i < st.images.length; i++) {
      const img = st.images[i];
      m.set(`${img.host}:${stripHostPrefix(img.host, img.filename)}`, i);
    }
    return m;
  });
  const sizes_ = makeSizes({
    srcFor: (id) => {
      const img = st.images[imageIdxById().get(id)];
      return img ? api.entryBytesUrl(img.host, img.filename) : null;
    },
    imageAt: (i) => st.images[i],
  });
  const sizeKnown = (img) =>
    !!img && (!!img.width && !!img.height || !!(img.meta?.width && img.meta?.height) || sizes_.sizeOf(img.id) !== null);
  const sizePending = (img) =>
    !!img && !((img.width && img.height) || (img.meta?.width && img.meta?.height)) && sizes_.sizeOf(img.id) === null && !sizes_.loadFailed(img.id);
  const entriesWithKnownSize = createMemo(() => view().filter((i) => sizeKnown(st.images[i])));
  // the pending set as a COUNT and a lazy index iterator — never a
  // 3000-element materialization per landing (RC8)
  const pendingSizeCount = createMemo(() => {
    let n = 0;
    for (const i of view()) if (sizePending(st.images[i])) n++;
    return n;
  });
  function* pendingSizeIdx() {
    for (let vp = 0; vp < view().length; vp++) {
      if (sizePending(st.images[view()[vp]])) yield vp;
    }
  }
  // the feed-space conversions (see THE TWO INDEX SPACES above)
  const feedPosById = createMemo(() => {
    const m = new Map();
    const list = entriesWithKnownSize();
    for (let p = 0; p < list.length; p++) m.set(st.images[list[p]].id, p);
    return m;
  });
  const feedEntryAt = (pos) => st.images[entriesWithKnownSize()[pos]];
  const feedPositionOf = (id) => feedPosById().get(id);
  // the staging pass shared by the reactive pump and the settle pipeline:
  // resolve sizes around the virtualizer's current range. The range's
  // indices are KNOWN-LIST positions (the virtualizer's index space); the
  // resolver walks VIEW positions — the visible window's edges are mapped
  // between the two so the behind window covers every pending entry above
  // the first visible, and the ahead window stages past the last.
  function stageResolveAhead() {
    const vz = feedVirtualizer();
    const items = vz?.getVirtualItems() ?? [];
    if (!items.length) return;
    const known = entriesWithKnownSize();
    const v = view();
    const firstView = v.indexOf(known[items[0].index]);
    const lastView = v.indexOf(known[items[items.length - 1].index]);
    if (firstView < 0 || lastView < 0) return;
    sizes_.resolveAhead(v, firstView, lastView);
  }
  // the drain pump: a landing re-stages the next batch. It tracks the
  // pending COUNT and the settle signal only — never getVirtualItems
  // (mid-gesture staging was a second stager; feedSettle stages too)
  createEffect(() => {
    if (pendingSizeCount() === 0) return;
    if (feedActivity() !== "settled") return;
    untrack(stageResolveAhead);
  });

  // the image-src window derives membership from the virtualizer's range
  // ± pad — the store's registered virtualizer is the one source
  const window_ = makeImageWindow({ range: () => {
    const vz = seams.virtualizer;
    const items = vz?.getVirtualItems() ?? [];
    if (!items.length) return null;
    return { first: items[0].index, last: items[items.length - 1].index };
  } });

  // --- status-stack helpers ------------------------------------------------------
  const chipTimers = { transient: 0 };
  let errSeq = 0;

  // --- keymap ------------------------------------------------------------------------
  // The registry itself is framework-free (client/js/keys.mjs); the version
  // signal fans mutations out to the keys panel.
  const keymap = makeKeymap();
  const [keysVersion, setKeysVersion] = createSignal(0);
  const bumpKeys = () => setKeysVersion((v) => v + 1);

  // a running key capture is the TOP key layer: plain Escape cancels it
  // (the panel stays open); a modified Escape declines — that is a rebind
  // candidate, not a cancel
  createEffect(() => {
    if (!capturing()) return;
    setKeyLayers((ls) => [...ls.filter((l) => l.id !== "keys-capture"), {
      id: "keys-capture",
      onEscape: (e) => {
        if (e?.ctrlKey || e?.altKey || e?.shiftKey || e?.metaKey) return false;
        setCapturing(null);
        return true;
      },
    }]);
    onCleanup(() => setKeyLayers((ls) => ls.filter((l) => l.id !== "keys-capture")));
  });

  // --- per-image zoom views (folded from views.mjs — : no second
  // module-level store; the state lives in the tree and the debounced
  // persistence lives here). Keys are image ids ("host:filename") for
  // candidates, "anchor:<name>" for anchors; box-fraction units;
  // default-absent (an untouched view is absent, not a default object).
  const viewDirty = new Set();
  let viewsTimer = null;
  async function flushViews() {
    clearTimeout(viewsTimer);
    viewsTimer = null;
    if (!viewDirty.size) return;
    const patch = {};
    for (const k of viewDirty) patch[k] = st.views[k] ?? null;
    viewDirty.clear();
    await api.setSettings("core.views", patch).catch(() => {});
  }

  // --- anchor helpers --------------------------------------------------------------
  const ANCHORS_LS_KEY = "kosmozoo.anchors.v1";
  const ANCHOR_MAX_DIM = 1200;

  function persistAnchors() {
    try {
      localStorage.setItem(ANCHORS_LS_KEY, JSON.stringify(
        st.anchors.map((a) => ({ name: a.name, src: a.src, ...(a.meta ? { meta: a.meta } : {}) }))));
    } catch {
      actions.status.error("anchors not saved: browser storage full");
    }
  }

  function readAsDataUrl(file) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
  }

  // Downscale via canvas so persisted anchors fit the storage quota.
  function shrinkToStore(src, fileName) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        if (Math.max(img.width, img.height) <= ANCHOR_MAX_DIM) return resolve(src);
        const k = ANCHOR_MAX_DIM / Math.max(img.width, img.height);
        const c = document.createElement("canvas");
        c.width = Math.round(img.width * k);
        c.height = Math.round(img.height * k);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        resolve(/\.png$/i.test(fileName) ? c.toDataURL("image/png") : c.toDataURL("image/jpeg", 0.85));
      };
      img.onerror = () => resolve(src);
      img.src = src;
    });
  }

  // wire shape → store shape; capabilities.delete drives the affordances
  const toHosts = (colls) => Object.fromEntries(Object.entries(colls ?? {}).map(([n, c]) => [n, {
    address: c.address, kind: c.kind, online: c.online,
    capabilities: c.capabilities ?? null,
  }]));

  // the loaded collection's record — the delete affordances read
  // capabilities.delete from HERE, never a derived mirror : indexing
  // hosts with the host SIGNAL function always read the "hide" fallback)
  const currentCollection = createMemo(() => st.hosts[host()] ?? null);

  // registered feature modules — a plain module-level list, not store
  // state: registration happens once at boot (before first render), and
  // store array proxies can't support flatMap/map chains on function-valued
  // items (the Symbol(solid-proxy) defineProperty trap)
  const registeredFeatures = [];
  const actions = {
    features: {
      // a feature module { name, actions?, cardAction?, bulkAction?, Modal? }
      // installs its store actions under its name + joins the affordance list
      register(f) {
        if (registeredFeatures.some((x) => x.name === f.name)) return;
        if (f.actions) {
          actions[f.name] = f.actions({ get state() { return stateObj; }, actions, setSt, reconcile });
        }
        registeredFeatures.push(f);
      },
    },

    // boot-time data, loaded exactly once (the bootData.mjs contract).
    // api.hosts is deliberately not caught — a failed host list fails the
    // whole boot (the caller surfaces it).
    async boot() {
      setSt("hosts", reconcile(toHosts(await api.collections())));
      const ui = await api.settings("core.ui").catch(() => ({}));
      setSt("ui", ui);
      // persisted info-panel split hydrates the uiSt tree the details pane
      // renders from (clamped — a wild stored value must not poison the
      // layout); infoLayout hydrates from its localStorage key at signal
      // construction
      if (typeof ui.infoSplit === "number" && ui.infoSplit > 0) {
        setUiSt("info", "split", clampSplit(ui.infoSplit));
      }
      setSt("nodesRegistry", await api.nodes().catch(() => ({})));
      const del = await api.settings("core.delete").catch(() => ({}));
      setSt("deletePrefs", { useAssetsPlus: del.useAssetsPlus ?? true });
      const jns = await api.settings("core.judgment").catch(() => ({}));
      setSt("judgmentPrefs", "downvoteHides", jns.downvoteHides ?? true);
      setSt("scraper", reconcile(await api.prefetch().catch(() => null)));
      actions.anchors.load();
      await actions.keys.loadSaved();
      await actions.anchors.loadPaneWidth();
      // persisted per-image zoom views (feed zoom carries across reloads)
      await actions.views.init();
      // the URL hash outranks the stored host: /#host[#filename] is shareable state
      const route = parseUrl();
      const urlHost = route.view === "diff" ? route.left?.source : route.host;
      const h = urlHost && st.hosts[urlHost] ? urlHost : initialHost(st.hosts, st.ui.host);
      if (h) await actions.hosts.select(h, { keepFile: true }); // hash pristine at boot
      // a /diff URL boots into the workbench on the left side
      if (route.view === "diff") actions.diff.openDiff(route.left, route.right);
    },

    hosts: {
      // keepFile: boot and URL-driven switches arrive with the hash already
      // pristine; UI switches drop the file part (it named the old host's image)
      async select(name, { keepFile } = {}) {
        setHost(name);
        setHostMenuOpen(false);
        if (!keepFile) {
          assignCurrent({ remote: name, image: null });
          mirrorCurrentHash();
        }
        api.setSettings("core.ui", { host: name }).catch(() => {});
        await loadImages(name);
      },
      async add(name, addr) {
        name = (name ?? "").trim();
        addr = (addr ?? "").trim();
        if (!name || !addr) return { ok: false };
        try {
          await api.addCollection(name, addr);
          setSt("hosts", reconcile(toHosts(await api.collections())));
          return { ok: true };
        } catch {
          return { ok: false };
        }
      },
      async remove(name) {
        try {
          await api.removeCollection(name);
          setSt("hosts", reconcile(toHosts(await api.collections())));
          if (host() === name) {
            await actions.hosts.select(Object.keys(st.hosts)[0] ?? null);
          }
        } catch { /* surfaced by the status chrome once it lands */ }
      },
      toggleMenu() { setHostMenuOpen(!hostMenuOpen()); },
      closeMenu() { setHostMenuOpen(false); },
    },

    images: {
      reload() { return loadImages(host()); },
      delete(images) { return deleteImages(images); },
      // byte size isn't in every host's listing — a HEAD on the bytes route fills it
      async fillSize(id) {
        const idx = imageIdx(id);
        if (idx < 0 || st.images[idx].size != null) return;
        const img = st.images[idx];
        const size = await api.entrySizeProbe(img.host, img.filename);
        if (size != null) setSt("images", idx, "size", size);
      },
      // download via a transient anchor (plain download — the "saved"
      // indicator was removed with the feature, Q3)
      download(id) {
        const idx = imageIdx(id);
        if (idx < 0) return;
        const img = st.images[idx];
        triggerDownload(api.entryBytesUrl(img.host, img.filename), downloadName(img));
      },
    },

    judgments: {
      // vote: 'up' | 'down' | null — path-level update; the view memo and
      // the card's data attrs follow by construction
      async setVote(image, vote) {
        await api.setJudgment(image.host, image.filename, { vote });
        const idx = imageIdx(image.id);
        if (idx < 0) return;
        // the engine lists images with judgment: null — the path set needs an
        // object to traverse into
        if (!st.images[idx].judgment) setSt("images", idx, "judgment", {});
        setSt("images", idx, "judgment", "vote", vote === null ? undefined : vote);
      },
      async toggleFavorite(image) {
        const next = !(image.judgment?.favorite);
        await api.setJudgment(image.host, image.filename, { favorite: next || null });
        const idx = imageIdx(image.id);
        if (idx < 0) return;
        if (!st.images[idx].judgment) setSt("images", idx, "judgment", {});
        setSt("images", idx, "judgment", "favorite", next ? true : undefined);
      },
      async saveNotes(image, notes) {
        await api.setJudgment(image.host, image.filename, { notes }).catch(() => {});
        const idx = imageIdx(image.id);
        if (idx < 0) return;
        if (!st.images[idx].judgment) setSt("images", idx, "judgment", {});
        setSt("images", idx, "judgment", "notes",
          (!notes.pos && !notes.neg) ? undefined : notes);
      },
      // "Show thumbed-down" toggles a session flag — the votes are never touched
      toggleReveal() {
        setSt("judgmentPrefs", "revealThumbedDown", !st.judgmentPrefs.revealThumbedDown);
        return st.judgmentPrefs.revealThumbedDown;
      },
      // "Hide thumbed-up" — the session-only counterpart
      toggleHideUp() {
        setSt("judgmentPrefs", "hideUp", !st.judgmentPrefs.hideUp);
        return st.judgmentPrefs.hideUp;
      },
      async setDownvoteHides(on) {
        setSt("judgmentPrefs", "downvoteHides", on);
        await api.setSettings("core.judgment", { downvoteHides: on }).catch(() => {});
      },
    },

    selected: {
      set(id, on) { setSt("selected", id, on ? true : undefined); },
    },

    // per-image zoom views: zoomable.mjs reads/writes through these (the
    // module-level Map/Set/timer are gone — ); one debounce owns the save
    views: {
      async init() {
        const stored = await api.settings("core.views").catch(() => ({}));
        const clean = {};
        for (const [k, v] of Object.entries(stored)) if (v) clean[k] = v;
        setSt("views", reconcile(clean));
      },
      get(key) { return st.views[key] ?? null; },
      // persist:false — a restore writing the stored view back is a read,
      // not a write: it must not schedule a settings PATCH
      set(key, v, { persist = true } = {}) {
        if (v) setSt("views", key, v);
        else setSt("views", key, undefined);
        if (!persist) return;
        viewDirty.add(key);
        clearTimeout(viewsTimer);
        viewsTimer = setTimeout(flushViews, 400);
      },
    },

    // unsaved note text — lives here so neighbors read drafts without
    // walking the DOM for a rendered textarea. setDraft owns the autosave
    // debounce : the draft mirror is the controlled textarea's value;
    // the save lands first and the draft clears only when it still holds
    // the saved text (no rollback flicker mid-edit).
    notes: {
      setDraft(id, cls, text, save) {
        const key = `${id}:${cls}`;
        setSt("drafts", key, text);
        clearTimeout(noteTimers[key]);
        noteTimers[key] = setTimeout(async () => {
          delete noteTimers[key];
          await save?.(text);
          if (st.drafts[key] === text) setSt("drafts", key, undefined);
        }, NOTE_SAVE_MS);
      },
      async flushDraft(id, cls, save) {
        const key = `${id}:${cls}`;
        const text = st.drafts[key];
        clearTimeout(noteTimers[key]);
        delete noteTimers[key];
        if (text === undefined) return;
        await save?.(text);
        if (st.drafts[key] === text) setSt("drafts", key, undefined);
      },
      clearDraft(id, cls) { setSt("drafts", `${id}:${cls}`, undefined); },
    },

    ui: {
      setFilter(v) { setFilter(v); }, // the view memo consumes it
      setResizing(v) { setResizing(!!v); },
      toggleMenu() { setMenuOpen(!menuOpen()); },
      closeMenu() { setMenuOpen(false); },
      async refresh() {
        setSt("hosts", reconcile(toHosts(await api.collections())));
        if (host()) await loadImages(host());
      },
      setWorkspace(space) {
        if (workspace() === space) return;
        setWorkspaceSig(space);
        try { localStorage.setItem("kosmozoo.workspace.v1", space); } catch { /* private mode */ }
      },
      setInfoLayout(mode) {
        if (!(mode === "split" || mode === "rev" || mode === "stacked") || infoLayout() === mode) return;
        setInfoLayoutSig(mode);
        try { localStorage.setItem("kosmozoo.infoLayout.v1", mode); } catch { /* private mode */ }
      },
      info: {
        split: {
          set(ratio) {
            const r = clampSplit(ratio);
            setUiSt("info", "split", r);
            // optimistic: the local split stands; a failed persist only
            // loses the memory across reloads
            api.setSettings("core.ui", { infoSplit: r }).catch(() => {});
          },
        },
      },
      // collapsed metadata groups; the whole map persists under the same key
      infoGroup: {
        toggle(group) {
          const now = !uiSt.infoGroups[group];
          setUiSt("infoGroups", group, now ? true : undefined);
          try { localStorage.setItem("kosmozoo.infoGroups.v1", JSON.stringify(uiSt.infoGroups)); }
          catch { /* private mode */ }
        },
      },
      toggleKeysPanel() { actions.keys.togglePanel(); },
    },

    current: {
      set(remote, image) {
        assignCurrent({ remote, image });
        mirrorCurrentHash();
      },
      assign: assignCurrent,
      pop: popCurrent,
      mirror: mirrorCurrentHash,
      // scrolling IS browsing: once the scroll SETTLES, the last card whose
      // top crossed the feed's vertical midpoint becomes current (debounced
      // by the caller — a fast scroll must not spend a render per frame).
      // items: the virtualizer's visible range — [{ index, start, size }] in
      // scroll order, where index is a KNOWN-LIST position (the virtualizer's
      // index space) — mapped through entriesWithKnownSize, never view
      // (they only coincide when every entry's size is known). Viewport
      // geometry comes from the seamed scroll element. Index math, never
      // the DOM.
      settleFromRange(items, viewportTop, clientHeight) {
        if (st.diff.open) return;
        const mid = viewportTop + clientHeight / 2;
        let file = null;
        for (const it of items) {
          if (it.start > mid) break;
          const im = feedEntryAt(it.index);
          if (im) file = im.filename;
        }
        if (!file || file === current()?.image) return;
        assignCurrent({ remote: host(), image: file });
        mirrorCurrentHash();
      },
    },

    confirm: {
      open(req) { setConfirmDelete(req); },
      close() { setConfirmDelete(null); },
    },

    diff: {
      // read-only model query the workbench surface derives its src from
      resolve: resolveSide,
      // open the workbench on the current pointer
      open() {
        if (!current() || !resolveSide(current())) return false;
        setSt("diff", "open", true);
        return true;
      },
      hide() { setSt("diff", "open", false); },
      close() {
        if (!st.diff.open) return;
        const c = current();
        setSt("diff", "open", false);
        if (location.pathname === "/diff") {
          // opened from a /diff URL: land back on the feed
          if (history.state?.kz) {
            history.back(); // a pushed entry: popstate lands on the feed URL
          } else {
            const feed = c && c.remote !== "anchor" && st.hosts[c.remote]
              ? `/#${encodeURIComponent(c.remote)}#${encodeURIComponent(stripHostPrefix(c.remote, c.image))}`
              : `/#${encodeURIComponent(host())}`;
            history.replaceState(null, "", feed);
            window.dispatchEvent(new PopStateEvent("popstate"));
          }
        } else if (c && c.remote !== "anchor" && c.remote === host()) {
          // opened from the feed: re-center it on the current image
          const idx = findByFile(stripHostPrefix(c.remote, c.image));
          if (idx >= 0) restoreToIndex(idx);
        }
      },
      // feed card click: the current image is that candidate
      openFromFeed(imgIdx) {
        const im = st.images[imgIdx];
        if (!im) return;
        assignCurrent({ remote: im.host, image: im.filename });
        mirrorCurrentHash();
        actions.diff.open();
      },
      // discovered image click: fromOutput refs (LoadImage-from-output) are
      // ordinary output images — open them via the feed-image path, not the
      // input-bytes route
      openInput(h, file, fromOutput = false) {
        if (!h || !file) return;
        assignCurrent({ remote: fromOutput ? h : `input:${h}`, image: file });
        mirrorCurrentHash();
        actions.diff.open();
      },
      // anchor card click: the current image is that anchor
      openFromAnchor(anchorIdx) {
        const anchor = st.anchors[anchorIdx];
        if (!anchor) return;
        assignCurrent({ remote: "anchor", image: anchor.name });
        // anchors are not feed URLs — no hash mirror
        actions.diff.open();
      },
      // /diff deep links (the pair view is gone — the workbench opens on the
      // left side and ignores the right). A push entry keeps the /diff URL so
      // browser back/forward close/re-open via the route.
      openDiff(left, right, { push } = {}) {
        if (!left || !resolveSide(left)) return false;
        assignCurrent({ remote: left.source ?? left.remote, image: left.file ?? left.image });
        mirrorCurrentHash();
        if (push && right) history.pushState({ kz: 1 }, "", diffUrl(left, right));
        return actions.diff.open();
      },
    },

    feed: {
      register(seamsIn) {
        seams.virtualizer = seamsIn?.virtualizer ?? null;
        setFeedScrollEl(seamsIn?.scrollEl ?? null);
        setFeedVirtualizer(seamsIn?.virtualizer ?? null);
      },
      restoreToIndex,
      // the single scroll entry point — the store owns the activity state
      // and the settle pipeline; the model never moves mid-gesture
      scrolled: feedScrolled,
      wantRangeNow,
      retryImage(id) { window_.retry(id); },
      // floating button: back to the top of the feed
      scrollTop() {
        const col = feedScrollEl();
        if (!col) return;
        quietScrolls();
        col.scrollTo({ top: 0, behavior: "smooth" });
      },
    },

    // URL-as-mirror routing: hashchange/popstate land here. The hash adopts
    // host + file into the store; navigating away closes the workbench.
    route: {
      async changed() {
        const r = parseUrl();
        if (r.view === "diff") {
          actions.diff.openDiff(r.left, r.right); // back/forward into a diff URL re-opens it
          return;
        }
        if (st.diff.open) setSt("diff", "open", false); // navigating away closes the workbench
        if (r.host && r.host !== host()) {
          if (!st.hosts[r.host]) return;
          await actions.hosts.select(r.host, { keepFile: true }); // hash already pristine
          return;
        }
        if (!r.file) return;
        const idx = findByFile(r.file);
        if (idx >= 0) {
          assignCurrent({ remote: host(), image: st.images[idx].filename });
          mirrorCurrentHash();
          restoreToIndex(idx);
        } else {
          await loadImages(host());
        }
      },
    },

    // --- status stack ----------------------------------------------------------
    // transient: one shared chip, fades 6s after its last update. active:
    // pinned chips keyed by slot, visible for the activity's duration.
    // error: sticky. ALL chips dismiss on click.
    status: {
      info(msg) {
        setSt("chips", (chips) => {
          const rest = chips.filter((c) => c.slot !== "transient");
          return [...rest, { slot: "transient", kind: "info", msg }];
        });
        clearTimeout(chipTimers.transient);
        chipTimers.transient = setTimeout(() => actions.status.dismiss("transient"), 6000);
      },
      active(slot, msg) {
        setSt("chips", (chips) => {
          const rest = chips.filter((c) => c.slot !== slot);
          return [...rest, { slot, kind: "active", msg }];
        });
      },
      error(msg) {
        setSt("chips", (chips) => [...chips, { slot: `err-${++errSeq}`, kind: "error", msg }]);
      },
      clear(slot) {
        setSt("chips", (chips) => chips.filter((c) => c.slot !== slot));
        if (slot === "transient") clearTimeout(chipTimers.transient);
      },
      dismiss(slot) {
        setSt("chips", (chips) => chips.filter((c) => c.slot !== slot));
        if (slot === "transient") clearTimeout(chipTimers.transient);
      },
    },

    // --- keys: bindings, capture, persisted keymap ------------------------------
    keys: {
      setFilter(v) { setKeysFilter(v); },
      register(id, defaultKey, fn, opts = {}) {
        keymap.bind(id, defaultKey, fn, opts);
        bumpKeys();
      },
      togglePanel() {
        setKeysPanelOpen(!keysPanelOpen());
        setCapturing(null);
      },
      closePanel() {
        setKeysPanelOpen(false);
        setCapturing(null);
      },
      startCapture(id) { setCapturing(id); },
      // key layers: open modals push themselves; Escape goes to the top one
      pushLayer(layer) {
        setKeyLayers((ls) => [...ls.filter((l) => l.id !== layer.id), layer]);
      },
      popLayer(id) {
        setKeyLayers((ls) => ls.filter((l) => l.id !== id));
      },
      // the capture hook: a pressed key rebinds the capturing action.
      // (Plain Escape never reaches here — the capture layer cancels first;
      // a modified Escape declines the layer and lands here as a rebind.)
      captureEvent(e) {
        const id = capturing();
        if (!id) return;
        const combo = comboFromEvent(e);
        const res = keymap.rebind(id, combo);
        if (res.conflict) {
          actions.status.error(`${combo} already bound to ${res.conflict}`);
        } else {
          api.setSettings("core.keys", { [id]: combo }).catch(() => {});
          actions.status.info(`${id} → ${combo}`);
        }
        bumpKeys();
        setCapturing(null);
      },
      resetOne(id) {
        keymap.resetKey(id);
        api.setSettings("core.keys", { [id]: null }).catch(() => {});
        bumpKeys();
      },
      async resetAll() {
        const saved = await api.settings("core.keys").catch(() => ({}));
        keymap.resetAll();
        for (const id of Object.keys(saved)) {
          api.setSettings("core.keys", { [id]: null }).catch(() => {});
        }
        actions.status.info("keys reset to defaults");
        bumpKeys();
      },
      async loadSaved() {
        const saved = await api.settings("core.keys").catch(() => ({}));
        keymap.setKeymap(saved ?? {});
        bumpKeys();
      },
      // the ONE keydown entry point (main.tsx binds it): Escape goes to the
      // top key layer first (an open modal, a running capture), then the
      // keymap's bindings — first match wins, in registration order (the
      // panel registers before the workbench so keys.close outranks wb.close)
      dispatch(e) {
        if (e.key === "Escape") {
          const top = keyLayers().at(-1);
          if (top && top.onEscape(e) !== false) {
            e.preventDefault();
            e.stopPropagation();
            return;
          }
        }
        if (capturing()) {
          e.preventDefault();
          e.stopPropagation();
          actions.keys.captureEvent(e);
          return;
        }
        if (typeof e.target?.matches === "function"
          && e.target.matches("input, textarea, select")) return;
        if (keymap.dispatch(e)) e.preventDefault();
      },
    },

    // --- anchors: local reference images, persisted as data URLs ----------------
    anchors: {
      load() {
        try {
          const list = (JSON.parse(localStorage.getItem(ANCHORS_LS_KEY)) || [])
            .filter((a) => a && a.name && a.src);
          setSt("anchors", reconcile(list));
        } catch {
          setSt("anchors", []);
        }
      },
      async addFiles(files) {
        for (const file of files) {
          if (!file.type.startsWith("image/")) continue;
          const [dataUrl, buf] = await Promise.all([
            readAsDataUrl(file),
            file.arrayBuffer(),
          ]);
          if (!dataUrl) continue;
          let meta = null;
          try {
            [meta] = await metaFromPngBytes(new Uint8Array(buf));
          } catch { /* metadata optional */ }
          const src = await shrinkToStore(dataUrl, file.name);
          setSt("anchors", (as) => [...as, { name: file.name, src, meta }]);
        }
        persistAnchors();
      },
      remove(name) {
        setSt("anchors", (as) => as.filter((a) => a.name !== name));
        persistAnchors();
      },
      // drag reorder: move the dragged anchor before/after the hovered one.
      // A no-op when the position would not change, and persistence waits
      // for the drop ( — stringifying every base64 anchor per pointer
      // move was the drag cost)
      reorder(draggedName, overName, before) {
        if (!draggedName || draggedName === overName) return;
        const arr = [...st.anchors];
        const from = arr.findIndex((a) => a.name === draggedName);
        if (from < 0 || arr.findIndex((a) => a.name === overName) < 0) return;
        const [item] = arr.splice(from, 1);
        const to = arr.findIndex((a) => a.name === overName);
        const insertAt = before ? to : to + 1;
        if (insertAt === from) return; // unchanged position — no write
        arr.splice(insertAt, 0, item);
        setSt("anchors", reconcile(arr));
      },
      // the drop end of a reorder: persist once 
      persist() { persistAnchors(); },
      showInfo(name, meta) { setSt("infoOverlay", { open: true, name, meta }); },
      closeInfo() { setSt("infoOverlay", "open", false); },
      setPaneWidth(w) {
        setAnchorPaneWidth(w);
        api.setSettings("core.ui", { anchorWidth: w + "px" }).catch(() => {});
      },
      async loadPaneWidth() {
        const ui = await api.settings("core.ui").catch(() => ({}));
        if (ui.anchorWidth) {
          const w = parseInt(ui.anchorWidth, 10);
          if (w) setAnchorPaneWidth(w);
        }
      },
    },

    // --- bulk actions on the selection -------------------------------------------
    bulk: {
      images() { return st.images.filter((i) => st.selected[i.id]); },
      clear() { setSt("selected", reconcile({})); },
      async vote(vote) {
        const images = actions.bulk.images();
        await Promise.all(images.map((img) =>
          api.setJudgment(img.host, img.filename, { vote }).then(() => {
            const idx = imageIdx(img.id);
            if (idx < 0) return;
            if (!st.images[idx].judgment) setSt("images", idx, "judgment", {});
            setSt("images", idx, "judgment", "vote", vote);
          }).catch((e) => actions.status.error(`vote failed: ${img.filename}: ${e.message}`))));
        actions.status.info(`${images.length} image${images.length > 1 ? "s" : ""} ${vote === "up" ? "up-voted" : "down-voted"}`);
      },
      async favorite() {
        const images = actions.bulk.images();
        await Promise.all(images.map((img) =>
          api.setJudgment(img.host, img.filename, { favorite: true }).then(() => {
            const idx = imageIdx(img.id);
            if (idx < 0) return;
            if (!st.images[idx].judgment) setSt("images", idx, "judgment", {});
            setSt("images", idx, "judgment", "favorite", true);
          }).catch((e) => actions.status.error(`favorite failed: ${img.filename}: ${e.message}`))));
        actions.status.info(`${images.length} image${images.length > 1 ? "s" : ""} favorited`);
      },
      save() {
        const images = actions.bulk.images();
        for (const img of images) {
          triggerDownload(api.entryBytesUrl(img.host, img.filename), downloadName(img));
        }
        actions.status.info(`saving ${images.length} image${images.length > 1 ? "s" : ""}`);
      },
    },

    // --- menu / settings rows -----------------------------------------------------
    menu: {
      setFilter(v) { setMenuFilter(v); },
      async scraperToggle(on) {
        await api.setPrefetch({ enabled: on });
        setSt("scraper", reconcile(await api.prefetch().catch(() => st.scraper)));
      },
      async scraperPause() {
        await api.setPrefetch({ paused: !st.scraper?.paused });
        setSt("scraper", reconcile(await api.prefetch().catch(() => st.scraper)));
      },
      async deleteAssetsPlus(on) {
        await api.setSettings("core.delete", { useAssetsPlus: on }).catch(() => {});
        setSt("deletePrefs", { ...st.deletePrefs, useAssetsPlus: on });
        setSt("hosts", reconcile(toHosts(await api.collections()))); // capabilities.delete depends on the toggle
      },
    },
  };

  const stateObj = {
    // trees — getters keep reads subscribed to the live store paths
    featureCardActions: (image) => registeredFeatures.flatMap((f) =>
      (f.cardAction ? [{ ...f.cardAction, onAction: () => f.cardAction.onAction({ state: stateObj, actions }, image) }] : [])),
    featureBulkActions: () => registeredFeatures.flatMap((f) =>
      (f.bulkAction ? [{ ...f.bulkAction, onAction: () => f.bulkAction.onAction({ state: stateObj, actions }) }] : [])),
    get hosts() { return st.hosts; },
    get nodesRegistry() { return st.nodesRegistry; },
    get scraper() { return st.scraper; },
    get deletePrefs() { return st.deletePrefs; },
    get ui() { return st.ui; },
    get judgmentPrefs() { return st.judgmentPrefs; },
    resizing,
    downloadName,
    get images() { return st.images; },
    get selected() { return st.selected; },
    get anchors() { return st.anchors; },
    get diff() { return st.diff; },
    get variations() { return st.variations; },
    get infoOverlay() { return st.infoOverlay; },
    get chips() { return st.chips; },
    get metaPending() { return st.metaPending; },
    get drafts() { return st.drafts; },
    get views() { return st.views; },
    // derived
    view,
    fieldsList,
    // the image-src window (a capability, not data)
    window: window_,
    // scalar atoms
    host,
    current,
    currentStack,
    currentEntry,
    currentNodeImages,
    currentCollection,
    entryFor,
    filter,
    hostMenuOpen,
    menuOpen,
    menuFilter,
    keysFilter,
    capturing,
    // the keymap's action list, fanned out by the version signal
    bindings: () => { keysVersion(); return keymap.list(); },
    anchorPaneWidth,
    confirmDelete,
    keysPanelOpen,
    workspace,
    infoLayout,
    feedScrollEl,
    feedScrollTop,
    feedVirtualizer,
    feedActivity,
    // a card's image size: the listing's content dims, else the extractor
    // meta's dims, else the off-DOM loader's measurement — null = unknown
    // (unknown = the card is NOT in the feed — the invariant)
    cardSize(idx) {
      const img = st.images[idx];
      if (!img) return null;
      if (img.width && img.height) return { w: img.width, h: img.height };
      if (img.meta?.width && img.meta?.height) return { w: img.meta.width, h: img.meta.height };
      return sizes_.sizeOf(img.id);
    },
    pendingSizeCount,
    pendingSizeIdx,
    imageIdxById,
    feedEntryAt,
    feedPositionOf,
    entriesWithKnownSize: () => entriesWithKnownSize(),
  };

  // UI state accessor — separate reactive graph
  const uiStateObj = {
    get info() { return uiSt.info; },
    get infoGroups() { return uiSt.infoGroups; },
  };

  return { state: stateObj, actions, ui: uiStateObj };
}

export const AppStoreContext = createContext(null);

export function useAppStore() {
  return useContext(AppStoreContext);
}
