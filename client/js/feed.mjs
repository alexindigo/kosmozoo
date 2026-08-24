// client/js/feed.mjs — the list engine for the candidates feed.
//
// The DOM is declared by <Grid> (client/app/components); this engine owns the
// view (filtered + visible display order), the chunked render position, the
// scroll/restore progress mechanisms, and the lightbox seams. The image
// window — which cards carry src — lives in useWindow, so there is no manual
// load/unload here.
//
// Design contracts kept from the outgoing engine:
// - Chunked render: the sentinel WINDOW_PAD cards before the rendered end
//   triggers the next chunk; a scroll-distance safety net backs it up.
// - Restore extends chunks until the target card exists, then centers it.
// - The lightbox walks the VIEW, extending chunks when stepping past the
//   rendered end; its position joins the window (see useWindow).

import { h, render } from "../vendor/preact/vendor.mjs";
import { Grid } from "../app/components/Grid.mjs";
import { state } from "./state.mjs";
import { api } from "./api.mjs";

const CHUNK = 20;
const PREFETCH = 4;

let openHook = null;   // (imgIdx) -> void   opens the lightbox
let wantHook = null;   // (image) -> void    meta-want reporting

// view = display order of image indices (filtered + visible).
let view = [];
let viewPos = 0;       // how much of the view is rendered (chunked)
let container = null;
let windowApi = null;  // registered by <Grid> (useWindow)
let scrollChunkPending = false;

export function initFeed({ onOpen, wantMeta } = {}) {
  openHook = onOpen ?? null;
  wantHook = wantMeta ?? null;
}

function wantRange(start, end) {
  if (!wantHook) return;
  for (let i = start; i < end; i++) {
    const image = state.images[view[i]];
    if (image) wantHook(image);
  }
}

function drawGrid() {
  if (!container) return;
  render(h(Grid, {
    view,
    count: viewPos,
    onOpen: openHook,
    onSentinel: renderChunk,
    registerApi: (w) => { windowApi = w; },
  }), container);
}

export function resetFeed() {
  view = [];
  viewPos = 0;
  windowApi = null;
  if (container) render(null, container);
}

export function renderFeed(el, indices) {
  container = el;
  view = indices;
  viewPos = Math.min(CHUNK, view.length);
  wantRange(0, viewPos);
  drawGrid();
}

export function renderChunk() {
  if (!container || viewPos >= view.length) return;
  const start = viewPos;
  viewPos = Math.min(viewPos + CHUNK, view.length);
  wantRange(start, viewPos);
  drawGrid();
}

// --- window seams (the lightbox reaches the window through these) -----------

export function applyWindow() { windowApi?.recompute(); }
export function retryImage(idx) { windowApi?.retry(idx); }

// --- progress mechanisms -----------------------------------------------------

// The candidates column scrolls itself (no page-level scroll).
function scroller() {
  return document.getElementById("candidatesCol");
}

// scroll-distance safety net — the sentinel can be stranded above the
// viewport after a restore jump.
export function onScrollSafetyNet() {
  if (scrollChunkPending) return;
  scrollChunkPending = true;
  setTimeout(() => {
    scrollChunkPending = false;
    const col = scroller();
    if (!col) return;
    if (viewPos < view.length &&
        col.scrollHeight - (col.scrollTop + col.clientHeight) < col.clientHeight * 1.5) {
      renderChunk();
    }
  }, 120);
}

// extend chunks until the target card exists, then center it (URL deep link).
export function restoreToIndex(idx) {
  const col = scroller();
  if (!col || idx < 0) return;
  let guard = 500;
  while (viewPos < view.length && guard-- > 0 && view.indexOf(idx) >= viewPos) renderChunk();
  document.querySelector(`.card[data-idx="${idx}"]`)?.scrollIntoView({ block: "center" });
}

// --- lightbox-driven seams ----------------------------------------------------

// Direction-aware prefetch for Up/Down traversal (fetch seam: DOM-free).
export function prefetchFrom(imgIdx, dir, fetcher = globalThis.fetch) {
  for (let i = 1; i <= PREFETCH; i++) {
    const idx = imgIdx + dir * i;
    if (idx < 0 || idx >= state.images.length) break;
    fetcher(api.imageBytesUrl(state.images[idx].id)).then((r) => r.arrayBuffer()).catch(() => {});
  }
}

// Step within the view, extending chunks when stepping past the rendered end.
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
  while (n >= viewPos && viewPos < view.length && container) renderChunk();
  if (n < 0 || n >= view.length) return imgIdx;
  return view[n];
}

export function viewIndices() { return view; }

// test seam (Deno has no DOM): drive viewStep without renderFeed
export function __testSetView(v, pos = v.length) {
  view = v;
  viewPos = pos;
}
