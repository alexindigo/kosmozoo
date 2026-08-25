// client/js/state.mjs — one shared state object. The snapshot only.
//
// Mutations happen here; the DOM reads it. The re-render signal lives on the
// Preact side (app/services/notify.mjs) — <App> subscribes for the tree.
// Box-fraction view state: see geometry.mjs.

import { freshView } from "./geometry.mjs";

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
  lightbox: {
    open: false,
    index: -1,          // index into images
    col: "candidate",   // 'candidate' | 'anchor'
    view: freshView(),
    loadGen: 0,         // load-generation guard (harvest #1)
    splitX: null,       // split-wipe line, viewport px; null = centered
    blendOpacity: 0.5,
    anchorIndex: 0,
  },
  anchors: [],          // [{ name, src(dataURL), meta? }] — local drops, persisted
  anchorPaneWidth: 300, // px; divider-adjusted, persisted
  workspace: "details", // right column space: 'details' | 'anchors', persisted
  // the current image lives ONLY in the URL (route.mjs) — no mirror here,
  // a second representation would be a drift surface
  diff: {                 // the /diff comparison view
    open: false,
    left: null,           // { source, file }
    right: null,          // { source, file }
    col: "left",          // active side: blink target, pan/zoom target
    composition: "flicker", // flicker | blend | split | difference | side
    alignment: "shared",  // shared | independent registration
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
