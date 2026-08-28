// client/js/state.mjs — one shared state object. The snapshot only.
//
// Mutations happen here; the DOM reads it. The re-render signal lives on the
// Preact side (app/services/notify.mjs) — <App> subscribes for the tree.
// Box-fraction view state: see geometry.mjs.

// The single application state object.
export const state = {
  // server-driven data
  hosts: {},            // name -> { address, online }
  host: null,           // selected host name
  images: [],           // [{ id, host, filename, meta, judgment }] — shared list model
  scraper: null,        // { enabled, paused, pending: {host: n} }
  feedbackPath: null,   // where judgments live (engine-side)
  nodesRegistry: null,  // discovered node types: { class_type: { title, inputs→kind } } (/api/nodes)
  fieldsCfg: null,      // metadata fields picker config (core.fields.cfg)
  // session UI state (dies with the page)
  anchors: [],          // [{ name, src(dataURL), meta? }] — local drops, persisted
  anchorPaneWidth: 300, // px; divider-adjusted, persisted
  workspace: "details", // right column space: 'details' | 'anchors', persisted
  infoLayout: "split",  // details pane layout: 'split' | 'rev' | 'stacked', persisted
  // The single "current image" pointer — the one source of truth for which
  // image is current. `remote` is the source (a configured host/folder name,
  // or "anchor"); `image` is the filename (or anchor name). The URL hash
  // MIRRORS it (route.mjs) for shareable deep-links; it does not outrank it.
  current: null,        // { remote, image } | null
  diff: {               // the workbench: a single-image viewer of state.current
    open: false,
  },
  filter: "",
  hostMenuOpen: false,
  menuOpen: false,
  menuFilter: "",
  keysPanelOpen: false,
  keysFilter: "",
  capturing: null,      // action id awaiting a keypress (rebind)
  fieldsOverlayOpen: false,   // metadata fields picker
  infoOverlay: { open: false, name: "", meta: null },  // anchor ⓘ params
  confirmDelete: null,        // { image } | { images } while the delete confirmation is open
  deletePrefs: { useAssetsPlus: true },  // core.delete settings mirror
  selected: new Set(),        // selected image ids (bulk actions); session-only
  roi: null,            // { fx, fy, fw, fh } box-fractions, manual-first
  guides: [],           // [{ axis, pos }] — persist globally (harvest #12)
  dragGuide: null,      // in-progress guide drag from an edge { axis, pos }
};
