// client/js/feed.mjs — the list engine for the candidates feed.
//
// The DOM is declared by <Grid> (client/app/components); this engine owns the
// view (filtered + visible display order) and the workbench seams. <Grid> is
// a virtualized window (@tanstack/virtual-core): DOM only ever holds the
// viewport±pad window, so restore/step costs O(window), not O(scroll
// position. Image-src windowing (useWindow) is untouched.

import { h, render } from "../vendor/preact/vendor.mjs";
import { Grid } from "../app/components/Grid.mjs";
import { suppressScrollSnap } from "../app/services/scrollSnap.mjs";
import { state } from "./state.mjs";
import { api } from "./api.mjs";

const WANT_INIT = 20; // initial meta-want sweep the window covers anyway

let openHook = null;   // (imgIdx) -> void   opens the workbench
let wantHook = null;   // (image) -> void    meta-want reporting

// view = display order of image indices (filtered + visible).
let view = [];
let container = null;
let windowApi = null;  // { win, virtualizer } registered by <Grid>
let scrollChunkPending = false;

export function initFeed({ onOpen, wantMeta } = {}) {
  openHook = onOpen ?? null;
  wantHook = wantMeta ?? null;
}

// meta-want: the rendered window's images. CHUNK days fired it per chunk;
// the virtualized window covers the same range — drive it per render.
function wantRangeNow() {
  if (!wantHook) return;
  for (let i = 0; i < Math.min(WANT_INIT, view.length); i++) {
    const image = state.images[view[i]];
    if (image) wantHook(image);
  }
}

function drawGrid() {
  if (!container) return;
  render(h(Grid, {
    view,
    onOpen: openHook,
    registerApi: (w) => { windowApi = w; },
  }), container);
}

export function resetFeed() {
  view = [];
  windowApi = null;
  state.selected.clear(); // selections belong to the feed they were made in
  if (container) render(null, container);
}

export function renderFeed(el, indices) {
  container = el;
  view = indices;
  wantRangeNow();
  drawGrid();
}

// --- window seams (the workbench reaches the window through these) ----------

export function applyWindow() { windowApi?.win?.recompute(); }
export function retryImage(idx) { windowApi?.win?.retry(idx); }

// --- progress mechanisms -----------------------------------------------------

// The candidates column scrolls itself (no page-level scroll).
function scroller() {
  return document.getElementById("candidatesCol");
}

// scroll-distance safety net — retained shape; under the virtualizer it
// merely nudges a scrollToOffset toward the bottom guard.
export function onScrollSafetyNet() {
  if (scrollChunkPending) return;
  scrollChunkPending = true;
  setTimeout(() => {
    scrollChunkPending = false;
    const col = scroller();
    if (!col) return;
    if (windowApi?.virtualizer && col.scrollHeight - (col.scrollTop + col.clientHeight) < col.clientHeight * 1.5) {
      windowApi.virtualizer.scrollToOffset(col.scrollTop, { align: "start" });
    }
  }, 120);
}

// extend chunks until the target card exists, then center it (URL deep link,
// post-delete navigation): the virtualizer walks to the target index and
// only the viewport±pad window renders — no prefix extension.
export function restoreToIndex(idx) {
  const col = scroller();
  if (!col || idx < 0) return;
  const viewPosOfIdx = view.indexOf(idx);
  if (viewPosOfIdx < 0) return;
  if (windowApi?.virtualizer) {
    windowApi.virtualizer.scrollToIndex(viewPosOfIdx, { align: "center" });
    // still meta-want the just-rendered range
    wantRangeNow();
  } else {
    // pre-Grid boot: put it on-screen roughly, the Grid re-centers when it mounts
    document.querySelector(`.card[data-idx="${idx}"]`)?.scrollIntoView({ block: "center" });
  }
  // this is a programmatic center, not user scrolling — keep the snap from
  // immediately pulling the centered card back to the top edge
  suppressScrollSnap();
}

// --- workbench-driven seams ---------------------------------------------------

// Direction-aware prefetch for Up/Down traversal (fetch seam: DOM-free).
export function prefetchFrom(imgIdx, dir, fetcher = globalThis.fetch) {
  for (let i = 1; i <= 4; i++) {
    const idx = imgIdx + dir * i;
    if (idx < 0 || idx >= state.images.length) break;
    fetcher(api.imageBytesUrl(state.images[idx].id)).then((r) => r.arrayBuffer()).catch(() => {});
  }
}

// Step within the view. The virtualized window follows — no chunk extension.
export function viewStep(imgIdx, dir) {
  if (!view.length) return imgIdx;
  const pos = view.indexOf(imgIdx);
  let n;
  if (pos >= 0) {
    n = pos + dir;
  } else {
    // current image not in the view (filtered/hidden): it sits AT the
    // insertion point — a forward step lands on the next entry as-is
    const ins = view.findIndex((v) => v > imgIdx);
    const at = ins < 0 ? view.length : ins;
    n = at + (dir > 0 ? 0 : -1);
  }
  if (n < 0 || n >= view.length) return imgIdx;
  const target = view[n];
  windowApi?.virtualizer?.scrollToIndex(n, { align: "auto" });
  return target;
}

export function viewIndices() { return view; }

// test seam (Deno has no DOM): drive viewStep without renderFeed. The second
// arg is legacy (chunk position — meaningless under the virtualizer).
export function __testSetView(v, _pos = v.length) {
  view = v;
}
