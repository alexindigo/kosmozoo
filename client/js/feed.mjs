// client/js/feed.mjs — the list engine for the candidates feed.
//
// The feed renders the shared list model (S.images) as full-width record
// cards, CHUNK at a time, with image bytes loaded only inside the active
// window. Design contracts:
//
// - Chunked render: a sentinel WINDOW_PAD cards before the rendered end
//   triggers the next chunk (fast path).
// - Windowed bytes: images load inside viewport ∪ lightbox position,
//   ± WINDOW_PAD; leaving the window removes src — aborts the fetch AND
//   releases decoded bytes. The card keeps its height via the aspect-true
//   box, so virtualization never jumps the feed.
// - Three independent progress mechanisms — any single one stalling must
//   not stall the list: (1) the sentinel observer, (2) the scroll-distance
//   safety net, (3) extend-then-jump scroll restore.
// - Errors: auto-retry every 8s while in the window; manual retry
//   cache-busts (a partial cached response must not be reused).
// - The lightbox walks the VIEW (filtered + judgment-visible set), extending
//   chunks when stepping past the rendered end; its position drives the
//   window (keyboard walking must not freeze image loading).

import { S } from "./state.mjs";
import { api } from "./api.mjs";

const CHUNK = 20;
const WINDOW_PAD = 10;
const ERROR_RETRY_MS = 8000;
const PREFETCH = 4;

let buildCard = null;   // (image, imageIndex) -> element
let wantHook = null;    // (image) -> void  (meta-want reporting)
let visibleHook = null; // (image) -> bool  (judgment visibility)

export function initFeed({ card, onScreen, wantMeta }) {
  buildCard = card;
  visibleHook = onScreen;
  wantHook = wantMeta;
}

// view = display order of image indices (filtered + visible); cardEls is
// indexed by IMAGE index (sparse under filtering).
const cardEls = [];
const loadedSet = new Set();
const visibleSet = new Set();
let view = [];
let viewPos = 0;
let container = null;
let listObserver = null;
let sentinelObserver = null;
let sentinelEl = null;
let errorRetryTimer = null;

export function resetFeed() {
  listObserver?.disconnect();
  sentinelObserver?.disconnect();
  cardEls.length = 0;
  loadedSet.clear();
  visibleSet.clear();
  view = [];
  viewPos = 0;
  sentinelEl = null;
  container = null;
}

export function renderFeed(el, indices) {
  container = el;
  view = indices;
  viewPos = 0;
  container.innerHTML = "";
  setupObservers();
  renderChunk();
}

function setupObservers() {
  listObserver?.disconnect();
  sentinelObserver?.disconnect();
  listObserver = new IntersectionObserver((entries) => {
    let changed = false;
    for (const en of entries) {
      const idx = Number(en.target.dataset.idx);
      if (en.isIntersecting) {
        if (!visibleSet.has(idx)) { visibleSet.add(idx); changed = true; }
      } else if (visibleSet.delete(idx)) changed = true;
    }
    if (changed) applyWindow();
  });
  sentinelObserver = new IntersectionObserver((entries) => {
    if (entries.some((en) => en.isIntersecting)) renderChunk();
  });
}

export function renderChunk() {
  if (!container) return;
  let added = 0;
  const frag = document.createDocumentFragment();
  while (viewPos < view.length && added < CHUNK) {
    const imgIdx = view[viewPos++];
    const image = S.images[imgIdx];
    wantHook?.(image);
    const el = buildCard(image, imgIdx);
    cardEls[imgIdx] = el;
    frag.appendChild(el);
    listObserver.observe(el);
    added++;
  }
  container.appendChild(frag);

  if (sentinelEl) sentinelEl.remove();
  if (viewPos < view.length) {
    if (!sentinelEl) {
      sentinelEl = document.createElement("div");
      sentinelEl.className = "sentinel";
      sentinelEl.textContent = "loading more…";
      sentinelObserver.observe(sentinelEl);
    }
    const rendered = cardEls.filter(Boolean);
    const trigger = rendered[Math.max(0, rendered.length - WINDOW_PAD)];
    if (trigger) container.insertBefore(sentinelEl, trigger);
    else container.appendChild(sentinelEl);
  } else {
    const done = document.createElement("div");
    done.className = "endoflist";
    done.textContent = S.filter
      ? `— all ${view.length} matching “${S.filter}” —`
      : `— all ${S.images.length} images —`;
    container.appendChild(done);
  }
  // newly rendered cards inside the window may not get an observer event
  applyWindow();
}

// --- the window -----------------------------------------------------------------

export function applyWindow() {
  const base = [...visibleSet];
  if (S.lightbox.open && S.lightbox.index >= 0) base.push(S.lightbox.index);
  if (!base.length) return;
  const min = Math.min(...base) - WINDOW_PAD;
  const max = Math.max(...base) + WINDOW_PAD;
  for (const idx of [...loadedSet]) {
    if (idx < min || idx > max) unloadImage(idx);
  }
  for (let i = Math.max(0, min); i <= Math.min(S.images.length - 1, max); i++) {
    if (!loadedSet.has(i)) loadImage(i);
  }
  scheduleErrorRetry();
}

function loadImage(idx) {
  const img = cardEls[idx]?.querySelector(".imgwrap img");
  if (!img) return;
  const wrap = img.closest(".imgwrap");
  wrap.classList.remove("empty", "error");
  wrap.classList.add("loading");
  img.src = api.imageBytesUrl(S.images[idx].id);
  loadedSet.add(idx);
}

export function retryImage(idx) {
  const img = cardEls[idx]?.querySelector(".imgwrap img");
  if (!img) return;
  const wrap = img.closest(".imgwrap");
  img.removeAttribute("src");
  wrap.classList.remove("error");
  wrap.classList.add("loading");
  img.src = api.imageBytesUrl(S.images[idx].id) + "?_r=" + Date.now();
  loadedSet.add(idx);
}

function unloadImage(idx) {
  const img = cardEls[idx]?.querySelector(".imgwrap img");
  if (!img) return;
  img.removeAttribute("src");
  const wrap = img.closest(".imgwrap");
  wrap.classList.remove("loading");
  wrap.classList.add("empty");
  loadedSet.delete(idx);
}

function scheduleErrorRetry() {
  if (errorRetryTimer) return;
  errorRetryTimer = setTimeout(() => {
    errorRetryTimer = null;
    const base = [...visibleSet];
    if (S.lightbox.open && S.lightbox.index >= 0) base.push(S.lightbox.index);
    if (!base.length) return;
    const min = Math.min(...base) - WINDOW_PAD;
    const max = Math.max(...base) + WINDOW_PAD;
    let any = false;
    for (const idx of [...loadedSet]) {
      if (idx < min || idx > max) continue;
      const wrap = cardEls[idx]?.querySelector(".imgwrap");
      if (wrap?.classList.contains("error")) {
        retryImage(idx);
        any = true;
      }
    }
    if (any) scheduleErrorRetry();
  }, ERROR_RETRY_MS);
}

// --- progress mechanisms #2 and #3 ------------------------------------------------

// #2: scroll-distance safety net — the sentinel can be stranded above the
// viewport after a restore jump.
let scrollChunkPending = false;
export function onScrollSafetyNet() {
  if (scrollChunkPending) return;
  scrollChunkPending = true;
  setTimeout(() => {
    scrollChunkPending = false;
    const de = document.documentElement;
    if (!de) return;
    if (viewPos < view.length &&
        de.scrollHeight - (window.scrollY + window.innerHeight) < window.innerHeight * 1.5) {
      renderChunk();
    }
  }, 120);
}

// #3: extend chunks until the stored depth exists, then jump.
export function restoreScroll(target) {
  if (!target || !container) return;
  let guard = 500;
  const de = document.documentElement;
  while (viewPos < view.length && guard-- > 0 && (de?.scrollHeight ?? 0) < target) {
    renderChunk();
  }
  window.scrollTo(0, target);
}

// --- lightbox-driven window ---------------------------------------------------------

// Direction-aware prefetch for Up/Down traversal (fetch seam: DOM-free).
export function prefetchFrom(imgIdx, dir, fetcher = globalThis.fetch) {
  for (let i = 1; i <= PREFETCH; i++) {
    const idx = imgIdx + dir * i;
    if (idx < 0 || idx >= S.images.length) break;
    fetcher(api.imageBytesUrl(S.images[idx].id)).then((r) => r.arrayBuffer()).catch(() => {});
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

export function cardAt(idx) { return cardEls[idx]; }
export function viewIndices() { return view; }

// test seam (Deno has no DOM): drive viewStep without renderFeed
export function __testSetView(v, pos = v.length) {
  view = v;
  viewPos = pos;
}
