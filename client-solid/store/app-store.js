// client-solid/store/app-store.js — the single global store.
//
// One makeAppStore created at boot, provided via context at the app root.
// Views read store.state.*, invoke shared handles, and use explicit mechanical/
// editor/lifecycle ports. Private actions below own the model; covered public
// compatibility signatures are facades into handles. Views never fetch.
//
// Reactivity shape: createStore for tree structures (hosts, images with
// meta/judgments, settings mirrors) — path-level updates touch only
// dependents of that path; createSignal for scalar atoms (host, current,
// currentStack, filter, menu flags, confirmDelete).
// Note: the store ROOT is not assignable (st.x = v is silently ignored) —
// root-level replacement goes through setSt("x", v); nested paths assign.

import { createSignal, createMemo, createEffect, on, onCleanup, getOwner, createContext, useContext, untrack, batch } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { api } from "/js/api.mjs";
import { metaFromPngBytes } from "/shared/extractor.mjs";
import { makeKeymap, comboFromEvent } from "/js/keys.mjs";
import {
  parseUrl,
  planDeleteCurrent,
  diffUrl,
  feedUrl,
} from "/js/route-parse.mjs";
import { isEntryName, isFolderPath, inFolder } from "/shared/entry-path.mjs";
import { makeSourceBrowse } from "./source-browse.js";
import { makeSourceFreshness } from "./source-freshness.js";
import { fieldList, nodeImages } from "./fields.js";
import { pairSides } from "../features/diff/pair.mjs";
import { makeImageWindow } from "./image-window.js";
import { makeSizes } from "./sizes.js";
import { snapTidy, SNAP_QUIET_MS } from "./scroll-snap.js";
import { makeJudgments } from "./judgments.js";
import { cardState } from "./card-state.js";
import { makeCommandHandles } from "./command-handles.js";
import { registerCoreCommands, commandFacades } from "./core-commands.js";
import { makeInputPolicy } from "./input-policy.js";

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

export function makeAppStore({ pollActivity = typeof window !== "undefined", storage = () => globalThis.localStorage } = {}) {
  // app data tree — engine-side state
  const [st, setSt] = createStore({
    hosts: {},            // name -> { address, kind, online, capabilities }
    sourceActivity: {},   // engine-owned ephemeral snapshots, never persisted
    sourceSaving: {},     // confirmed source-attribute writer's pending rows
    nodesRegistry: {},    // discovered node types (/api/nodes)
    scraper: null,        // { enabled, paused, pending: {host: n} }
    deletePrefs: { useAssetsPlus: true },
    ui: {},               // core.ui settings (stored host, ...)
    judgmentPrefs: { downvoteHides: true, revealThumbedDown: false, hideUp: false },
    images: [],           // [{ id, host, filename, size, meta, judgment }]
    inventory: { revision: null, coverage: null, folders: [""], loading: false,
      subfolders: { supported: null, reason: "Output inventory has not loaded" } },
    selected: {},         // id -> true (bulk actions; session-only)
    anchors: [],          // [{ name, src(dataURL), meta? }] — local drops, persisted
    views: {},            // per-image zoom views — key -> { s, txf, tyf, … } ( fold)
    // workbench: the two-sided comparator. The pair is feed current ×
    // right-pane current (session-only); modes and mask prefs are session-only.
    diff: {
      open: false,
      mode: "two-up",       // two-up | one-up | split | difference
      col: "feed",          // active column (One-Up visible side, primary in every view)
      locked: true,         // entangled zoom: a gesture's delta writes BOTH view keys
      splitT: 0.5,          // wipe position, 0..1 of stage width
      activeOpacity: 1,     // the active column's photo opacity (every mode)
      diffAbs: true,        // absolute vs proportional highlight
      diffOpacity: 1,
      diffThreshold: 8,     // the match floor: deltas at or below it show the base
      anchorName: null,     // right current (anchors space); null → first
      infoFile: null,       // right current (details space): node-image file…
      infoSource: null,     //   …or a /diff-URL right side's source (else derived)
      pairedWith: null,     // the left image a /diff open established the pair on
    },
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
  const [acquisitionRevision, setAcquisitionRevision] = createSignal(0);
  let sourceSession = null, selectionGeneration = 0, disposed = false;
  const ownsSession = (s) => !!s && !disposed && sourceSession === s &&
    host() === s.id && st.hosts[s.id]?.address === s.address && sourceRecords.get(s.id) === s.source;

  function beginSourceSession(id) {
    retireFeedScroll();
    clearTimeout(sourceSession?.retryTimer);
    clearTimeout(metaPollTimer);
    wantSet.clear();
    metaVersion = 0;
    setSt("metaPending", 0);
    sourceSession = { id, address: st.hosts[id]?.address, source: sourceRecords.get(id), generation: ++selectionGeneration,
      loading: true, requested: 1, completed: 0, refreshTask: null, retryTimer: null, errors: 0 };
    sizes_.setContext(sourceSession);
    setAcquisitionRevision((v) => v + 1);
    return sourceSession;
  }
  const [current, setCurrentSig] = createSignal(null); // { remote, image } | null
  const [currentStack, setCurrentStack] = createSignal([]); // trail, oldest first
  const [filter, setFilter] = createSignal("");
  const [selectedFolder, setSelectedFolder] = createSignal("");
  let sourceBrowse, browseRevision = 0, browseTarget = { folder: "", current: undefined, filter: "" };
  const [browseRestore, setBrowseRestore] = createSignal(null);
  const [hostMenuOpen, setHostMenuOpen] = createSignal(false);
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [confirmDelete, setConfirmDelete] = createSignal(null); // { image } | { images }
  const [keysPanelOpen, setKeysPanelOpen] = createSignal(false);
  const [capturing, setCapturing] = createSignal(null); // action id awaiting a keypress
  // Layers are command references and opaque registrations. Input-policy
  // eligibility/decline is separate from action results; an accepted modal
  // request consumes Escape even if its owner later cancels it.
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
      return l === "rev" || l === "stacked" || l === "stacked-rev" ? l : "split";
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
  const folderView = createMemo(() => {
    const folder = selectedFolder(), out = [];
    for (let i = 0; i < st.images.length; i++) if (inFolder(st.images[i].filename, folder)) out.push(i);
    return out;
  });
  const view = createMemo(() => {
    const q = filter().toLowerCase();
    const out = [];
    for (const i of folderView()) {
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
    const idx = fileIndex(c.remote, c.image);
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

  // the comparator's pair: feed current × right-pane current (the right side
  // follows the workspace space — anchors, or the info panel's node images)
  const diffPair = createMemo(() => pairSides({
    current: current(),
    workspace: workspace(),
    anchors: st.anchors,
    anchorName: st.diff.anchorName,
    nodeImages: currentNodeImages(),
    infoFile: st.diff.infoFile,
    infoSource: st.diff.infoSource,
    host: host(),
  }));

  // a B side pinned to the current graph's node images dies with that graph:
  // when the feed current moves to a DIFFERENT image, a stale infoFile
  // resets to the new graph's first (or nothing) — /diff-URL sides included.
  // The reset is gated on the pointer's IDENTITY changing, and skips the
  // pointer move a /diff open established the pair on (pairedWith).
  createEffect(on(
    () => (current() ? `${current().remote}:${current().image}` : null),
    (key, prevKey) => {
      const f = st.diff.infoFile;
      if (!f || key === prevKey) return;
      if (st.diff.infoSource && st.diff.open && typeof location !== "undefined" && location.pathname === "/diff") return;
      if (st.diff.pairedWith === key) return; // the establishing move
      setSt("diff", "pairedWith", null);
      const imgs = currentNodeImages();
      if (!imgs.some((im) => im.file === f)) {
        setSt("diff", "infoFile", imgs[0]?.file ?? null);
        setSt("diff", "infoSource", null);
      }
    },
  ));

  // The current pointer never names an entry the feed has hidden. This is
  // the ONE guard — enforced against the view, never per action: a vote, a
  // pref toggle, a filter, or any future visibility rule all land here by
  // construction. A hidden current advances to the next visible entry in
  // view order (else the previous, else nothing).
  createEffect(() => {
    const c = current();
    if (!c?.image || c.remote !== host()) return;
    if (st.inventory.loading || sourceSession?.pendingBrowse) return;
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
  function persistBrowse() {
    const s = sourceSession, c = current();
    if (!ownsSession(s) || !s.inventoryReady || (c && c.remote !== host())) return;
    sourceBrowse?.set(s.id, { address: s.address, folder: selectedFolder(), current: c?.image ?? null });
  }

  function assignCurrent(next, { push = true, persist = true, intent = true, widen = intent } = {}) {
    if (next?.image && next.remote === host()) {
      const idx = fileIndex(next.remote, next.image);
      if (idx >= 0) next = { remote: next.remote, image: st.images[idx].filename };
    }
    const prev = current();
    if (push && prev && (prev.remote !== next?.remote || prev.image !== next?.image)) {
      const stack = [...currentStack(), prev];
      if (stack.length > STACK_CAP) stack.shift();
      setCurrentStack(stack);
    }
    batch(() => {
      if (widen && next?.remote === host() && next.image && !inFolder(next.image, selectedFolder())) setSelectedFolder("");
      setCurrentSig(next ?? null);
      if (intent) {
        browseRevision++;
        setAcquisitionRevision((v) => v + 1);
        setBrowseRestore(null);
        if (!next || next.remote === host()) {
          browseTarget = { folder: selectedFolder(), filter: filter(), current: next?.image ?? null };
        }
      }
    });
    if (persist) persistBrowse();
  }

  // Walk the trail back: the popped entry leaves the stack (a back-navigation,
  // not a change — the outgoing pointer is NOT pushed). Returns the popped
  // pointer, or null when the trail is empty (current untouched then).
  function popCurrent() {
    const stack = currentStack();
    if (!stack.length) return null;
    const prev = stack[stack.length - 1];
    persistBrowse();
    setCurrentStack(stack.slice(0, -1));
    if (prev.remote !== host() && st.hosts[prev.remote]) {
      actions.hosts.select(prev.remote, { target: { ...rememberedTarget(prev.remote), current: prev.image, explicit: true }, historyMode: "replace" });
    } else {
      assignCurrent(prev, { push: false });
      mirrorCurrentHash();
    }
    return prev;
  }

  // The URL hash MIRRORS current (replaceState → no hashchange loop).
  // Anchors are not feed URLs, so they are not mirrored.
  function mirrorCurrentHash(mode = "replace") {
    const c = current();
    if (typeof location === "undefined" || typeof history === "undefined" || !host() || c?.remote === "anchor") return;
    const context = { folder: selectedFolder(), filter: filter(), search: location.search ?? "" };
    let want;
    if (location.pathname === "/diff") {
      if (!st.diff.open) return; // route adoption establishes both sides first
      const pair = diffPair();
      if (pair.a && pair.b) want = diffUrl(pair.a, pair.b, context);
      else return;
    } else want = feedUrl(host(), c?.remote === host() ? c.image : null, context);
    if ((location.pathname ?? "/") + (location.search ?? "") + (location.hash ?? "") !== want) {
      if (mode === "push") history.pushState({ kzBrowse: 1 }, "", want);
      else history.replaceState(history.state, "", want);
    }
  }

  // Exact canonical addresses win. A legacy host# reference is only a fallback
  // when that exact name is absent; real host# filenames never get rekeyed.
  function fileIndex(remote, file) {
    if (!file) return -1;
    const map = imageIdxByFile(), exact = map.get(`${remote}:${file}`);
    if (exact !== undefined) return exact;
    const prefix = remote + "#";
    return map.get(`${remote}:${file.startsWith(prefix) ? file.slice(prefix.length) : prefix + file}`) ?? -1;
  }

  function findByFile(file) {
    if (!file) return -1;
    return fileIndex(host(), file);
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
  const [feedRegistration, setFeedRegistration] = createSignal(null);
  let lastAcquisition = null;
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
  // a COMPENSATION scroll (landing/merge) is quieter than quiet: the settle
  // it triggers must not reassign current at all — the scroll exists to
  // preserve position, and with sub-card estimate error the viewport-middle
  // pick would hop. Restores keep their snap-quiet but DO track current.
  const [suppressSettleCurrent, setSuppressSettleCurrent] = createSignal(false);
  let feedSettleTimer = 0;
  let pendingFeedSettle = null; // ownership of this debounce, never a preview ID
  let gestureStart = null; // scrollTop at the gesture's origin
  const FEED_SETTLE_MS = 150;

  function retireFeedScroll() {
    clearTimeout(feedSettleTimer);
    feedSettleTimer = 0;
    pendingFeedSettle = null;
    gestureStart = null;
    setSuppressSettleCurrent(false);
    setFeedActivity("settled");
  }

  const validAcquisitionContext = (scheduled) => !!scheduled && ownsSession(scheduled.session) &&
    scheduled.session.inventoryReady && !scheduled.session.pendingBrowse &&
    !st.inventory.loading && scheduled.revision === browseRevision &&
    scheduled.virtualizer === feedVirtualizer() && scheduled.col === feedScrollEl();
  const validScrollContext = (scheduled) => validAcquisitionContext(scheduled) &&
    scheduled.commitEligible !== false && !scheduled.session.loading;

  // The existing midpoint-crossing rule, shared by committed settle and rail.
  // Keys fence a virtualizer's old position geometry during identity reorders.
  function feedTargetEntryId(items, viewportTop, clientHeight) {
    if (!Array.isArray(items) || !Number.isFinite(viewportTop) || viewportTop < 0 ||
        !Number.isFinite(clientHeight) || clientHeight <= 0) return null;
    const mid = viewportTop + clientHeight / 2;
    let target = null, previousStart = -Infinity;
    for (const item of items) {
      if (!item || !Number.isFinite(item.start) || item.start < previousStart) return null;
      previousStart = item.start;
      const entry = Number.isInteger(item.index) && item.index >= 0 ? feedEntryAt(item.index) : null;
      if (item.key !== undefined && (!entry || item.key !== entry.id)) return null;
      if (item.start <= mid && entry) target = entry.id;
    }
    return target;
  }

  function feedMarkerEntryId() {
    const committed = currentEntry()?.entry.id ?? null;
    if (feedActivity() !== "scrolling" || st.diff.open || suppressSettleCurrent() ||
        !validScrollContext(pendingFeedSettle)) return committed;
    const col = feedScrollEl(), vz = feedVirtualizer();
    return col && vz ? feedTargetEntryId(vz.getVirtualItems(), feedScrollTop(), col.clientHeight) ?? committed : committed;
  }

  function feedScrolled(top) {
    if (disposed) return;
    const scheduled = { session: sourceSession, revision: browseRevision,
      virtualizer: feedVirtualizer(), col: feedScrollEl(), commitEligible: !sourceSession?.loading };
    if (!validAcquisitionContext(scheduled)) {
      batch(() => { retireFeedScroll(); setFeedScrollTop(top ?? feedScrollEl()?.scrollTop ?? 0); });
      return;
    }
    if (!scrollQuiet() && !suppressSettleCurrent()) setBrowseRestore(null);
    clearTimeout(feedSettleTimer);
    pendingFeedSettle = scheduled;
    batch(() => {
      if (feedActivity() !== "scrolling") {
        setFeedActivity("scrolling");
        gestureStart = feedScrollEl()?.scrollTop ?? 0;
        lastAcquisition = null;
        // the src window freezes mid-gesture: a 200-card sweep fires nothing
        window_.freeze();
      }
      setFeedScrollTop(top ?? feedScrollEl()?.scrollTop ?? 0);
    });
    feedSettleTimer = setTimeout(() => feedSettle(scheduled), FEED_SETTLE_MS);
  }

  // the settle pipeline — does exactly: (1) current from the stopped
  // range, (2) the snap tidy (pure; the quiet window is the store signal),
  // (3) resolveAhead for the new range, (4) want for it. No mid-gesture meta
  // buffer — meta patches never change geometry (size is listing data), so
  // they apply on arrival ( dead). No bottom guard — with exact estimates
  // getTotalSize is exact ( dead).
  function feedSettle(scheduled) {
    if (pendingFeedSettle !== scheduled) return; // cannot cancel a newer callback
    if (!validAcquisitionContext(scheduled)) { batch(retireFeedScroll); return; }
    const col = feedScrollEl();
    const vz = feedVirtualizer();
    if (!col || !vz) { batch(retireFeedScroll); return; }
    // 1. current selection — a consequence of a STOPPED scroll. A settle
    // triggered by a COMPENSATION scroll (landing/merge) must not reassign:
    // the scroll exists to preserve position, and with sub-card estimate
    // error the viewport-middle pick hops to the wrong card
    batch(() => {
      if (validScrollContext(scheduled) && !suppressSettleCurrent()) {
        actions.current.settleFromRange(vz.getVirtualItems(), col.scrollTop, col.clientHeight);
      }
      feedSettleTimer = 0;
      pendingFeedSettle = null;
      setSuppressSettleCurrent(false);
      setFeedActivity("settled");
    });
    // 2. snap tidy — small, directional, capped; never while a programmatic
    // scroll is in flight or the workbench is open
    const net = gestureStart == null ? 0 : col.scrollTop - gestureStart;
    gestureStart = null;
    if (scheduled.commitEligible && !scrollQuiet() && !st.diff.open) {
      if (snapTidy(col, vz.getVirtualItems(), { direction: Math.sign(net), net })) quietScrolls();
    }
    // The owned readiness reconciliation observes the final stopped geometry.
    setAcquisitionRevision((v) => v + 1);
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

  async function flushWant(s = sourceSession) {
    if (!ownsSession(s)) return;
    const files = [...wantSet];
    wantSet.clear();
    if (!files.length) return;
    try {
      const r = await api.want(s.id, files);
      if (!ownsSession(s)) return;
      if (typeof r.pending === "number") {
        setSt("metaPending", r.pending);
        if (r.pending > 0) scheduleMetaPoll(1000, s);
      }
    } catch { /* next sweep re-wants */ }
  }

  function scheduleMetaPoll(delay = 5000, s = sourceSession) {
    if (!ownsSession(s)) return;
    clearTimeout(metaPollTimer);
    metaPollTimer = setTimeout(() => pollMetadata(s), delay);
  }

  function pollMetadata(s = sourceSession) {
    if (!ownsSession(s)) return Promise.resolve();
    if (s.metaTask) return s.metaTask;
    s.metaTask = readMetadata(s).finally(() => { s.metaTask = null; });
    return s.metaTask;
  }

  async function readMetadata(s) {
    try {
      const r = await api.meta(s.id, metaVersion);
      if (!ownsSession(s)) return;
      if (r.pending !== undefined) setSt("metaPending", r.pending);
      if (r.changed) {
        metaVersion = r.v;
        const byId = imageIdxById();
        for (const [name, meta] of Object.entries(r.items ?? {})) {
          const idx = byId.get(`${s.id}:${name}`);
          if (idx === undefined || st.images[idx].meta) continue;
          // meta patches never change geometry (size is listing data) — they
          // apply on arrival; the settle buffer is dead 
          setSt("images", idx, "meta", meta);
        }
        // dims ride the same poll : an entry the dims pass reached
        // after the listing loaded gets its width/height patched in — the
        // size-known view extends without a reload
        for (const [name, d] of Object.entries(r.dims ?? {})) {
          const idx = byId.get(`${s.id}:${name}`);
          if (idx === undefined || !d) continue;
          const img = st.images[idx];
          if (img.width && img.height) continue;
          setSt("images", idx, "width", d.width);
          setSt("images", idx, "height", d.height);
        }
        // the node registry grows as the engine extracts — refresh it
        // alongside so newly discovered node types materialize without a
        // reload (a fresh engine boots with an empty registry)
        api.nodes().then((reg) => { if (ownsSession(s)) setSt("nodesRegistry", reg); }).catch(() => {});
      }
    } catch { /* transient; next poll retries */ }
    if (ownsSession(s) && st.metaPending > 0) scheduleMetaPoll(1000, s);
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
  const judgments = makeJudgments({
    entryFor: (id) => st.images[imageIdx(id)],
    write: (collection, filename, patch) => api.setJudgment(collection, filename, patch),
    onError: (message) => actions.status.error(message),
    apply(id, patch) {
      const idx = imageIdx(id);
      if (idx < 0 || !Object.keys(patch).length) return;
      batch(() => {
        if (!st.images[idx].judgment) setSt("images", idx, "judgment", {});
        for (const [field, value] of Object.entries(patch)) {
          // Reconciliation can install its target; the writer must keep its own snapshot.
          setSt("images", idx, "judgment", field,
            value && typeof value === "object" ? reconcile(structuredClone(value)) : value ?? undefined);
        }
      });
    },
  });

  function inventoryReply(reply, kind) {
    if (!reply || !Array.isArray(reply.entries) || !Array.isArray(reply.folders) ||
        !reply.folders.includes("") || reply.folders.some((folder) => !isFolderPath(folder)) ||
        reply.entries.some((entry) => !entry || !isEntryName(kind, entry.name)) ||
        !["recursive", "root-only"].includes(reply.coverage) || !reply.subfolders ||
        typeof reply.subfolders.supported !== "boolean") {
      throw new Error("Invalid output inventory response");
    }
    return reply;
  }

  // All successful inventory reads share their acceptance responsibilities.
  // The first accepted read owns initial restoration, including after retry.
  function acceptInventory(s, inventory, read, before = new Map()) {
    const name = s.id, wasReady = s.inventoryReady;
    let idx = -1;
    batch(() => {
      setSt("images", reconcile(inventory.entries.map((e) => {
        const id = `${name}:${e.name}`, live = st.images[imageIdx(id)], start = before.get(id);
        const sameContent = live && !(e.hash && live.hash && e.hash !== live.hash);
        const enriched = sameContent ? live : null;
        return {
          id, host: name, filename: e.name,
          size: e.size ?? enriched?.size ?? null, hash: e.hash ?? enriched?.hash ?? null, state: e.state,
          meta: enriched?.meta && enriched.meta !== start?.meta ? enriched.meta : e.meta ?? enriched?.meta ?? null,
          extracted: e.extracted || !!enriched?.extracted,
          judgment: judgments.overlay(id, e.judgment, read),
          width: enriched?.width && enriched.width !== start?.width ? enriched.width : e.width ?? enriched?.width ?? null,
          height: enriched?.height && enriched.height !== start?.height ? enriched.height : e.height ?? enriched?.height ?? null,
          modified: e.modified ?? null,
        };
      })));
      s.inventoryReady = true;
      s.pendingBrowse = false;
      setSt("inventory", { revision: inventory.revision, coverage: inventory.coverage,
        folders: inventory.folders, subfolders: inventory.subfolders, loading: false });
      const c = current();
      if (!c || c.remote === name) idx = applyBrowseTarget(wasReady ? { ...browseTarget, ...liveBrowseTarget() } : browseTarget);
      if (wasReady) setFeedMergeNonce((n) => n + 1);
    });
    judgments.endRead(read);
    mirrorCurrentHash();
    if (!wasReady) restoreBrowse(idx);
    else if (browseRestore()) restoreBrowse(findByFile(current()?.image));
    wantRangeNow();
    for (const image of st.images) if (!image.width || !image.height) wantSet.add(image.filename);
    flushWant(s);
  }

  function liveBrowseTarget() {
    const c = current();
    return { folder: selectedFolder(), filter: filter(), current: c?.remote === host() ? c.image : null };
  }

  function rememberedTarget(name) {
    const saved = sourceBrowse.get(name, st.hosts[name]?.address);
    return { folder: saved?.folder ?? "", current: saved ? saved.current : undefined, filter: "" };
  }

  function routeTarget(route) {
    return { folder: route.folder ?? "", filter: route.filter ?? "",
      current: route.view === "diff" ? route.left?.file ?? null : route.file, explicit: true };
  }

  function beginBrowse(target) {
    batch(() => {
      retireFeedScroll();
      browseRevision++;
      setAcquisitionRevision((v) => v + 1);
      setBrowseRestore(null);
      browseTarget = { ...target, folder: st.hosts[host()]?.kind === "folder" ? "" : target.folder ?? "", filter: target.filter ?? "" };
      setSelectedFolder(browseTarget.folder); setFilter(browseTarget.filter);
    });
  }

  // Resolve only after a successful coherent listing. A remembered null is
  // deliberate; a missing/default image falls back within the retained scope.
  function applyBrowseTarget(target) {
    let idx = target.current ? findByFile(target.current) : -1;
    if (target.explicit && idx >= 0 && !inFolder(st.images[idx].filename, selectedFolder())) setSelectedFolder("");
    const visible = view();
    if (target.current === null) idx = -1;
    else if (idx < 0 || !visible.includes(idx)) idx = visible[0] ?? -1;
    assignCurrent(idx >= 0 ? { remote: host(), image: st.images[idx].filename } : null, { intent: false, persist: false });
    browseTarget = { ...target, ...liveBrowseTarget() };
    persistBrowse();
    return idx;
  }

  // A navigation restores once, when its selected entry has dimensions. This
  // is data-driven (no timer or repeated scroll), fenced by source and intent.
  function restoreBrowse(idx) {
    if (idx < 0) return;
    const image = st.images[idx], position = view().indexOf(idx);
    if (position < 0) return;
    if (sizeKnown(image)) { restoreToIndex(idx); return; }
    setBrowseRestore({ id: image.id, session: sourceSession, revision: browseRevision });
    wantSet.add(image.filename);
    flushWant(sourceSession);
    sizes_.resolveAhead(view(), position, position);
  }
  createEffect(() => {
    const request = browseRestore();
    if (!request) return;
    const idx = imageIdxById().get(request.id);
    if (!ownsSession(request.session) || request.revision !== browseRevision || currentEntry()?.entry.id !== request.id) {
      untrack(() => setBrowseRestore(null)); return;
    }
    if (idx === undefined || !sizeKnown(st.images[idx]) || feedActivity() !== "settled") return;
    untrack(() => { setBrowseRestore(null); restoreToIndex(idx); });
  });

  async function loadImages(name) {
    const s = beginSourceSession(name);
    s.pendingBrowse = true;
    s.inventoryReady = false;
    setSt("inventory", { revision: null, coverage: null, folders: [""], loading: true,
      subfolders: st.hosts[name]?.capabilities?.subfolders ?? { supported: null, reason: "Output inventory is loading" } });
    // a host switch must not leave the previous host's feed on screen —
    // and its per-entry error state dies with the list (id-keyed, cleared)
    // Compensation belongs to the outgoing feed, never the new feed's scroll.
    setSuppressSettleCurrent(false);
    setSt("images", reconcile([]));
    setSt("selected", reconcile({}));
    window_.clear();
    if (!name) return;
    actions.status.active("load", `loading image list from ${name}…`);
    const source = s.source;
    // Inventory is independent of an unavailable/held telemetry response.
    // A quick cached response may establish the read's target; a later one
    // remains unacknowledged and reconciles through the same refresh lane.
    if (source && !source.freshness.target()) readActivity(source);
    await Promise.resolve();
    if (!ownsSession(s)) return;
    const ticket = source?.freshness.capture(), requested = s.requested;
    let accepted = false;
    const read = judgments.beginRead(name);
    try {
      const inventory = inventoryReply(await api.inventory(name), st.hosts[name]?.kind);
      if (!ownsSession(s)) return;
      acceptInventory(s, inventory, read);
      await pollMetadata(s);
      if (!ownsSession(s)) return;
      if (sourceRecords.get(name) === source && source) source.freshness.accept(ticket);
      s.completed = requested;
      s.errors = 0;
      accepted = true;
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
      if (!ownsSession(s)) return;
      setSt("inventory", "loading", false);
      actions.status.clear("load");
      actions.status.error(`couldn't load images from ${name}: ${err?.message ?? err}`);
    } finally {
      judgments.endRead(read);
      s.loading = false;
      setAcquisitionRevision((v) => v + 1);
      if (ownsSession(s)) {
        if (accepted) drainRefresh(s);
        else scheduleRefreshRetry(s);
      }
    }
  }

  // Refresh: get new stuff from the server and ADD it to the feed — never a
  // wipe. The fetched listing reconciles into the existing list (keyed by
  // id): unchanged entries keep their store nodes (cards don't remount,
  // in-flight loads keep flying, selections and the src window survive),
  // new arrivals insert where the server orders them, gone entries leave.
  // The current pointer is id-keyed — it follows its entry through the
  // merge; the feed's above-fold compensation (Grid's rule, fed by the
  // merge nonce) keeps the visible cards anchored across prepends.
  const [feedMergeNonce, setFeedMergeNonce] = createSignal(0);
  async function refreshImages(s) {
    if (!ownsSession(s)) return false;
    const name = s.id;
    actions.status.active("load", `checking ${name} for new images…`);
    const read = judgments.beginRead(name);
    try {
      const prevIds = new Set(st.images.map((i) => i.id));
      const before = new Map(st.images.map((i) => [i.id, { meta: i.meta, width: i.width, height: i.height }]));
      const inventory = inventoryReply(await api.inventory(name), st.hosts[name]?.kind), entries = inventory.entries;
      if (!ownsSession(s)) return false;
      acceptInventory(s, inventory, read, before);
      await pollMetadata(s);
      if (!ownsSession(s)) return false;
      setSt("inventory", "loading", false);
      actions.status.clear("load");
      const fresh = entries.filter((e) => !prevIds.has(`${name}:${e.name}`)).length;
      if (fresh > 0) actions.status.info(`${fresh} new image${fresh > 1 ? "s" : ""} from ${name}`);
      return true;
    } catch (err) {
      if (!ownsSession(s)) return false;
      setSt("inventory", "loading", false);
      actions.status.clear("load");
      actions.status.error(`couldn't refresh ${name}: ${err?.message ?? err}`);
      return false;
    } finally {
      judgments.endRead(read);
    }
  }

  // Manual and completion requests share the same selected-source lane. Each
  // successful read consumes only its captured target; a later finish leaves
  // another pass pending. Neither navigation nor modals are part of this path.
  function requestRefresh(s = sourceSession) {
    if (!ownsSession(s)) return Promise.resolve();
    s.requested++;
    clearTimeout(s.retryTimer);
    s.retryTimer = null;
    return drainRefresh(s);
  }

  const requiresRefresh = (s) => ownsSession(s) && (s.requested > s.completed ||
    !!st.hosts[s.id]?.autoRefresh && !!s.source?.freshness.pending());

  function scheduleRefreshRetry(s) {
    if (!ownsSession(s) || s.retryTimer || !requiresRefresh(s)) return;
    s.retryTimer = setTimeout(() => {
      s.retryTimer = null;
      drainRefresh(s);
    }, Math.min(1000 * 2 ** s.errors++, 30000));
  }

  function drainRefresh(s) {
    if (!ownsSession(s) || s.loading || s.retryTimer || !requiresRefresh(s)) return Promise.resolve();
    if (s.refreshTask) return s.refreshTask;
    s.refreshTask = (async () => {
      while (requiresRefresh(s)) {
        const requested = s.requested, source = s.source, ticket = source?.freshness.capture();
        if (!await refreshImages(s)) {
          scheduleRefreshRetry(s);
          break;
        }
        s.errors = 0;
        s.completed = requested;
        if (source && sourceRecords.get(s.id) === source) source.freshness.accept(ticket);
      }
    })().finally(() => { s.refreshTask = null; });
    return s.refreshTask;
  }

  // --- deletion --------------------------------------------------------------------
  // Port of the ConfirmDelete confirm path: delete, plan the pointer, scrub the
  // trail, patch the list, then navigate. Computed against the PRE-delete list
  // (adjacency needs the original indices), executed after it.
  async function deleteImages(images) {
    // the workbench may be sitting on one of these images — either side of
    // the pair (input:<host> sides name input-dir files of that host)
    if (st.diff.open) {
      const { a, b } = diffPair();
      const sideMatches = (side, img) => {
        if (!side) return false;
        const src = side.source.startsWith("input:") ? side.source.slice("input:".length) : side.source;
        return src === img.host &&
          (side.file === img.filename || side.file === img.host + "#" + img.filename);
      };
      if (images.some((i) => sideMatches(a, i) || sideMatches(b, i))) {
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
      folderView().map((idx) => st.images[idx]), deletedFiles, hostName, current(), currentStack().at(-1) ?? null);
    // deleted images are dead ends — scrub them from the back-trail
    setCurrentStack(currentStack().filter((p) =>
      p.remote !== hostName || p.image == null || !deletedFiles.has(p.image)));
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
    const leaf = img.filename.split("/").at(-1);
    return leaf.startsWith(img.host + "#") ? leaf : img.host + "#" + leaf;
  }
  // the ONE transient-anchor download : download and bulk.save share it
  function triggerDownload(url, name) {
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    // Resource activation is an implementation detail, not another outside
    // user click. Keep native download behavior without re-entering UI routing.
    a.addEventListener("click", (event) => event.stopPropagation());
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
      m.set(`${img.host}:${img.filename}`, i);
    }
    return m;
  });
  const sizes_ = makeSizes({
    srcFor: (id) => {
      const img = st.images[imageIdxById().get(id)];
      return img ? api.entryBytesUrl(img.host, img.filename) : null;
    },
    imageAt: (i) => st.images[i],
    identityFor: (id) => {
      const image = st.images[imageIdxById().get(id)];
      return image ? image.hash ?? "" : null;
    },
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
  // the image-src window: frozen while scrolling (sweeping 200 cards fires
  // nothing), rippling C, C+1, C-1, … from the current card at settle;
  // in-flight loads are never aborted. Membership by entry id (landings
  // shift positions under a frozen window; ids don't move).
  const window_ = makeImageWindow({
    entryAt: feedEntryAt,
    count: () => entriesWithKnownSize().length,
  });
  // ONE readiness -> acquisition reconciliation. Geometry/range changes are
  // real dependencies, independent of permission to commit scrolling state.
  createEffect(() => {
    acquisitionRevision();
    const registration = feedRegistration(), s = sourceSession;
    const ce = currentEntry(), known = entriesWithKnownSize(), pending = pendingSizeCount();
    const loading = st.inventory.loading;
    if (disposed || !ownsSession(s) || !s.inventoryReady || s.pendingBrowse || loading || feedActivity() !== "settled" || !registration) return;
    const frame = registration.viewport ? registration.viewport() : {
      width: registration.scrollEl?.clientWidth, height: registration.scrollEl?.clientHeight,
      items: registration.virtualizer?.getVirtualItems() ?? [],
    };
    const items = frame?.items ?? [];
    if (frame?.ready === false || !Number.isFinite(frame?.width) || frame.width <= 0 ||
        !Number.isFinite(frame?.height) || frame.height <= 0 || !items.length) return;
    const ids = [];
    let previous = -1;
    for (const item of items) {
      const entry = Number.isInteger(item.index) ? st.images[known[item.index]] : null;
      if (!entry || item.key !== entry.id || item.index <= previous || !Number.isFinite(item.start) ||
          !Number.isFinite(item.end) || item.end <= item.start) return;
      previous = item.index;
      ids.push(entry.id);
    }
    const first = items[0].index, last = items[items.length - 1].index;
    const currentId = ce?.entry.id ?? null, position = currentId ? feedPositionOf(currentId) : null;
    const anchor = position != null && position >= first && position <= last ? position : Math.round((first + last) / 2);
    const anchorId = feedEntryAt(anchor)?.id;
    if (!anchorId) return;
    const contextChanged = !lastAcquisition || lastAcquisition.session !== s || lastAcquisition.registration !== registration ||
      lastAcquisition.revision !== browseRevision || lastAcquisition.currentId !== currentId || lastAcquisition.anchorId !== anchorId;
    const coverageChanged = contextChanged || lastAcquisition.width !== frame.width || lastAcquisition.height !== frame.height ||
      ids.length !== lastAcquisition.ids.length || ids.some((id, index) => id !== lastAcquisition.ids[index]);
    untrack(() => {
      if (contextChanged) window_.settle(anchor, first, last);
      else if (coverageChanged) window_.coverRange(first, last);
      if (pending) stageResolveAhead();
      wantRangeNow(); flushWant(s);
      lastAcquisition = { session: s, registration, revision: browseRevision, currentId, anchorId,
        width: frame.width, height: frame.height, ids };
    });
  });

  // --- status-stack helpers ------------------------------------------------------
  const chipTimers = { transient: 0 };
  let errSeq = 0;

  // --- keymap ------------------------------------------------------------------------
  // The registry itself is framework-free (client/js/keys.mjs); the version
  // signal fans mutations out to the keys panel.
  let inputPolicy;
  const handles = makeCommandHandles({ observe: (result) => inputPolicy?.observe(result) });
  const keymap = makeKeymap({
    describe: (id) => handles.get(id).description,
    request: (binding) => inputPolicy.request(binding),
  });
  const [keysVersion, setKeysVersion] = createSignal(0);
  const bumpKeys = () => setKeysVersion((v) => v + 1);

  // a running key capture is the TOP key layer: plain Escape cancels it
  // (the panel stays open); a modified Escape declines — that is a rebind
  // candidate, not a cancel
  createEffect(() => {
    if (!capturing()) return;
    const disposeLayer = actions.keys.pushLayer({
      id: "keys-capture",
      command: "keys.capture.cancel",
      decline: (e) => !!(e?.ctrlKey || e?.altKey || e?.shiftKey || e?.metaKey),
    });
    onCleanup(disposeLayer);
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
    pinned: !!c.pinned, autoRefresh: !!c.autoRefresh,
    capabilities: c.capabilities ?? null,
  }]));

  const sourceRecords = new Map();
  let registryRevision = 0, collectionRead = 0, activityStarted = false;

  function reconcileSources() {
    for (const [id, record] of sourceRecords) {
      if (st.hosts[id]?.address === record.address && st.hosts[id]) continue;
      clearTimeout(record.timer);
      record.freshness.retire();
      sourceRecords.delete(id);
      setSt("sourceActivity", id, undefined);
      setSt("sourceSaving", id, undefined);
    }
    for (const [id, source] of Object.entries(st.hosts)) {
      if (sourceRecords.has(id)) continue;
      const record = { id, address: source.address, writes: 0, revision: 0,
        writeTask: Promise.resolve(), task: null, timer: null, errors: 0, freshness: makeSourceFreshness() };
      sourceRecords.set(id, record);
      if (activityStarted && pollActivity) scheduleActivity(record, 0);
    }
  }

  async function refreshHosts() {
    const sequence = ++collectionRead, revision = registryRevision;
    const stamps = new Map([...sourceRecords].map(([id, r]) => [id, { record: r, revision: r.revision }]));
    const response = await api.collections();
    if (disposed || sequence !== collectionRead || revision !== registryRevision) return;
    const next = toHosts(response);
    for (const [id, source] of Object.entries(next)) {
      const record = sourceRecords.get(id), stamp = stamps.get(id);
      if (record && (record !== stamp?.record || record.revision !== stamp.revision || record.writes)) {
        source.pinned = st.hosts[id].pinned;
        source.autoRefresh = st.hosts[id].autoRefresh;
      }
    }
    setSt("hosts", reconcile(next));
    reconcileSources();
    drainRefresh(sourceSession);
  }

  function scheduleActivity(record, delay = 2000) {
    clearTimeout(record.timer);
    if (disposed || sourceRecords.get(record.id) !== record) return;
    record.timer = setTimeout(() => readActivity(record), delay);
  }

  function readActivity(record) {
    if (!record || disposed || sourceRecords.get(record.id) !== record) return Promise.resolve();
    if (record.task) return record.task;
    clearTimeout(record.timer);
    const revision = record.revision;
    record.task = (async () => {
      try {
        const snapshot = await api.activity(record.id);
        if (disposed || sourceRecords.get(record.id) !== record) return;
        record.errors = 0;
        if (revision === record.revision && !record.writes) {
          setSt("hosts", record.id, "pinned", !!snapshot.pinned);
          setSt("hosts", record.id, "autoRefresh", !!snapshot.autoRefresh);
        }
        setSt("sourceActivity", record.id, reconcile(snapshot));
        record.freshness.observe(snapshot);
        if (ownsSession(sourceSession) && sourceSession.source === record) drainRefresh(sourceSession);
      } catch (error) {
        if (disposed || sourceRecords.get(record.id) !== record) return;
        record.errors++;
        setSt("sourceActivity", record.id, { supported: true, state: "disconnected", progress: null, error: error.message });
      } finally {
        record.task = null;
        if (activityStarted && pollActivity) scheduleActivity(record, Math.min(2000 * 2 ** record.errors, 30000));
      }
    })();
    return record.task;
  }

  function dispose() {
    disposed = true;
    batch(retireFeedScroll);
    window_.clear();
    sizes_.dispose();
    clearTimeout(metaPollTimer);
    clearTimeout(sourceSession?.retryTimer);
    for (const record of sourceRecords.values()) { clearTimeout(record.timer); record.freshness.retire(); }
  }
  if (getOwner()) onCleanup(dispose);

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
      // Feature installation defines private operations/owner ports and semantic
      // commands before data bindings/affordances join the registry.
      register(f) {
        if (registeredFeatures.some((x) => x.name === f.name)) return;
        const installed = f.install?.({ state: stateObj, handles, setSt, reconcile });
        if (installed) {
          for (const command of installed.commands ?? []) handles.register(command);
          for (const command of installed.ownedCommands ?? []) handles.registerOwned(command);
          publicActions[f.name] = installed.ports;
        }
        for (const binding of f.bindings ?? []) actions.keys.register(binding);
        registeredFeatures.push(f);
      },
    },

    // boot-time data, loaded exactly once (the bootData.mjs contract).
    // api.hosts is deliberately not caught — a failed host list fails the
    // whole boot (the caller surfaces it).
    async boot() {
      await refreshHosts();
      activityStarted = true;
      if (pollActivity) for (const record of sourceRecords.values()) scheduleActivity(record, 0);
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
      const target = urlHost && st.hosts[urlHost] ? routeTarget(route) : { ...rememberedTarget(h), filter: route.filter ?? "" };
      if (h) await actions.hosts.select(h, { target, historyMode: "replace" });
      // a /diff URL boots into the workbench on the left side
      if (route.view === "diff") await actions.diff.openDiff(route.left, route.right);
    },

    hosts: {
      // Explicit URLs supply their complete target. UI source navigation
      // captures outgoing memory first, then restores the incoming pair.
      async select(name, { keepFile, target, historyMode = "push", force = false } = {}) {
        setHostMenuOpen(false);
        if (!force && !keepFile && !target && host() === name && ownsSession(sourceSession)) return sourceSession.loadTask;
        persistBrowse();
        target ??= keepFile ? routeTarget(parseUrl()) : rememberedTarget(name);
        if (!isFolderPath(target.folder ?? "") || (target.current != null && !isEntryName(st.hosts[name]?.kind, target.current))) {
          actions.status.error("Invalid browsing address"); return;
        }
        batch(() => {
          setSt("inventory", "loading", true);
          setHost(name);
          beginBrowse(target);
          assignCurrent(target.current ? { remote: name, image: target.current } : null, { persist: false, intent: false });
        });
        if (historyMode !== "none") mirrorCurrentHash(historyMode);
        api.setSettings("core.ui", { host: name }).catch(() => {});
        const task = loadImages(name);
        if (sourceSession?.id === name) sourceSession.loadTask = task;
        await task;
      },
      async add(name, addr) {
        name = (name ?? "").trim();
        addr = (addr ?? "").trim();
        if (!name || !addr) return { ok: false };
        try {
          await api.addCollection(name, addr);
          registryRevision++;
          await refreshHosts();
          return { ok: true };
        } catch {
          return { ok: false };
        }
      },
      async remove(name) {
        try {
          await api.removeCollection(name);
          registryRevision++;
          clearTimeout(sourceRecords.get(name)?.timer);
          sourceRecords.get(name)?.freshness.retire();
          sourceRecords.delete(name);
          setSt("hosts", name, undefined);
          setSt("sourceActivity", name, undefined);
          setSt("sourceSaving", name, undefined);
          await refreshHosts();
          if (host() === name) {
            await actions.hosts.select(Object.keys(st.hosts)[0] ?? null);
          }
        } catch { /* surfaced by the status chrome once it lands */ }
      },
      toggleMenu() { setHostMenuOpen(!hostMenuOpen()); },
      closeMenu() { setHostMenuOpen(false); },
      refresh: refreshHosts,
      pollActivity(id) { return readActivity(sourceRecords.get(id)); },
      patch(id, patch) {
        const record = sourceRecords.get(id);
        if (!record) return Promise.resolve({ ok: false });
        const savedPatch = { ...patch };
        record.revision++;
        record.writes++;
        setSt("sourceSaving", id, true);
        const task = record.writeTask.then(async () => {
          if (sourceRecords.get(id) !== record || disposed) return { ok: false };
          try {
            const actualPatch = savedPatch.toggle ? { [savedPatch.toggle]: !st.hosts[id][savedPatch.toggle] } : savedPatch;
            const saved = await api.patchCollection(id, actualPatch);
            if (sourceRecords.get(id) !== record || disposed) return { ok: false };
            batch(() => {
              setSt("hosts", id, "pinned", !!saved.pinned);
              setSt("hosts", id, "autoRefresh", !!saved.autoRefresh);
            });
            record.revision++;
            if (sourceSession?.source === record) drainRefresh(sourceSession);
            return { ok: true };
          } catch (error) {
            if (sourceRecords.get(id) === record && !disposed) actions.status.error(`source ${id} save failed: ${error.message}`);
            return { ok: false };
          } finally {
            record.writes--;
            if (sourceRecords.get(id) === record && !record.writes) setSt("sourceSaving", id, undefined);
          }
        });
        record.writeTask = task;
        return task;
      },
    },

    folders: {
      select(folder) {
        if (!isFolderPath(folder) || folder === selectedFolder() || !host()) return;
        if (st.hosts[host()]?.kind === "folder" && folder !== "") return;
        const c = current();
        const target = { folder, filter: filter(), current: c?.remote === host() ? c.image : undefined };
        if (sourceSession?.loading || !sourceSession?.inventoryReady) {
          if (target.current && !inFolder(target.current, folder)) target.current = undefined;
          batch(() => {
            beginBrowse(target);
            assignCurrent(target.current ? { remote: host(), image: target.current } : null, { persist: false, intent: false });
          });
        } else {
          let idx;
          batch(() => { beginBrowse(target); sourceSession.pendingBrowse = false; idx = applyBrowseTarget(target); });
          restoreBrowse(idx);
        }
        mirrorCurrentHash("push");
        wantRangeNow(); flushWant();
      },
    },

    images: {
      reload() { return actions.hosts.select(host(), { target: liveBrowseTarget(), force: true, historyMode: "replace" }); },
      delete(images) { return deleteImages(images); },
      // byte size isn't in every host's listing — a HEAD on the bytes route fills it
      async fillSize(id) {
        const s = sourceSession;
        const idx = imageIdx(id);
        if (idx < 0 || st.images[idx].size != null) return;
        const img = st.images[idx];
        const hash = img.hash;
        const size = await api.entrySizeProbe(img.host, img.filename);
        const resolved = imageIdx(id);
        if (ownsSession(s) && resolved >= 0 && st.images[resolved].hash === hash && size != null) setSt("images", resolved, "size", size);
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

    collections: {
      downloadFeedback(source) {
        return triggerDownload(`/api/collections/${encodeURIComponent(source)}/feedback.json`, `kosmozoo_${source}_feedback.json`);
      },
    },

    judgments: {
      dispatch: judgments.dispatch,
      setVote(id, vote) { return actions.judgments.dispatch(id, { type: "set", patch: { vote } }); },
      toggleFavorite(id) { return actions.judgments.dispatch(id, { type: "toggle", field: "favorite" }); },
      toggleBookmark(id) { return actions.judgments.dispatch(id, { type: "toggle", field: "bookmark" }); },
      saveNotes(id, notes) { return actions.judgments.dispatch(id, { type: "set", patch: { notes } }); },
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
        judgments.retain(id, key);
        setSt("drafts", key, text);
        clearTimeout(noteTimers[key]);
        noteTimers[key] = setTimeout(async () => {
          delete noteTimers[key];
          const result = await save?.(text, id);
          if (result?.ok && st.drafts[key] === text) actions.notes.clearDraft(id, cls);
        }, NOTE_SAVE_MS);
      },
      async flushDraft(id, cls, save) {
        const key = `${id}:${cls}`;
        const text = st.drafts[key];
        clearTimeout(noteTimers[key]);
        delete noteTimers[key];
        if (text === undefined) return;
        judgments.retain(id, key);
        const result = await save?.(text, id);
        if (result?.ok && st.drafts[key] === text) actions.notes.clearDraft(id, cls);
        return result;
      },
      clearDraft(id, cls) {
        const key = `${id}:${cls}`;
        clearTimeout(noteTimers[key]);
        delete noteTimers[key];
        setSt("drafts", key, undefined);
        judgments.release(id, key);
      },
    },

    ui: {
      setFilter(v) {
        if (v === filter()) return;
        batch(() => {
          retireFeedScroll();
          browseRevision++;
          setAcquisitionRevision((v) => v + 1);
          setBrowseRestore(null);
          browseTarget = { ...browseTarget, filter: v };
          setFilter(v);
        });
        mirrorCurrentHash();
      },
      setResizing(v) { setResizing(!!v); },
      toggleMenu() { setMenuOpen(!menuOpen()); },
      closeMenu() { setMenuOpen(false); },
      async refresh() {
        const s = sourceSession;
        try {
          await refreshHosts();
          if (ownsSession(s)) await requestRefresh(s);
        } catch (error) { if (ownsSession(s)) actions.status.error(`couldn't refresh sources: ${error.message}`); }
      },
      setWorkspace(space) {
        if (workspace() === space) return;
        setWorkspaceSig(space);
        try { localStorage.setItem("kosmozoo.workspace.v1", space); } catch { /* private mode */ }
      },
      setInfoLayout(mode) {
        if (!(mode === "split" || mode === "rev" || mode === "stacked" || mode === "stacked-rev") || infoLayout() === mode) return;
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
        batch(() => { retireFeedScroll(); assignCurrent({ remote, image }); });
        mirrorCurrentHash();
      },
      linkUrl(remote, image) {
        const folder = remote === host() && inFolder(image, selectedFolder()) ? selectedFolder() : "";
        return feedUrl(remote, image, { folder, filter: "", search: typeof location === "undefined" ? "" : location.search ?? "" });
      },
      async navigate(remote, image) {
        if (!st.hosts[remote] || !isEntryName(st.hosts[remote]?.kind, image)) { actions.status.error("Image source or address is unavailable"); return false; }
        const url = actions.current.linkUrl(remote, image);
        const previous = (location.pathname ?? "/") + (location.search ?? "") + (location.hash ?? "");
        if (previous === url) return true;
        persistBrowse();
        history.pushState({ kzBrowse: 1 }, "", url);
        await actions.route.changed();
        return true;
      },
      assign(next, options) { batch(() => { retireFeedScroll(); assignCurrent(next, options); }); },
      pop() { return batch(() => { retireFeedScroll(); return popCurrent(); }); },
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
        const id = feedTargetEntryId(items, viewportTop, clientHeight);
        const entry = id == null ? null : st.images[imageIdxById().get(id)];
        if (!entry || entry.filename === current()?.image) return;
        assignCurrent({ remote: host(), image: entry.filename });
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
        batch(() => { retireFeedScroll(); setSt("diff", "open", true); });
        return true;
      },
      hide() { batch(() => { retireFeedScroll(); setSt("diff", "open", false); }); },
      // --- comparator session state (all session-only) -------------------------
      setMode(mode) {
        if (mode === "two-up" || mode === "one-up" || mode === "split" || mode === "difference") {
          setSt("diff", "mode", mode);
        }
      },
      setCol(col) { if (col === "feed" || col === "right") setSt("diff", "col", col); },
      setLocked(x) { setSt("diff", "locked", !!x); },
      setSplit(t) { setSt("diff", "splitT", Math.min(1, Math.max(0, t))); },
      setActiveOpacity(x) { setSt("diff", "activeOpacity", Math.min(1, Math.max(0, x))); },
      setDiffAbs(x) { setSt("diff", "diffAbs", !!x); },
      setDiffOpacity(x) { setSt("diff", "diffOpacity", Math.min(1, Math.max(0, x))); },
      setDiffThreshold(x) { setSt("diff", "diffThreshold", Math.min(255, Math.max(0, Math.round(x)))); },
      // step the active column: the feed column walks the feed view list,
      // the right column walks its pane (anchors, or the current graph's
      // node images)
      step(dir) {
        if (st.diff.col === "feed") {
          const v = view();
          const idx = findByFile(current()?.image);
          const next = idx >= 0 ? v[v.indexOf(idx) + dir] : null;
          if (next == null) return;
          batch(() => { retireFeedScroll(); assignCurrent({ remote: host(), image: st.images[next].filename }); });
          mirrorCurrentHash();
          return;
        }
        batch(retireFeedScroll);
        if (workspace() === "anchors") {
          const names = st.anchors.map((a) => a.name);
          const i = names.indexOf(st.diff.anchorName ?? names[0]);
          if (names[i + dir] != null) setSt("diff", "anchorName", names[i + dir]);
          return;
        }
        const imgs = currentNodeImages();
        const i = imgs.findIndex((im) => im.file === (st.diff.infoFile ?? imgs[0]?.file));
        const n = imgs[i + dir];
        if (n) { setSt("diff", "infoFile", n.file); setSt("diff", "infoSource", null); }
      },
      close() {
        if (!st.diff.open) return;
        const c = current();
        batch(() => { retireFeedScroll(); setSt("diff", "open", false); });
        if (location.pathname === "/diff") {
          // opened from a /diff URL: land back on the feed
          if (history.state?.kz) {
            history.back(); // a pushed entry: popstate lands on the feed URL
          } else {
            const feed = feedUrl(host(), c?.remote === host() ? c.image : null,
              { folder: selectedFolder(), filter: filter(), search: location.search ?? "" });
            history.replaceState(null, "", feed);
            window.dispatchEvent(new PopStateEvent("popstate"));
          }
        } else if (c && c.remote !== "anchor" && c.remote === host()) {
          // opened from the feed: re-center it on the current image
          const idx = findByFile(c.image);
          if (idx >= 0) restoreToIndex(idx);
        }
      },
      // first item of the active pane becomes the right current when none
      // is set yet — the right position is remembered session-wide after that
      ensureRightDefault() {
        if (workspace() === "anchors") {
          if (!st.diff.anchorName && st.anchors.length) setSt("diff", "anchorName", st.anchors[0].name);
        } else {
          const imgs = currentNodeImages();
          if (!st.diff.infoFile && imgs.length) setSt("diff", "infoFile", imgs[0].file);
        }
      },
      // feed card click: the current image is that candidate; the pair is
      // feed × (first item of the right pane when unset)
      openFromFeed(imgIdx) {
        const im = st.images[imgIdx];
        if (!im) return;
        batch(() => { retireFeedScroll(); assignCurrent({ remote: im.host, image: im.filename }); });
        mirrorCurrentHash();
        actions.diff.ensureRightDefault();
        actions.diff.open();
      },
      // discovered image click: that node image becomes the right side (B) —
      // the feed current stays; the pair is the generated image × its source
      openInput(h, file, fromOutput = false) {
        if (!h || !file) return;
        setSt("diff", "infoFile", file);
        setSt("diff", "infoSource", null); // pane-picked: derived from nodeImages
        actions.diff.open();
      },
      // anchor thumb click: that anchor becomes the right side (B) — the
      // feed current stays; the pair is feed current × that anchor
      openFromAnchor(anchorIdx) {
        const anchor = st.anchors[anchorIdx];
        if (!anchor) return;
        setSt("diff", "anchorName", anchor.name);
        actions.diff.open();
      },
      // /diff deep links: both sides apply — left sets the feed current,
      // right sets the right current by source (anchor → the anchors pane;
      // anything else → the details pane, with its source kept for
      // resolution). A push entry keeps the /diff URL so browser
      // back/forward close/re-open via the route.
      openDiff(left, right, { push } = {}) {
        if (!left || !resolveSide(left)) return false;
        const remote = left.source ?? left.remote, image = left.file ?? left.image;
        if (st.hosts[remote] && remote !== host()) {
          const context = typeof location === "undefined" ? { folder: "", filter: "" } : parseUrl();
          const loading = actions.hosts.select(remote, { target: { folder: context.folder ?? "", filter: context.filter ?? "", current: image, explicit: true }, historyMode: "none" });
          const intent = browseRevision;
          return loading.then(() => intent === browseRevision && host() === remote ? actions.diff.openDiff(left, right, { push }) : false);
        }
        batch(() => {
        retireFeedScroll();
        // the reset must not fire on THIS establishing pointer move
        setSt("diff", "pairedWith", `${remote}:${image}`);
        assignCurrent({ remote, image });
        if (right) {
          const src = right.source ?? right.remote;
          const file = right.file ?? right.image;
          if (src === "anchor") {
            setSt("diff", "anchorName", file);
            actions.ui.setWorkspace("anchors");
          } else {
            setSt("diff", "infoFile", file);
            setSt("diff", "infoSource", src);
            actions.ui.setWorkspace("details");
          }
        }
        setSt("diff", "open", true);
        });
        if (push && right) history.pushState({ kz: 1 }, "", diffUrl(left, right,
          { folder: selectedFolder(), filter: filter(), search: location.search ?? "" }));
        else mirrorCurrentHash();
        return true;
      },
    },

    feed: {
      register(seamsIn) {
        const registration = seamsIn ? { ...seamsIn } : null;
        batch(() => {
          if (seams.virtualizer !== (seamsIn?.virtualizer ?? null) || feedScrollEl() !== (seamsIn?.scrollEl ?? null)) retireFeedScroll();
          seams.virtualizer = seamsIn?.virtualizer ?? null;
          setFeedScrollEl(seamsIn?.scrollEl ?? null);
          setFeedVirtualizer(seamsIn?.virtualizer ?? null);
          setFeedRegistration(registration);
        });
        return () => {
          if (feedRegistration() !== registration) return;
          batch(() => {
            retireFeedScroll(); seams.virtualizer = null;
            setFeedRegistration(null); setFeedScrollEl(null); setFeedVirtualizer(null);
          });
        };
      },
      restoreToIndex,
      // a programmatic scroll must not invite the snap — compensation and
      // restores call this so the next settle does not re-tidy
      quiet: quietScrolls,
      // a COMPENSATION scroll (landing/merge): snap-quiet AND the settle
      // must not reassign current — it exists to preserve position
      compensating() { quietScrolls(); setSuppressSettleCurrent(true); },
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
        const remote = r.view === "diff" ? r.left?.source : r.host;
        if (remote && !st.hosts[remote] && !remote.startsWith("input:") && remote !== "anchor") return;
        const name = st.hosts[remote] ? remote : host();
        if (!name || !isFolderPath(r.folder ?? "")) return;
        const target = routeTarget(r);
        if (target.current != null && !isEntryName(st.hosts[name]?.kind, target.current)) return;
        let intent;
        if (name !== host() || !ownsSession(sourceSession)) {
          const loading = actions.hosts.select(name, { target, historyMode: "none" });
          intent = browseRevision;
          await loading;
        } else {
          const s = sourceSession;
          if (s.loading) {
            batch(() => {
              beginBrowse(target);
              assignCurrent(target.current ? { remote: name, image: target.current } : null, { persist: false, intent: false });
            });
            intent = browseRevision;
            await s.loadTask;
          } else if (target.current && findByFile(target.current) < 0) {
            batch(() => {
              setSt("inventory", "loading", true);
              s.pendingBrowse = true;
              beginBrowse(target);
              assignCurrent({ remote: name, image: target.current }, { persist: false, intent: false });
            });
            intent = browseRevision;
            await requestRefresh(s);
          } else {
            let idx;
            batch(() => { beginBrowse(target); s.pendingBrowse = false; idx = applyBrowseTarget(target); });
            intent = browseRevision;
            restoreBrowse(idx);
          }
        }
        if (intent !== browseRevision || host() !== name) return;
        if (r.view === "diff") await actions.diff.openDiff(r.left, r.right);
        else {
          if (st.diff.open) setSt("diff", "open", false);
          mirrorCurrentHash();
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
      register(binding, ...legacy) {
        keymap.bind(binding, ...legacy);
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
      cancelCapture() { setCapturing(null); },
      // key layers: open modals push themselves; Escape goes to the top one
      pushLayer(layer) {
        if (typeof layer.command !== "string" || layer.onEscape) throw new TypeError("Layer requires a command reference");
        handles.get(layer.command);
        const registration = { ...layer };
        setKeyLayers((ls) => [...ls.filter((l) => l.id !== layer.id), registration]);
        return () => setKeyLayers((ls) => ls.filter((l) => l !== registration));
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
      dispatch(e, phase) { return inputPolicy.dispatch(e, keymap, phase); },
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
        const ids = actions.bulk.images().map((img) => img.id);
        const results = await Promise.all(ids.map((id) => actions.judgments.setVote(id, vote)));
        const count = results.filter((result) => result.ok).length;
        if (count) actions.status.info(`${count} image${count > 1 ? "s" : ""} ${vote === "up" ? "up-voted" : "down-voted"}`);
        return results;
      },
      async favorite() {
        const ids = actions.bulk.images().map((img) => img.id);
        const results = await Promise.all(ids.map((id) => actions.judgments.dispatch(id, { type: "set", patch: { favorite: true } })));
        const count = results.filter((result) => result.ok).length;
        if (count) actions.status.info(`${count} image${count > 1 ? "s" : ""} favorited`);
        return results;
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
        await refreshHosts(); // capabilities.delete depends on the toggle
      },
    },
  };

  const stateObj = {
    // trees — getters keep reads subscribed to the live store paths
    featureCardActions: (image) => registeredFeatures.flatMap((f) =>
      (f.cardAction ? [{ ...f.cardAction, args: { ...f.cardAction.args, id: image.id } }] : [])),
    featureBulkActions: () => registeredFeatures.flatMap((f) =>
      (f.bulkAction ? [{ ...f.bulkAction, args: { ...f.bulkAction.args, target: "selected" } }] : [])),
    get hosts() { return st.hosts; },
    get sourceActivity() { return st.sourceActivity; },
    get sourceSaving() { return st.sourceSaving; },
    get nodesRegistry() { return st.nodesRegistry; },
    get scraper() { return st.scraper; },
    get deletePrefs() { return st.deletePrefs; },
    get ui() { return st.ui; },
    get judgmentPrefs() { return st.judgmentPrefs; },
    resizing,
    downloadName,
    referenceName: (image) => `${image.host}#${image.filename}`,
    get images() { return st.images; },
    get inventory() { return st.inventory; },
    selectedFolder,
    folderView,
    folderOptions() {
      const choices = st.inventory.folders;
      return choices.includes(selectedFolder()) ? choices : [...choices, selectedFolder()].sort();
    },
    get selected() { return st.selected; },
    get anchors() { return st.anchors; },
    get diff() { return st.diff; },
    diffPair,
    get variations() { return st.variations; },
    get infoOverlay() { return st.infoOverlay; },
    get chips() { return st.chips; },
    get metaPending() { return st.metaPending; },
    get drafts() { return st.drafts; },
    cardState(id, { current: override, surface = "card" } = {}) {
      const img = st.images[imageIdxById().get(id)];
      return cardState(img?.judgment, !!img && (override ?? currentEntry()?.entry.id === id), { surface });
    },
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
    feedMergeNonce,
    feedVirtualizer,
    feedActivity,
    feedMarkerEntryId,
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

  sourceBrowse = makeSourceBrowse({ storage, onError: (message) => actions.status.error(message),
    validCurrent: (address, name) => isEntryName(Object.values(st.hosts).find((source) => source.address === address)?.kind, name) });
  registerCoreCommands(handles, { ops: actions, state: stateObj });
  const publicActions = commandFacades(handles, actions, stateObj);
  inputPolicy = makeInputPolicy({ handles, state: stateObj, layers: keyLayers,
    captureEvent: actions.keys.captureEvent, onError: (error) => actions.status.error(`input failed: ${error?.message ?? error}`) });
  return { state: stateObj, actions: publicActions, handles, ui: uiStateObj, dispose };
}

export const AppStoreContext = createContext(null);

export function useAppStore() {
  return useContext(AppStoreContext);
}
