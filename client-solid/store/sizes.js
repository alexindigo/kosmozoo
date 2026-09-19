// client-solid/store/sizes.js — every card's size is DATA, resolved before
// the card renders:
//
// a card mounts only when its size is known, and never changes height
// while mounted.
//
// Sources, in order: the listing's content dims (free, engine-resolved) →
// the extractor meta's dims → off-DOM Image measurement (zero layout
// effect) → 'failed'. The virtualizer's estimateSize is cardHeight — exact
// for every mounted row, so the virtualizer never compensates and no timer
// coordinates geometry.

import { createSignal } from "solid-js";

export const ERROR_RETRY_MS = 8000;
const RESOLVE_AHEAD = 30;   // entries past the visible window's tail
const RESOLVE_BEHIND = 10;  // and behind its head (when more are pending above)
const MAX_INFLIGHT = 6;     // bounded off-DOM concurrency
const MAX_BEHIND_ALL = 50;  // "resolve every pending entry above the fold" cap

// The retry scheduler lives HERE and only here: one timer; when the
// window opens the callback re-queues whatever it owns (the loader's failed
// ids, the image window's errored srcs).
let retryTimer = null;
export function scheduleRetry(cb) {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    cb?.();
  }, ERROR_RETRY_MS);
}

// Chrome under the image box (padding + title row + notes pair) is declared
// in CSS as --card-chrome-h — the pre-measure value, read once and re-read
// on resize. No numeric fallback: the var is the source; a missing var is a
// bug, not a fallback case.
let chromePx = null;
export function chromeHeightPx() {
  if (chromePx === null) {
    chromePx = typeof document !== "undefined"
      ? parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--card-chrome-h"))
      : NaN;
  }
  return chromePx;
}

// The inter-card spacing (--grid-gap), part of every virtual item's size:
// the virtualizer's scroll math must count exactly what the DOM lays out.
let gridGapPx_ = null;
export function gridGapPx() {
  if (gridGapPx_ === null) {
    gridGapPx_ = typeof document !== "undefined"
      ? parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--grid-gap"))
      : NaN;
  }
  return gridGapPx_;
}

// The rendered geometry constants, measured from the STABLE PROBE CARD the
// Grid renders for exactly this purpose (never a live feed card): the image
// box is narrower than the scroll column (grid gutter + card padding +
// border), and the rendered chrome is fractional (line boxes). Estimates
// must equal the rendered rects EXACTLY, so the truth
// is measured, cached in signals, and invalidated on resize. Callers that
// change geometry follow the measurement with virtualizer.measure — the
// core memoizes on its own dep list, so the signals alone do not refresh
// the estimates.
const [geomInset, setGeomInset] = createSignal(null);
const [geomChrome, setGeomChrome] = createSignal(null);

export function geometryMeasured() {
  return geomInset() !== null && geomChrome() !== null;
}

export function invalidateGeometry() {
  setGeomInset(null);
  setGeomChrome(null);
  chromePx = null;
  gridGapPx_ = null;
}

// Idempotent; safe on every mount/resize. probe is the hidden measuring
// card; colW is the scroll column's clientWidth — the same read
// estimateSize uses.
export function measureGeometry(probe, colW) {
  if (!probe || geometryMeasured()) return;
  const wrap = probe.querySelector(".imgwrap");
  const cr = probe.getBoundingClientRect();
  const wr = wrap?.getBoundingClientRect();
  if (!cr.height || !wr?.width) return;
  setGeomInset(colW - wr.width);
  setGeomChrome(cr.height - wr.height);
}

// Blink lays out in 1/64px units (its layout quantum) — rendered rects are
// multiples of 1/64. The formula quantizes the same way so estimate ===
// rect, exactly.
const q64 = (x) => Math.round(x * 64) / 64;

// THE one card-height formula: image box from the aspect ratio (capped at
// 16:9 — Zoomable's arStyle clamps the CSS variable the same way) + chrome.
// estimateSize calls exactly this, and the feed audit checks against it.
export function cardHeight(size, colW) {
  const ar = size.h > 0 ? size.w / size.h : 16 / 9;
  const inset = geomInset() ?? 0;
  const chrome = geomChrome() ?? chromeHeightPx();
  return q64((colW - inset) / Math.min(ar, 16 / 9)) + chrome;
}

export function makeSizes({ srcFor, imageAt }) {
  // the chrome height is read HERE (store creation — the CSS is applied by
  // now; never at module import) and re-read on every resize: it is the one
  // cardHeight input that can change without any entry changing
  chromeHeightPx();
  if (typeof window !== "undefined") {
    window.addEventListener("resize", () => { chromePx = null; chromeHeightPx(); });
  }
  const sizes = new Map();   // id -> { w, h }
  const failed = new Set();  // ids the loader gave up on (one retry schedule)
  const retried = new Set(); // ids whose single retry already failed
  const inFlight = new Set();
  // GC guard: the Image object is the ONLY holder of the load's onload/
  // onerror — if nothing references it, the collector aborts the load
  // mid-flight and the inFlight slot leaks forever ( stalls at
  // MAX_INFLIGHT). Keep every loading image referenced until it settles.
  const loading = new Map();
  const [version, setVersion] = createSignal(0);
  // the bumper MUST change the value: a bare setVersion writes undefined
  // once and then never notifies again (undefined === undefined) — every
  // downstream memo/effect silently freezes (the entire feed drain stall)
  const bump = () => setVersion((v) => v + 1);

  // reactive read: sizeOf subscribes to landings
  const sizeOf = (id) => { version(); return sizes.get(id) ?? null; };

  function loadFailed(id) {
    version();
    return failed.has(id);
  }

  function resolve(id) {
    if (typeof Image === "undefined") return; // headless (unit tests)
    if (sizes.has(id) || inFlight.has(id) || failed.has(id)) return;
    const src = srcFor(id);
    if (!src) return;
    inFlight.add(id);
    const img = new Image();
    loading.set(id, img);
    img.onload = () => {
      inFlight.delete(id);
      loading.delete(id);
      sizes.set(id, { w: img.naturalWidth, h: img.naturalHeight });
      bump();
    };
    img.onerror = () => {
      inFlight.delete(id);
      loading.delete(id);
      if (retried.has(id)) {
        failed.add(id); // the single retry failed too — permanent
      } else {
        retried.add(id); // exactly one retry, in ERROR_RETRY_MS
        scheduleRetry(() => { retried.clear(); bump(); });
      }
      bump();
    };
    img.src = src;
  }

  const hasDims = (e) => (e.width && e.height) || (e.meta?.width && e.meta?.height);

  // Stage off-DOM measurements for VIEW entries around the visible window;
  // bounded concurrency. BEHIND FIRST: an entry above the viewport whose
  // size lands inserts a card above the fold — when the pending-above count
  // is small (≤ 50) every one of them resolves before anything below, so
  // the common case never has pending entries above the fold. viewIdx is
  // view's index list and images come via imageAt — nothing materializes
  // the listing per call.
  function resolveAhead(viewIdx, first, last) {
    if (!viewIdx.length) return;
    let pendingAbove = 0;
    for (let i = 0; i < first; i++) {
      const e = imageAt(viewIdx[i]);
      if (e && !hasDims(e) && !failed.has(e.id)) pendingAbove++;
    }
    const behind = pendingAbove <= MAX_BEHIND_ALL ? first : RESOLVE_BEHIND;
    const from = Math.max(0, first - behind);
    const to = Math.min(viewIdx.length - 1, last + RESOLVE_AHEAD);
    const stage = (i) => {
      const e = imageAt(viewIdx[i]);
      if (!e || hasDims(e) || failed.has(e.id)) return;
      resolve(e.id);
    };
    for (let i = from; i < first && inFlight.size < MAX_INFLIGHT; i++) stage(i);
    for (let i = first; i <= to && inFlight.size < MAX_INFLIGHT; i++) stage(i);
  }

  return { sizeOf, resolveAhead, loadFailed };
}
