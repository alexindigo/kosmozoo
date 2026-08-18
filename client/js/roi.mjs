// client/js/roi.mjs — Attention (ROI) axis: guides + region focus.
//
// Manual-first (spec §1): detection contributes optional presets when it
// happens to work, but the foundation is the user's hand. Guides persist
// globally, not per-image (harvest #12) — which is precisely why they work
// as a persistent ROI marker. ROI is in box-fractions, so once the pair is
// registered an ROI applies to both images automatically.

import { S, render } from "./state.mjs";
import { api } from "./api.mjs";

const GUIDES_KEY = "core.guides";

export async function initRoi() {
  S.guides = (await api.settings(GUIDES_KEY).catch(() => ({})))?.list ?? [];
}

// --- guides (persistent, global) -------------------------------------------

export async function addGuide(axis, pos) {
  S.guides.push({ axis, pos });
  await api.setSettings(GUIDES_KEY, { list: S.guides }).catch(() => {});
  render();
}

export async function clearGuides() {
  S.guides = [];
  await api.setSettings(GUIDES_KEY, { list: [] }).catch(() => {});
  render();
}

// --- ROI (box-fractions, manual-first) -------------------------------------

export function setRoi(fx, fy, fw, fh) {
  S.roi = fw > 0 && fh > 0 ? { fx, fy, fw, fh } : null;
  render();
}

export function clearRoi() {
  S.roi = null;
  render();
}

// Zoom the lightbox view to frame the ROI. Both images share registration
// once aligned, so framing the ROI frames it on both.
export function zoomToRoi(view) {
  if (!S.roi) return view;
  const { fx, fy, fw, fh } = S.roi;
  return {
    ...view,
    s: 1 / Math.max(fw, fh),
    txf: -(fx + fw / 2 - 0.5),
    tyf: -(fy + fh / 2 - 0.5),
  };
}
