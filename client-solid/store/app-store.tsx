// client-solid/store/app-store.tsx — the single global store (plan §3.2).
//
// One makeAppStore() created at boot, provided via context at the app root.
// Views read store.state.* and call store.actions.* — nothing else. The store
// owns the model: api.mjs is a store-internal dependency; views never fetch.
//
// Reactivity shape: createStore for tree structures (hosts, settings, the
// node registry) — path-level updates touch only dependents of that path;
// createSignal for scalar atoms (host, current, filter, menu flags).
// Note: the store ROOT is not assignable (st.x = v is silently ignored) —
// root-level replacement goes through setSt("x", v); nested paths assign.

import { createSignal, createContext, useContext } from "solid-js";
import { createStore } from "solid-js/store";
import { api } from "/js/api.mjs";
import { parseUrl, stripHostPrefix } from "/js/route-parse.mjs";

// stored host if still present, else first online, else first
function initialHost(hosts, stored) {
  if (stored && hosts[stored]) return stored;
  const names = Object.keys(hosts);
  return names.find((n) => hosts[n].online) ?? names[0] ?? null;
}

export function makeAppStore() {
  // tree structures — path-level updates
  const [st, setSt] = createStore({
    hosts: {},            // name -> { address, online }
    nodesRegistry: {},    // discovered node types (/api/nodes)
    fieldsStored: null,   // raw core.fields cfg — fieldsCfg derives where the
                          // fields surface consumes it (fields.mjs rewiring)
    scraper: null,        // { enabled, paused, pending: {host: n} }
    feedbackPath: null,   // where judgments live (engine-side)
    deletePrefs: { useAssetsPlus: true },
    ui: {},               // core.ui settings (stored host, ...)
  });

  // scalar atoms
  const [host, setHost] = createSignal(null);
  const [current, setCurrent] = createSignal(null); // { remote, image } | null
  const [filter, setFilter] = createSignal("");
  const [hostMenuOpen, setHostMenuOpen] = createSignal(false);
  const [menuOpen, setMenuOpen] = createSignal(false);

  // The URL hash MIRRORS state.current (replaceState → no hashchange loop).
  // Anchors are not feed URLs, so they are not mirrored.
  function mirrorCurrentHash() {
    const c = current();
    if (!c || c.remote === "anchor") return;
    const file = c.image ? stripHostPrefix(c.remote, c.image) : null;
    const want = "#" + encodeURIComponent(c.remote)
      + (file ? "#" + encodeURIComponent(file) : "");
    if (location.hash !== want) history.replaceState(history.state, "", want);
  }

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
          setCurrent({ remote: name, image: null });
          mirrorCurrentHash();
        }
        api.setSettings("core.ui", { host: name }).catch(() => {});
        // phase 2: the feed reload hooks in here (images.load)
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

    ui: {
      setFilter(v) { setFilter(v); }, // phase 2: the feed rebuild consumes it
      toggleMenu() { setMenuOpen(!menuOpen()); },
      closeMenu() { setMenuOpen(false); },
    },

    current: {
      set(remote, image) {
        setCurrent({ remote, image });
        mirrorCurrentHash();
      },
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
      // scalar atoms
      host,
      current,
      filter,
      hostMenuOpen,
      menuOpen,
    },
    actions,
  };
}

export const AppStoreContext = createContext(null);

export function useAppStore() {
  return useContext(AppStoreContext);
}
