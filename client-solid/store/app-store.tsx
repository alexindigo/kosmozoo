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
import { createStore } from "solid-js/store";
import { api } from "/js/api.mjs";
import {
  parseUrl,
  stripHostPrefix,
  matchesFile,
  planDeleteCurrent,
} from "/js/route-parse.mjs";
import { fieldList, fieldsCfgFrom } from "./fields.js";
import { makeImageWindow } from "./image-window.js";

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
    diff: { open: false },                  // workbench — phase 4 expands it
    variations: { open: false, image: null }, // modal — phase 5 expands it
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

  // --- feed seams (the Grid registers its handles here) -------------------------
  const seams = { virtualizer: null };
  let scrollGuardPending = false;

  function restoreToIndex(idx) {
    if (idx < 0) return;
    const viewPos = view().indexOf(idx);
    if (viewPos < 0) return;
    seams.virtualizer?.scrollToIndex(viewPos, { align: "center" });
    wantRangeNow();
  }

  // scroll-distance safety net (retained shape): near the bottom guard, nudge
  // a scrollToOffset so the virtualizer re-checks its range
  function safetyNet() {
    if (scrollGuardPending) return;
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
    setSt("images", []);
    setSt("selected", {});
    if (!name) return;
    try {
      setSt("images", await api.images(name));
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
        setSt("saved", saved);
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
    } catch (err) {
      // the load-failure surface (grid body + retry) lands with the status
      // chrome; until then the console carries it
      console.error(`couldn't load images from ${name}: ${err?.message ?? err}`);
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

  const actions = {
    // boot-time data, loaded exactly once (the bootData.mjs contract).
    // api.hosts() is deliberately not caught — a failed host list fails the
    // whole boot (the caller surfaces it).
    async boot() {
      setSt("hosts", await api.hosts());
      setSt("ui", await api.settings("core.ui").catch(() => ({})));
      setSt("nodesRegistry", await api.nodes().catch(() => ({})));
      setSt("fieldsStored", (await api.settings("core.fields").catch(() => ({})))?.cfg ?? null);
      const del = await api.settings("core.delete").catch(() => ({}));
      setSt("deletePrefs", { useAssetsPlus: del.useAssetsPlus ?? true });
      const jns = await api.settings("core.judgment").catch(() => ({}));
      setSt("judgmentPrefs", "downvoteHides", jns.downvoteHides ?? true);
      setSt("scraper", await api.scraper().catch(() => null));
      setSt("feedbackPath", (await api.settings("core").catch(() => ({})))?.feedbackPath ?? null);
      // the URL hash outranks the stored host: /#host[#filename] is shareable state
      const route = parseUrl();
      const urlHost = route.view === "diff" ? route.left?.source : route.host;
      const h = urlHost && st.hosts[urlHost] ? urlHost : initialHost(st.hosts, st.ui.host);
      if (h) await actions.hosts.select(h, { keepFile: true }); // hash pristine at boot
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
          setSt("hosts", await api.hosts());
          return { ok: true };
        } catch {
          return { ok: false };
        }
      },
      async remove(name) {
        try {
          await api.removeHost(name);
          setSt("hosts", await api.hosts());
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
        setSt("hosts", await api.hosts());
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
      open(image) { setSt("variations", { open: true, image }); }, // phase 5
    },

    diff: {
      close() { setSt("diff", "open", false); }, // phase 4 expands
      // workbench seams — phase 4 wires them; the details pane's input-image
      // and card clicks already target these
      openInput(_host, _file, _fromOutput) {},
      openFromFeed(_imgIdx) {},
    },

    feed: {
      register(seamsIn) { seams.virtualizer = seamsIn?.virtualizer ?? null; },
      restoreToIndex,
      safetyNet,
      wantRangeNow,
      retryImage(idx) { window_.retry(idx); },
    },
  };

  return {
    state: {
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
      get diff() { return st.diff; },
      get variations() { return st.variations; },
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
      confirmDelete,
      workspace,
      infoLayout,
    },
    actions,
  };
}

export const AppStoreContext = createContext(null);

export function useAppStore() {
  return useContext(AppStoreContext);
}
