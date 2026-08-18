// client/js/volume.mjs — windowed image loading + prefetch for the grid.
//
// Design requirement (not a bug fix): **lightbox position drives the image
// window.** In the outgoing code the window was scroll-driven only, so
// walking the lightbox with the keyboard never advanced it — the window
// froze where the lightbox opened and every step past ~10 candidates was a
// cold fetch. Here the window follows whichever is moving: the scroll
// viewport OR the lightbox index. Plus direction-aware prefetch of the next
// few candidates. Left/Right needs no prefetch: the anchor is a local blob
// and the candidate is already on screen — only Up/Down traversal does.

import { S } from "./state.mjs";
import { api } from "./api.mjs";

const WINDOW_PAD = 10;   // cards either side of the active window
const PREFETCH = 4;      // direction-ahead prefetch count on Up/Down
const CHUNK = 60;        // cards rendered per frame chunk

// Sparse card registry: index -> element (built chunk by chunk).
const cardEls = [];
const loadedSet = new Set();
let visibleLo = 0, visibleHi = 0;

export function resetWindow() {
  cardEls.length = 0;
  loadedSet.clear();
  renderedPos = 0;
  visibleLo = 0; visibleHi = 0;
}

// --- three independent progress mechanisms (harvest #5) --------------------
// 1. sentinel observer (fast path)  2. scroll-position safety net
// 3. programmatic restore — any single one stalling must not stop the list.

let sentinelObserver = null;
export function initProgress(grid, sentinel, onProgress) {
  sentinelObserver?.disconnect();
  sentinelObserver = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) onProgress();
  }, { root: null, rootMargin: "600px" });
  sentinelObserver.observe(sentinel);
  grid.addEventListener("scroll", onScrollNet, { passive: true });
}

let scrollNetArmed = true;
function onScrollNet() {
  if (!scrollNetArmed) return;
  scrollNetArmed = false;
  requestAnimationFrame(() => { scrollNetArmed = true; /* re-render net */ });
}

// --- the window -------------------------------------------------------------

// The window is the union of the scroll viewport and the lightbox position —
// whichever the user is driving. This is the fix for the freeze.
export function activeWindow() {
  const lo = Math.max(0, Math.min(visibleLo, lbIndexOr(visibleLo)) - WINDOW_PAD);
  const hi = Math.min(S.images.length - 1, Math.max(visibleHi, lbIndexOr(visibleHi)) + WINDOW_PAD);
  return [lo, hi];
}

function lbIndexOr(fallback) {
  return S.lightbox.open && S.lightbox.index >= 0 ? S.lightbox.index : fallback;
}

export function applyWindow() {
  const [lo, hi] = activeWindow();
  for (const idx of [...loadedSet]) {
    if (idx < lo || idx > hi) unloadImage(idx);
  }
  for (let i = lo; i <= hi; i++) loadImage(i);
}

function loadImage(idx) {
  if (loadedSet.has(idx)) return;
  const card = cardEls[idx];
  if (!card) return;
  const img = card.querySelector("img");
  if (!img) return;
  img.src = api.imageBytesUrl(S.images[idx].id);
  loadedSet.add(idx);
}

// Unload by removeAttribute('src') — aborts the fetch AND releases decoded
// bytes (harvest #6).
function unloadImage(idx) {
  const card = cardEls[idx];
  const img = card?.querySelector("img");
  if (!img) return;
  img.removeAttribute("src");
  loadedSet.delete(idx);
}

// Manual retry must cache-bust, or a partial cached response is reused
// (harvest #14).
export function retryImage(idx) {
  const card = cardEls[idx];
  const img = card?.querySelector("img");
  if (!img) return;
  img.removeAttribute("src");
  img.src = api.imageBytesUrl(S.images[idx].id) + "?_r=" + Date.now();
  loadedSet.add(idx);
}

// Direction-aware prefetch for Up/Down lightbox traversal (harvest-adjacent:
// the window follows the keyboard; prefetch warms the direction of travel).
// Uses fetch (DOM-free seam) — engine-proxied bytes carry cache headers, so
// the later <img> load hits the HTTP cache instead of the network.
export function prefetchFrom(index, dir, fetcher = globalThis.fetch) {
  for (let i = 1; i <= PREFETCH; i++) {
    const idx = index + dir * i;
    if (idx < 0 || idx >= S.images.length) break;
    fetcher(api.imageBytesUrl(S.images[idx].id)).then((r) => r.arrayBuffer()).catch(() => {});
  }
}

// Chunked render: build card skeletons a frame at a time so a 3,000-image
// grid doesn't block first paint. cardEls is indexed by IMAGE index (sparse
// under filtering); view is the display order of image indices. decorate()
// carries the grid's visual concerns (badges) without volume.mjs knowing them.
let renderedPos = 0;
export function renderChunked(grid, view, decorate, done) {
  const start = renderedPos;
  const end = Math.min(start + CHUNK, view.length);
  for (let p = start; p < end; p++) {
    const imgIdx = view[p];
    const card = document.createElement("div");
    card.className = "card";
    card.dataset.index = imgIdx;
    const img = document.createElement("img");
    img.alt = S.images[imgIdx].filename;
    card.appendChild(img);
    decorate?.(card, S.images[imgIdx], imgIdx);
    grid.appendChild(card);
    cardEls[imgIdx] = card;
  }
  renderedPos = end;
  if (end < view.length) requestAnimationFrame(() => renderChunked(grid, view, decorate, done));
  else done?.();
}

export function setVisibleRange(lo, hi) {
  visibleLo = lo; visibleHi = hi;
  applyWindow();
}
