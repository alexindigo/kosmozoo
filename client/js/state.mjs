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
  fieldsCfg: null,      // metadata fields picker config (core.fields.cfg)
  // session UI state (dies with the page)
  anchors: [],          // [{ name, src(dataURL), meta? }] — local drops, persisted
  anchorPaneWidth: 300, // px; divider-adjusted, persisted
  workspace: "details", // right column space: 'details' | 'anchors', persisted
  // the current image lives ONLY in the URL (route.mjs) — no mirror here,
  // a second representation would be a drift surface
  diff: {                 // the workbench: /diff pairs AND the feed browser
    open: false,
    left: null,           // { source, file }
    right: null,          // { source, file } | null (single image)
    col: "left",          // active side: blink target, pan/zoom target
    fromFeed: false,      // opened from the feed (URL stays the feed hash)
    anchorIndex: 0,       // last-used anchor (the feed-side blink partner)
    candidateIdx: -1,     // last left-side feed image index
    blend: 0.5,           // top-side opacity in blend
    split: 0.5,           // wipe position in split
    view: null,           // shared box-fraction view (geometry.mjs)
    views: { left: null, right: null }, // independent views
    leftList: null,       // left source's file list (stepping)
    rightList: null,
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
  // axes (see docs/spec.md §1)
  axes: {
    alignment: "shared",      // 'independent' | 'shared' | 'face-anchored'
    composition: "flicker",   // 'flicker' | 'blend' | 'split' | 'difference'
  },
  axisReason: null,           // why a just-cycled-past value is unavailable
  detector: null,             // detector plugin status, when present
  roi: null,            // { fx, fy, fw, fh } box-fractions, manual-first
  guides: [],           // [{ axis, pos }] — persist globally (harvest #12)
  dragGuide: null,      // in-progress guide drag from an edge { axis, pos }
};
