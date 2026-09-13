// client-solid/store/sizes.js — every card's size is DATA, resolved before
// the card renders (cruft-cleanup §3.5's invariant):
//
//   a card mounts only when its size is known, and never changes height
//   while mounted.
//
// Sources, in order: the listing's content dims (free, engine-resolved) →
// the extractor meta's dims → off-DOM Image measurement (zero layout
// effect) → 'failed'. The virtualizer's estimateSize is cardHeight() — exact
// for every mounted row, so the virtualizer never compensates and no timer
// coordinates geometry.

import { createSignal } from "solid-js";

export const ERROR_RETRY_MS = 8000;
const RESOLVE_AHEAD = 30;   // entries past the visible window's tail
const RESOLVE_BEHIND = 10;  // and behind its head
const MAX_INFLIGHT = 6;     // bounded off-DOM concurrency

// Chrome under the image box (padding + title row + notes pair) is declared
// in CSS as --card-chrome-h — the first-frame fallback until a live card
// makes the RENDERED geometry measurable (B11's JS-side constant is dead).
let chromePx = null;
export function chromeHeightPx() {
  if (chromePx === null) {
    const v = typeof document !== "undefined"
      ? parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--card-chrome-h"))
      : NaN;
    chromePx = Number.isFinite(v) && v > 0 ? v : 148; // the pre-var measurement
  }
  return chromePx;
}

// The rendered geometry constants, measured from a live card: the image box
// is narrower than the scroll column (grid gutter + card padding + border),
// and the rendered chrome is fractional (line boxes) — the declared values
// are approximations. Estimates must equal the rendered rects EXACTLY (the
// §3.5 invariant), so the truth is measured, cached in signals, and
// invalidated on resize. Callers that change geometry follow the measurement
// with virtualizer.measure() — the core memoizes on its own dep list, so the
// signals alone do not refresh the estimates.
const [geomInset, setGeomInset] = createSignal(null);
const [geomChrome, setGeomChrome] = createSignal(null);

export function geometryMeasured() {
  return geomInset() !== null && geomChrome() !== null;
}

export function invalidateGeometry() {
  setGeomInset(null);
  setGeomChrome(null);
  chromePx = null;
}

// Idempotent; safe on every mount/resize. colW is the scroll column's
// clientWidth — the same read estimateSize uses.
export function measureGeometry(colW) {
  if (typeof document === "undefined" || geometryMeasured()) return;
  const card = document.querySelector("#grid .card");
  const wrap = card?.querySelector(".imgwrap");
  if (!card || !wrap) return;
  const cr = card.getBoundingClientRect();
  const wr = wrap.getBoundingClientRect();
  if (!cr.height || !wr.width) return;
  setGeomInset(colW - wr.width);
  setGeomChrome(cr.height - wr.height);
}

// Blink lays out in 1/64px units — rendered rects are multiples of 1/64.
// The formula quantizes the same way so estimate === rect, exactly.
const q64 = (x) => Math.round(x * 64) / 64;

// THE one card-height formula: image box from the aspect ratio (capped at
// 16:9 — Zoomable's arStyle clamps the CSS variable the same way) + chrome.
// estimateSize calls exactly this, and the feed invariant audits against it.
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
  const failed = new Set();  // ids the loader gave up on (B8: one retry schedule)
  const retried = new Set(); // ids whose single retry already failed
  const inFlight = new Set();
  // GC guard: the Image object is the ONLY holder of the load's onload/
  // onerror — if nothing references it, the collector aborts the load
  // mid-flight and the inFlight slot leaks forever (the pump stalls at
  // MAX_INFLIGHT). Keep every loading image referenced until it settles.
  const loading = new Map();
  const [version, setVersion] = createSignal(0);
  // the bumper MUST change the value: a bare setVersion() writes undefined
  // once and then never notifies again (undefined === undefined) — every
  // downstream memo/effect silently freezes (the entire feed drain stall)
  const bump = () => setVersion((v) => v + 1);
  let retryTimer = null;

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
        retried.add(id); // exactly one retry, in ERROR_RETRY_MS (B8)
        scheduleRetry();
      }
      bump();
    };
    img.src = src;
  }

  function scheduleRetry() {
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      retried.clear(); // the retry window opens — resolveAhead re-attempts
      bump();
    }, ERROR_RETRY_MS);
  }

  // Stage off-DOM measurements for the VIEW entries in [first-BEHIND,
  // last+AHEAD] that lack dims; bounded concurrency. viewIdx is view()'s
  // index list and images come via imageAt — nothing materializes the
  // listing per call. Entries whose dims the listing or the meta already
  // carries are never measured.
  function resolveAhead(viewIdx, first, last) {
    if (!viewIdx.length) return;
    const from = Math.max(0, first - RESOLVE_BEHIND);
    const to = Math.min(viewIdx.length - 1, last + RESOLVE_AHEAD);
    for (let i = from; i <= to && inFlight.size < MAX_INFLIGHT; i++) {
      const e = imageAt(viewIdx[i]);
      if (!e) continue;
      if ((e.width && e.height) || (e.meta?.width && e.meta?.height)) continue;
      if (failed.has(e.id)) continue; // permanent — never pending, never retried
      resolve(e.id);
    }
  }

  return { sizeOf, resolveAhead, loadFailed };
}