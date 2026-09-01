// client-solid/store/app-store.tsx — the single global store (plan §3.2).
//
// One makeAppStore() created at boot, provided via context at the app root.
// Views read store.state.* and call store.actions.* — nothing else. The store
// owns the model: api.mjs is a store-internal dependency; views never fetch.
//
// Reactivity shape: createStore for tree structures (hosts, images with
// meta/judgments, settings mirrors) — path-level updates touch only
// dependents of that path; createSignal for scalar atoms (host, current,
// currentStack, filter, menu flags, confirmDelete).
// Note: the store ROOT is not assignable (st.x = v is silently ignored) —
// root-level replacement goes through setSt("x", v); nested paths assign.

import { createSignal, createMemo, createContext, useContext } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { api } from "/js/api.mjs";
import { metaFromPngBytes } from "/shared/extractor.mjs";
import { initViews } from "/js/views.mjs";
import { makeKeymap, comboFromEvent } from "/js/keys.mjs";
import {
  parseUrl,
  stripHostPrefix,
  matchesFile,
  planDeleteCurrent,
  diffUrl,
} from "/js/route-parse.mjs";
import { fieldList, fieldsCfgFrom } from "./fields.js";
import { makeImageWindow } from "./image-window.js";
import { suppressScrollSnap, snapQuiet } from "./scroll-snap.js";

// stored host if still present, else first online, else first
function initialHost(hosts, stored) {
  if (stored && hosts[stored]) return stored;
  const names = Object.keys(hosts);
  return names.find((n) => hosts[n].online) ?? names[0] ?? null;
}

export function makeAppStore() {
  // tree structures — path-level updates
    const [st, setSt] = createStore({
    hosts: {},            // name -> { address, online, deleteMode }
    nodesRegistry: {},    // discovered node types (/api/nodes)
    fieldsStored: null,   // raw core.fields cfg — fieldsCfg derives below
    scraper: null,        // { enabled, paused, pending: {host: n} }
    feedbackPath: null,   // where judgments live (engine-side)
    deletePrefs: { useAssetsPlus: true },
    ui: {},               // core.ui settings (stored host, ...)
    judgmentPrefs: { downvoteHides: true, revealThumbedDown: false, hideUp: false },
    images: [],           // [{ id, host, filename, size, meta, judgment }]
    selected: {},         // id -> true (bulk actions; session-only)
    saved: {},            // filename -> true (downloads-dir mirror for save buttons)
    anchors: [],          // [{ name, src(dataURL), meta? }] — local drops, persisted
    diff: { open: false },                  // workbench: single-image viewer
    variations: { open: false, images: [], key: null }, // modal session
    infoOverlay: { open: false, name: "", meta: null }, // anchor ⓘ params
    chips: [],            // status stack: { slot, kind, msg }
    metaPending: 0,
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
  const [keysFilter, setKeysFilter] = createSignal("");
  const [menuFilter, setMenuFilter] = createSignal("");
  const [fieldsOverlayOpen, setFieldsOverlayOpen] = createSignal(false);
  const [anchorPaneWidth, setAnchorPaneWidth] = createSignal(300); // px, divider-adjusted, persisted
  const [infoSplit, setInfoSplit] = createSignal(0.66); // info panel: images/nodes split, divider-adjusted, persisted

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

  // --- fields derivation (registry + stored cfg) ------------------------------
  const fieldsList = createMemo(() => fieldList(st.nodesRegistry));
  const fieldsCfg = createMemo(() => fieldsCfgFrom(fieldsList(), st.fieldsStored));

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
    return st.images.findIndex((i) => matchesFile(i, host(), file));
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
        src: `/api/input-bytes/${encodeURIComponent(h)}/${encodeURIComponent(file)}`,
        meta: null,
      };
    }
    if (st.hosts[source]) {
      return {
        name: file,
        host: source,
        src: api.imageBytesUrl(`${source}:${file}`),
        meta: null,
      };
    }
    return null;
  }

  // --- feed seams (the Grid registers its handles here) -------------------------
  const seams = { virtualizer: null };
  let scrollGuardPending = false;

  function restoreToIndex(idx) {
    if (idx < 0) return;
    const viewPos = view().indexOf(idx);
    if (viewPos < 0) return;
    seams.virtualizer?.scrollToIndex(viewPos, { align: "center" });
    // a programmatic center, not user scrolling — keep the snap from
    // immediately pulling the centered card back to the top edge
    suppressScrollSnap();
    wantRangeNow();
  }

  // scroll-distance safety net (retained shape): near the bottom guard, nudge
  // a scrollToOffset so the virtualizer re-checks its range. Never fires
  // while a programmatic scroll is in flight — it would pin a smooth scroll
  // passing through the near-bottom zone.
  function safetyNet() {
    if (scrollGuardPending || snapQuiet()) return;
    scrollGuardPending = true;
    setTimeout(() => {
      scrollGuardPending = false;
      const col = document.getElementById("candidatesCol");
      if (!col) return;
      if (seams.virtualizer && col.scrollHeight - (col.scrollTop + col.clientHeight) < col.clientHeight * 1.5) {
        seams.virtualizer.scrollToOffset(col.scrollTop, { align: "start" });
      }
    }, 120);
  }

  // --- metadata channel: want + poll + patch in place ---------------------------
  let metaVersion = 0;
  const wantSet = new Set();
  let wantTimer = null;
  let metaPollTimer = null;

  function wantMeta(image) {
    if (image.meta || wantSet.has(image.filename)) return;
    wantSet.add(image.filename);
    clearTimeout(wantTimer);
    wantTimer = setTimeout(flushWant, 1500);
  }

  async function flushWant() {
    if (!host()) return;
    const files = [...wantSet];
    wantSet.clear();
    if (!files.length) return;
    try {
      const r = await api.metaWant(host(), files);
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
      const r = await api.metadata(host());
      setSt("metaPending", r.pending ?? 0);
      if (r.v !== metaVersion) {
        metaVersion = r.v;
        for (const [name, meta] of Object.entries(r.items ?? {})) {
          const idx = st.images.findIndex((i) => i.filename === name);
          if (idx < 0 || st.images[idx].meta) continue;
          setSt("images", idx, "meta", meta);
        }
        // the node registry grows as the engine extracts — refresh it
        // alongside so newly discovered node types materialize without a
        // reload (a fresh engine boots with an empty registry)
        api.nodes().then((reg) => setSt("nodesRegistry", reg)).catch(() => {});
      }
    } catch { /* transient; next poll retries */ }
    if (st.metaPending > 0) scheduleMetaPoll();
  }

  // meta-want: the window's worth of images, swept on (re)load/restore
  function wantRangeNow() {
    const v = view();
    for (let i = 0; i < Math.min(20, v.length); i++) {
      const image = st.images[v[i]];
      if (image) wantMeta(image);
    }
  }

  // --- image list load -----------------------------------------------------------
  async function loadImages(name) {
    // a host switch must not leave the previous host's feed on screen
    setSt("images", reconcile([]));
    setSt("selected", reconcile({}));
    if (!name) return;
    actions.status.active("load", `loading image list from ${name}…`);
    try {
      setSt("images", reconcile(await api.images(name)));
      try {
        // Ask about both raw and host-prefixed filenames — new saves land
        // as `<host>#<filename>` but legacy saves may still be raw.
        const q = new Set();
        for (const img of st.images) {
          q.add(img.filename);
          const pfx = img.host + "#";
          if (!img.filename.startsWith(pfx)) q.add(pfx + img.filename);
        }
        const d = await api.downloadsCheck([...q]);
        const saved = {};
        for (const [k, v] of Object.entries(d.exists ?? {})) if (v) saved[k] = true;
        setSt("saved", reconcile(saved));
      } catch { /* save buttons just won't pre-grey */ }
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
    // the workbench may be sitting on one of these images (phase 4 wires diff)
    if (st.diff.open) {
      const sideMatches = (side, img) => !!side && side.source === img.host &&
        (side.file === img.filename || side.file === img.host + "#" + img.filename);
      if (images.some((i) => sideMatches(st.diff.left, i) || sideMatches(st.diff.right, i))) {
        setSt("diff", "open", false);
      }
    }
    const results = await Promise.allSettled(images.map((img) => api.deleteImage(img.id)));
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

  const imageIdx = (id) => st.images.findIndex((i) => i.id === id);

  // the image-src window (visible ∪ workbench ± pad)
  const window_ = makeImageWindow({ state: { get images() { return st.images; }, get diff() { return st.diff; }, host } });

  // --- status-stack helpers ------------------------------------------------------
  const chipTimers = { transient: 0 };
  let errSeq = 0;

  // --- keymap ------------------------------------------------------------------------
  // The registry itself is framework-free (client/js/keys.mjs); the version
  // signal fans mutations out to the keys panel.
  const keymap = makeKeymap();
  const [keysVersion, setKeysVersion] = createSignal(0);
  const bumpKeys = () => setKeysVersion((v) => v + 1);

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

  const actions = {
    // boot-time data, loaded exactly once (the bootData.mjs contract).
    // api.hosts() is deliberately not caught — a failed host list fails the
    // whole boot (the caller surfaces it).
    async boot() {
      setSt("hosts", reconcile(await api.hosts()));
      setSt("ui", await api.settings("core.ui").catch(() => ({})));
      setSt("nodesRegistry", await api.nodes().catch(() => ({})));
      setSt("fieldsStored", (await api.settings("core.fields").catch(() => ({})))?.cfg ?? null);
      const del = await api.settings("core.delete").catch(() => ({}));
      setSt("deletePrefs", { useAssetsPlus: del.useAssetsPlus ?? true });
      const jns = await api.settings("core.judgment").catch(() => ({}));
      setSt("judgmentPrefs", "downvoteHides", jns.downvoteHides ?? true);
      setSt("scraper", reconcile(await api.scraper().catch(() => null)));
      setSt("feedbackPath", (await api.settings("core").catch(() => ({})))?.feedbackPath ?? null);
      actions.anchors.load();
      await actions.keys.loadSaved();
      await actions.anchors.loadPaneWidth();
      // persisted per-image zoom views (feed zoom carries across reloads)
      await initViews().catch(() => {});
      // scraper status poll (the menu row reads it; the counter derives)
      setInterval(async () => {
        setSt("scraper", reconcile(await api.scraper().catch(() => st.scraper)));
      }, 2000);
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
          await api.addHost(name, addr);
          setSt("hosts", reconcile(await api.hosts()));
          return { ok: true };
        } catch {
          return { ok: false };
        }
      },
      async remove(name) {
        try {
          await api.removeHost(name);
          setSt("hosts", reconcile(await api.hosts()));
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
        try {
          const r = await fetch(api.imageBytesUrl(id), { method: "HEAD" });
          const cl = r.headers.get("content-length");
          if (r.ok && cl) setSt("images", idx, "size", Number(cl));
        } catch { /* no size then */ }
      },
      // download via a transient anchor; optimistic saved mark, refreshed from
      // disk on the next load
      download(id) {
        const idx = imageIdx(id);
        if (idx < 0) return;
        const img = st.images[idx];
        const pfx = img.host + "#";
        const name = img.filename.startsWith(pfx) ? img.filename : pfx + img.filename;
        const a = document.createElement("a");
        a.href = api.imageBytesUrl(id);
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setSt("saved", name, true);
      },
    },

    judgments: {
      // vote: 'up' | 'down' | null — path-level update; the view memo and
      // the card's data attrs follow by construction
      async setVote(image, vote) {
        await api.setJudgment(image.id, { vote });
        const idx = imageIdx(image.id);
        if (idx < 0) return;
        // the engine lists images with judgment: null — the path set needs an
        // object to traverse into
        if (!st.images[idx].judgment) setSt("images", idx, "judgment", {});
        setSt("images", idx, "judgment", "vote", vote === null ? undefined : vote);
      },
      async toggleFavorite(image) {
        const next = !(image.judgment?.favorite);
        await api.setJudgment(image.id, { favorite: next || null });
        const idx = imageIdx(image.id);
        if (idx < 0) return;
        if (!st.images[idx].judgment) setSt("images", idx, "judgment", {});
        setSt("images", idx, "judgment", "favorite", next ? true : undefined);
      },
      async saveNotes(image, notes) {
        await api.setJudgment(image.id, { notes }).catch(() => {});
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

    ui: {
      setFilter(v) { setFilter(v); }, // the view memo consumes it
      toggleMenu() { setMenuOpen(!menuOpen()); },
      closeMenu() { setMenuOpen(false); },
      async refresh() {
        setSt("hosts", reconcile(await api.hosts()));
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
            const r = Math.max(0, Math.min(1, ratio));
            if (infoSplit() === r) return;
            setInfoSplit(r);
            // TODO: handle persistence failure (optimistic UI, TODO comment per design)
            api.setSettings("core.ui", { infoSplit: r }).catch(() => {});
          },
        },
      },
      // the panel itself lands in phase 6; the flag is live already
      toggleKeysPanel() { setKeysPanelOpen(!keysPanelOpen()); },
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
      // by the caller — a fast scroll must not spend a render per frame)
      settleFromScroll(col) {
        if (st.diff.open) return;
        const mid = col.getBoundingClientRect().top + col.clientHeight / 2;
        let file = null;
        for (const el of col.querySelectorAll(".card[data-idx]")) {
          if (el.getBoundingClientRect().top > mid) break;
          const im = st.images[Number(el.dataset.idx)];
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

    variations: {
      // wand toggle: re-clicking the same image's wand closes the modal
      open(image) {
        const key = image?.id ?? null;
        if (st.variations.open && st.variations.key === key) {
          actions.variations.close();
          return;
        }
        setSt("variations", reconcile({ open: true, images: [image], key }));
      },
      // bulk bar's wand: RELATIVE sweeps applied to every selected image
      // around its own current value — even for a single image, since
      // that's the batch affordance
      openBulk(images) {
        const key = "batch:" + images.map((i) => i.id).join("|");
        if (st.variations.open && st.variations.key === key) {
          actions.variations.close();
          return;
        }
        setSt("variations", reconcile({ open: true, images, key }));
      },
      close() { setSt("variations", reconcile({ open: false, images: [], key: null })); },
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
      register(seamsIn) { seams.virtualizer = seamsIn?.virtualizer ?? null; },
      restoreToIndex,
      safetyNet,
      wantRangeNow,
      retryImage(idx) { window_.retry(idx); },
      // floating button: back to the top of the feed
      scrollTop() {
        const col = document.getElementById("candidatesCol");
        if (!col) return;
        suppressScrollSnap();
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
      // the capture hook: a pressed key rebinds the capturing action.
      // Plain Escape cancels the capture.
      captureEvent(e) {
        const id = capturing();
        if (!id) return;
        if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
          setCapturing(null);
          return;
        }
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
      // dispatch a keydown through the bindings (first match wins, in
      // registration order — the panel registers before the workbench so
      // its Escape outranks wb.close)
      dispatch(e) {
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

    // --- fields picker overlay ---------------------------------------------------
    fieldsOverlay: {
      open() { setFieldsOverlayOpen(true); },
      close() { setFieldsOverlayOpen(false); },
      // a per-field card/strip toggle: applied to the stored cfg (the cfg
      // memo derives from it, so cards refresh by construction), persisted
      setField(id, col, on) {
        const merged = { ...(st.fieldsStored ?? {}) };
        merged[id] = { card: false, strip: false, ...merged[id], [col]: on };
        setSt("fieldsStored", merged);
        api.setSettings("core.fields", { cfg: merged }).catch(() => {});
      },
      setGroup(ids, col, on) {
        const merged = { ...(st.fieldsStored ?? {}) };
        for (const id of ids) {
          merged[id] = { card: false, strip: false, ...merged[id], [col]: on };
        }
        setSt("fieldsStored", merged);
        api.setSettings("core.fields", { cfg: merged }).catch(() => {});
      },
    },

    // --- anchors: local reference images, persisted as data URLs ----------------
    anchors: {
      load() {
        try {
          const list = (JSON.parse(localStorage.getItem("kosmozoo.anchors.v1")) || [])
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
      // drag reorder: move the dragged anchor before/after the hovered one
      reorder(draggedName, overName, before) {
        if (!draggedName || draggedName === overName) return;
        const arr = [...st.anchors];
        const from = arr.findIndex((a) => a.name === draggedName);
        if (from < 0 || arr.findIndex((a) => a.name === overName) < 0) return;
        const [item] = arr.splice(from, 1);
        const to = arr.findIndex((a) => a.name === overName);
        arr.splice(before ? to : to + 1, 0, item);
        setSt("anchors", reconcile(arr));
        persistAnchors();
      },
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
          api.setJudgment(img.id, { vote }).then(() => {
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
          api.setJudgment(img.id, { favorite: true }).then(() => {
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
          const a = document.createElement("a");
          a.href = api.imageBytesUrl(img.id);
          a.download = img.filename.startsWith(img.host + "#") ? img.filename : img.host + "#" + img.filename;
          document.body.appendChild(a);
          a.click();
          a.remove();
        }
        actions.status.info(`saving ${images.length} image${images.length > 1 ? "s" : ""}`);
      },
    },

    // --- menu / settings rows -----------------------------------------------------
    menu: {
      setFilter(v) { setMenuFilter(v); },
      async scraperToggle(on) {
        await api.setScraper({ enabled: on });
        setSt("scraper", reconcile(await api.scraper().catch(() => st.scraper)));
      },
      async scraperPause() {
        await api.setScraper({ paused: !st.scraper?.paused });
        setSt("scraper", reconcile(await api.scraper().catch(() => st.scraper)));
      },
      async deleteAssetsPlus(on) {
        await api.setSettings("core.delete", { useAssetsPlus: on }).catch(() => {});
        setSt("deletePrefs", { ...st.deletePrefs, useAssetsPlus: on });
        setSt("hosts", reconcile(await api.hosts())); // deleteMode depends on the toggle
      },
      async applyFeedbackPath(path) {
        try {
          const r = await api.feedbackPath(path);
          setSt("feedbackPath", r.feedbackPath);
          actions.status.info(`feedback path → ${r.feedbackPath}`);
          if (host()) await loadImages(host());
        } catch (err) {
          actions.status.error(`feedback path failed: ${err.message}`);
        }
      },
    },
  };

  const stateObj = {
    // trees — getters keep reads subscribed to the live store paths
    get hosts() { return st.hosts; },
    get nodesRegistry() { return st.nodesRegistry; },
    get fieldsStored() { return st.fieldsStored; },
    get scraper() { return st.scraper; },
    get feedbackPath() { return st.feedbackPath; },
    get deletePrefs() { return st.deletePrefs; },
    get ui() { return st.ui; },
    get judgmentPrefs() { return st.judgmentPrefs; },
    get images() { return st.images; },
    get selected() { return st.selected; },
    get saved() { return st.saved; },
    get anchors() { return st.anchors; },
    get diff() { return st.diff; },
    get variations() { return st.variations; },
    get infoOverlay() { return st.infoOverlay; },
    get chips() { return st.chips; },
    get metaPending() { return st.metaPending; },
    // derived
    view,
    fieldsList,
    fieldsCfg,
    // the image-src window (a capability, not data)
    window: window_,
    // scalar atoms
    host,
    current,
    currentStack,
    filter,
    hostMenuOpen,
    menuOpen,
    menuFilter,
    keysFilter,
    capturing,
    // the keymap's action list, fanned out by the version signal
    bindings: () => { keysVersion(); return keymap.list(); },
    fieldsOverlayOpen,
    anchorPaneWidth,
    confirmDelete,
    keysPanelOpen,
    workspace,
    infoLayout,
    infoSplit,
  };

  return { state: stateObj, actions };
}

export const AppStoreContext = createContext(null);

export function useAppStore() {
  return useContext(AppStoreContext);
}
