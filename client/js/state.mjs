// client/js/state.mjs — one state object, one render path.
//
// The two things worth carrying from the outgoing design:
//  - One state object; render() is the ONLY DOM writer.
//  - Box-fraction view state (see geometry.mjs).
//
// Left behind: 210 top-level declarations in one scope, two import cycles,
// the lightbox reading the grid's DOM as its data model — here the list
// model is shared and explicit.

import { freshView } from "./geometry.mjs";

// The single application state object.
export const S = {
  // server-driven data
  hosts: {},            // name -> { address, online }
  host: null,           // selected host name
  images: [],           // [{ id, host, filename, meta, judgment }] — shared list model
  // session UI state (dies with the page)
  lightbox: {
    open: false,
    index: -1,          // index into images
    col: "candidate",   // 'candidate' | 'anchor'
    view: freshView(),
    loadGen: 0,         // load-generation guard (harvest #1)
  },
  anchors: [],          // [{ name, src(blobURL), meta? }] — local drops
  filter: "",
  // axes (see docs/spec.md §1)
  axes: {
    alignment: "shared",      // 'independent' | 'shared' | 'face-anchored'
    composition: "flicker",   // 'flicker' | 'blend' | 'split' | 'difference'
  },
  axisReason: null,           // why a just-cycled-past value is unavailable
  detector: null,             // detector plugin status, when present
  roi: null,            // { fx, fy, fw, fh } box-fractions, manual-first
  guides: [],           // [{ axis, pos }] — persist globally (harvest #12)
};

// The only DOM writer. Re-renders the surfaces from S. Individual surfaces
// subscribe to the parts they own; nothing else touches the DOM.
const renderers = [];
export function onRender(fn) { renderers.push(fn); }
export function render() { for (const fn of renderers) fn(S); }
