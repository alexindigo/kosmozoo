// client-solid/store/sizes.js — every card's size is DATA, resolved before
// the card renders:
//
// a card mounts only when its size is known or terminally failed, and never
// changes height while mounted.
//
// Sources, in order: the listing's content dims (free, engine-resolved) →
// the extractor meta's dims → off-DOM per-kind measurement (zero layout
// effect) → a terminal 1024×1024 failure box. Audio needs no measurement,
// using its fixed 1024×160 strategy. The virtualizer's estimateSize
// is cardHeight — exact for every mounted row, so the virtualizer never
// compensates and no timer coordinates geometry.

import { createSignal } from "solid-js";
import { mediaKind } from "/shared/backings/mime.mjs";
import { mediaGeometry, AUDIO_SIZE } from "./media-geometry.js";
import { makeAcquisition } from "./acquisition.js";
import { makeImageMeasurements, validDims } from "../lib/img-measure.js";
export { scheduleRetry, ERROR_RETRY_MS, MEASURE_TIMEOUT_MS } from "../lib/img-measure.js";
const RESOLVE_AHEAD = 30;   // entries past the visible window's tail
const RESOLVE_BEHIND = 10;  // and behind its head (when more are pending above)
const MAX_BEHIND_ALL = 50;  // "resolve every pending entry above the fold" cap

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
const [geomControls, setGeomControls] = createSignal(0);

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
  setGeomControls(probe.querySelector(".media-controls")?.getBoundingClientRect().height ?? 0);
}

// Blink lays out the image box in 1/64px units (its layout quantum).
const q64 = (x) => Math.round(x * 64) / 64;

// THE one card-height formula: the shared media model + an in-flow playable
// controls row + measured chrome. Natural dimensions are never discarded.
// Round the card step up to a whole CSS pixel so native scroll compensation
// and spacers are exact. Grid's CardSlot gives the card this height; its
// natural content is at most this tall. estimateSize and the feed audit use
// exactly this formula.
export function cardHeight(size, colW) {
  const inset = geomInset() ?? 0;
  const chrome = geomChrome() ?? chromeHeightPx();
  const box = mediaGeometry({ width: colW - inset, size });
  const controls = size.kind === "video" || size.kind === "audio" ? geomControls() : 0;
  return Math.ceil(q64(box.height) + controls + chrome);
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

// The entry under a scroll position in one identity-keyed layout: each entry
// spans from its offset to the next one's, so it is the last entry whose
// offset is at or above `top` (the first entry when `top` precedes them all).
// order lists the layout's ids in feed order; offsets is its feedOffsets map.
export function feedEntryAtOffset(order, offsets, top) {
  let lo = 0, hi = order.length - 1, found = order[0] ?? null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offsets.get(order[mid]) <= top) { found = order[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

const entryKind = (entry) => mediaKind(entry?.filename ?? entry?.name) ?? "image";
const entryDims = (entry) => !entry ? null
  : validDims(entry.width, entry.height) ? { w: entry.width, h: entry.height }
  : validDims(entry.meta?.width, entry.meta?.height) ? { w: entry.meta.width, h: entry.meta.height }
  : null;

// acquisition is the Store's one admission policy. A standalone size owner
// has no viewport projection to rank candidates by, so its private policy
// admits every staged candidate in the foreground lane (six resource slots).
export function makeSizes({ acquisition, srcFor, imageAt, entryFor = () => null, identityFor = (id) => id }) {
  const ownedAcquisition = acquisition ? null : makeAcquisition({ fallbackPriority: "foreground" });
  acquisition ??= ownedAcquisition;
  // the chrome height is read HERE (store creation — the CSS is applied by
  // now; never at module import) and re-read on every resize: it is the one
  // cardHeight input that can change without any entry changing
  chromeHeightPx();
  const resize = () => { chromePx = null; chromeHeightPx(); };
  if (typeof window !== "undefined") window.addEventListener("resize", resize);
  const measurements = makeImageMeasurements({ acquisition, srcFor, identityFor,
    kindOf: (id) => entryKind(entryFor(id)), knownSize: (id) => entryDims(entryFor(id)) });
  const { sizeOf, loadFailed } = measurements;
  let disposed = false;

  // One size derivation for feed membership, pending counts and card geometry.
  // A terminal box stays square even if metadata arrives after it mounted.
  function sizeFor(entry) {
    if (!entry) return null;
    const kind = entryKind(entry);
    if (kind === "audio") return AUDIO_SIZE;
    const failed = loadFailed(entry.id);
    const size = failed ? sizeOf(entry.id) : entryDims(entry) ?? sizeOf(entry.id);
    return size ? { ...size, ...(kind === "video" ? { kind } : {}), ...(failed ? { failed: true } : {}) } : null;
  }

  // Enumerate VIEW candidates behind first to keep above-fold insertions
  // moving: when the pending-above count is small (<= 50) every one of them
  // is staged before anything below. This is candidate order, not an
  // independent admission window: the shared policy starts foreground
  // identities first, bounds idle background resources and retains staged
  // interest until it drains, even when no card can mount.
  function resolveAhead(viewIdx, first, last) {
    // Retire old content before the shared capacity gate can block it.
    measurements.reconcile();
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
      measurements.request(e.id);
    };
    for (let i = from; i < first; i++) stage(i);
    for (let i = first; i <= to; i++) stage(i);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (typeof window !== "undefined") window.removeEventListener("resize", resize);
    measurements.dispose();
    ownedAcquisition?.dispose();
  }

  return { ...measurements, sizeFor, resolveAhead, dispose };
}
