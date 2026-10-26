// client-solid/store/sizes.js — every card's size is DATA, resolved before
// the card renders:
//
// a card mounts only when its size is known or terminally failed, and never
// changes height while mounted.
//
// Sources, in order: the listing's content dims (free, engine-resolved) →
// the extractor meta's dims → off-DOM Image measurement (zero layout
// effect) → a terminal 1024×1024 failure box. The virtualizer's estimateSize
// is cardHeight — exact for every mounted row, so the virtualizer never
// compensates and no timer coordinates geometry.

import { createSignal } from "solid-js";
import { mediaKind } from "/shared/backings/mime.mjs";

export const ERROR_RETRY_MS = 8000;
export const MEASURE_TIMEOUT_MS = 30000;
const FAILURE_SIZE = Object.freeze({ w: 1024, h: 1024 });
const validDims = (w, h) => Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0;
const RESOLVE_AHEAD = 30;   // entries past the visible window's tail
const RESOLVE_BEHIND = 10;  // and behind its head (when more are pending above)
const MAX_INFLIGHT = 6;     // bounded off-DOM concurrency
const MAX_BEHIND_ALL = 50;  // "resolve every pending entry above the fold" cap

// The retry scheduler lives HERE and only here: one timer; when the
// window opens the callback re-queues whatever it owns (the loader's failed
// ids, the image window's errored srcs).
let retryTimer = null;
const retryCallbacks = new Set();
export function scheduleRetry(cb) {
  if (cb) retryCallbacks.add(cb);
  if (!retryTimer) retryTimer = setTimeout(() => {
    retryTimer = null;
    const callbacks = [...retryCallbacks];
    retryCallbacks.clear();
    for (const callback of callbacks) callback();
  }, ERROR_RETRY_MS);
  return () => {
    retryCallbacks.delete(cb);
    if (!retryCallbacks.size && retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  };
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

// Blink lays out the image box in 1/64px units (its layout quantum).
const q64 = (x) => Math.round(x * 64) / 64;

// THE one card-height formula: image box from the aspect ratio (capped at
// 16:9 — Zoomable's arStyle clamps the CSS variable the same way) + chrome.
// Round the card step up to a whole CSS pixel so native scroll compensation
// and spacers are exact. Grid's CardSlot gives the card this height; its
// natural content is at most this tall. estimateSize and the feed audit use
// exactly this formula.
export function cardHeight(size, colW) {
  const ar = size.h > 0 ? size.w / size.h : 16 / 9;
  const inset = geomInset() ?? 0;
  const chrome = geomChrome() ?? chromeHeightPx();
  return Math.ceil(q64((colW - inset) / Math.min(ar, 16 / 9)) + chrome);
}

// Immutable identity-keyed offsets: old indices cannot describe old entries
// after a listing reorder. Heights include the inter-card margin.
export function feedOffsets(entries, heightOf) {
  const offsets = new Map();
  let offset = 0;
  for (const entry of entries) {
    offsets.set(entry.id, offset);
    offset += heightOf(entry);
  }
  return offsets;
}

export function makeSizes({ srcFor, imageAt, entryFor = () => null, identityFor = (id) => id }) {
  // the chrome height is read HERE (store creation — the CSS is applied by
  // now; never at module import) and re-read on every resize: it is the one
  // cardHeight input that can change without any entry changing
  chromeHeightPx();
  const resize = () => { chromePx = null; chromeHeightPx(); };
  if (typeof window !== "undefined") window.addEventListener("resize", resize);
  const sizes = new Map();   // id -> { w, h }
  const failed = new Set();  // ids the loader gave up on (one retry schedule)
  const retried = new Set(); // ids that have consumed their first attempt
  const waiting = new Set(); // first failures waiting for the shared retry deadline
  const queued = new Set();  // retained interest drains even when no card can mount
  const deadlines = new Map();
  const inFlight = new Set();
  // GC guard: the Image object is the ONLY holder of the load's onload/
  // onerror — if nothing references it, the collector aborts the load
  // mid-flight and the inFlight slot leaks forever ( stalls at
  // MAX_INFLIGHT). Keep every loading image referenced until it settles.
  const loading = new Map();
  const identities = new Map();
  let context = null, disposed = false;
  let cancelRetry = null;
  const retrySizes = () => {
    cancelRetry = null;
    if (disposed) return;
    for (const id of waiting) queued.add(id);
    waiting.clear();
    drain();
    bump();
  };
  const [version, setVersion] = createSignal(0);
  // the bumper MUST change the value: a bare setVersion writes undefined
  // once and then never notifies again (undefined === undefined) — every
  // downstream memo/effect silently freezes (the entire feed drain stall)
  const bump = () => setVersion((v) => v + 1);

  // identityFor: null retires an entry; "" means its hash is not known yet.
  // Learning the first hash enriches the same content, matching inventory
  // reconciliation. Only a change between known hashes retires measurements.
  function matchesIdentity(id, identity = identityFor(id)) {
    if (!identities.has(id)) return false;
    if (identities.get(id) === "" && typeof identity === "string" && identity !== "") identities.set(id, identity);
    return identities.get(id) === identity;
  }

  // reactive read: sizeOf subscribes to landings
  const sizeOf = (id) => { version(); return matchesIdentity(id) ? sizes.get(id) ?? null : null; };

  function loadFailed(id) {
    version();
    return matchesIdentity(id) && failed.has(id);
  }

  // One size derivation for feed membership, pending counts and card geometry.
  // A terminal box stays square even if metadata arrives after it mounted.
  function sizeFor(entry) {
    if (!entry) return null;
    if (loadFailed(entry.id)) return sizeOf(entry.id);
    if (validDims(entry.width, entry.height)) return { w: entry.width, h: entry.height };
    if (validDims(entry.meta?.width, entry.meta?.height)) return { w: entry.meta.width, h: entry.meta.height };
    return sizeOf(entry.id);
  }

  function retireImage(id) {
    clearTimeout(deadlines.get(id)); deadlines.delete(id);
    const image = loading.get(id);
    if (image) {
      image.onload = null; image.onerror = null;
      image.onloadedmetadata = null;
      if (image.tagName === "VIDEO") image.pause();
      image.removeAttribute("src");
      if (image.tagName === "VIDEO") image.load();
      loading.delete(id);
    }
    inFlight.delete(id);
  }

  function setContext(next) {
    if (context === next && !disposed) return;
    context = next;
    cancelRetry?.(); cancelRetry = null;
    for (const id of [...loading.keys()]) retireImage(id);
    sizes.clear(); failed.clear(); retried.clear(); waiting.clear(); queued.clear(); identities.clear();
    bump();
  }

  function reconcileIdentity(id) {
    const identity = identityFor(id);
    if (!matchesIdentity(id, identity)) {
      retireImage(id); sizes.delete(id); failed.delete(id); retried.delete(id); waiting.delete(id);
      identities.set(id, identity);
    }
    return identity;
  }

  function resolve(id) {
    if (disposed || typeof Image === "undefined") return; // headless (unit tests)
    const identity = reconcileIdentity(id), owner = context;
    if (identity == null) return;
    if (sizes.has(id) || inFlight.has(id) || waiting.has(id)) return;
    if (sizeFor(entryFor(id)) !== null) return;
    const src = srcFor(id);
    if (!src) { sizes.set(id, FAILURE_SIZE); failed.add(id); bump(); return; }
    inFlight.add(id);
    let img;
    const fail = () => {
      // Engine dimensions may have made the card ready during this attempt.
      // Settle with those dimensions, never resize that card into a fallback.
      const known = sizeFor(entryFor(id));
      retireImage(id);
      if (known) {
        sizes.set(id, known);
      } else if (retried.has(id)) {
        sizes.set(id, FAILURE_SIZE);
        failed.add(id);
      } else {
        retried.add(id);
        waiting.add(id);
        cancelRetry = scheduleRetry(retrySizes);
      }
      bump();
      drain();
    };
    const video = mediaKind(entryFor(id)?.filename ?? entryFor(id)?.name) === "video";
    try {
      img = video ? document.createElement("video") : new Image();
      if (video) img.preload = "metadata";
    } catch { fail(); return; }
    loading.set(id, img);
    const current = () => !disposed && context === owner && loading.get(id) === img && matchesIdentity(id);
    const loaded = () => {
      if (!current()) return;
      const w = video ? img.videoWidth : img.naturalWidth, h = video ? img.videoHeight : img.naturalHeight;
      if (!validDims(w, h)) { fail(); return; }
      sizes.set(id, { w, h });
      retireImage(id);
      bump();
      drain();
    };
    if (video) img.onloadedmetadata = loaded; else img.onload = loaded;
    img.onerror = () => {
      if (!current()) return;
      fail();
    };
    deadlines.set(id, setTimeout(() => {
      if (current()) fail();
      else if (loading.get(id) === img) { reconcileIdentity(id); drain(); }
    }, MEASURE_TIMEOUT_MS));
    try { img.src = src; } catch { if (current()) fail(); }
  }

  let draining = false;
  function drain() {
    if (disposed || draining) return;
    draining = true;
    try {
      for (const id of queued) {
        if (inFlight.size >= MAX_INFLIGHT) break;
        queued.delete(id);
        resolve(id);
      }
    } finally { draining = false; }
  }

  // Stage off-DOM measurements for VIEW entries around the visible window;
  // bounded concurrency. BEHIND FIRST: an entry above the viewport whose
  // size lands inserts a card above the fold — when the pending-above count
  // is small (≤ 50) every one of them resolves before anything below, so
  // the common case never has pending entries above the fold. viewIdx is
  // view's index list and images come via imageAt — nothing materializes
  // the listing per call.
  function resolveAhead(viewIdx, first, last) {
    // Retire old content BEFORE capacity is tested: otherwise six stale
    // slots can make identity reconciliation in resolve unreachable.
    for (const id of loading.keys()) reconcileIdentity(id);
    if (!viewIdx.length) return;
    let pendingAbove = 0;
    for (let i = 0; i < first; i++) {
      const e = imageAt(viewIdx[i]);
      if (e && sizeFor(e) === null) pendingAbove++;
    }
    const behind = pendingAbove <= MAX_BEHIND_ALL ? first : RESOLVE_BEHIND;
    const from = Math.max(0, first - behind);
    const to = Math.min(viewIdx.length - 1, last + RESOLVE_AHEAD);
    const stage = (i) => {
      const e = imageAt(viewIdx[i]);
      if (!e || sizeFor(e) !== null) return;
      queued.add(e.id);
    };
    for (let i = from; i < first; i++) stage(i);
    for (let i = first; i <= to; i++) stage(i);
    drain();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (typeof window !== "undefined") window.removeEventListener("resize", resize);
    setContext(null);
  }

  return { sizeOf, sizeFor, resolveAhead, loadFailed, setContext, dispose };
}
