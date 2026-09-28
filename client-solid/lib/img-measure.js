// client-solid/lib/img-measure.js — off-DOM measurement of inline images.
//
// The feed's rule, for every image box outside the feed too: a box mounts
// only at its EXACT aspect, resolved off-DOM before mount — never from the
// visible img's load (no 16:9-floor box that morphs height when the bytes
// land, no img that grows from zero). The off-DOM Image warms the browser
// cache, so the visible img that follows draws immediately.
//
// Tri-state, reactive over landings: "pending" | { w, h } | "failed".

import { createSignal } from "solid-js";

const measured = new Map();   // src -> { w, h } | null (null = failed)
const inflight = new Set();
const [measureVer, setMeasureVer] = createSignal(0);

export function measuredSrc(src) {
  measureVer();
  if (!src) return "failed";
  if (measured.has(src)) return measured.get(src) ?? "failed";
  if (inflight.has(src)) return "pending";
  inflight.add(src);
  const img = new Image();
  img.onload = () => {
    inflight.delete(src);
    measured.set(src, { w: img.naturalWidth, h: img.naturalHeight });
    setMeasureVer((v) => v + 1);
  };
  img.onerror = () => {
    inflight.delete(src);
    measured.set(src, null);
    setMeasureVer((v) => v + 1);
  };
  img.src = src;
  return "pending";
}
