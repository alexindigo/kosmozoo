// client/js/views.mjs — per-image view state: one store, debounced
// persistence. Both consumers (in-feed zoom, lightbox) share it, so a crop
// made in the feed carries into the lightbox and back.
//
// Keys are image ids ("host:filename") for candidates, "anchor:<name>" for
// anchors. Box-fraction units (see geometry.mjs). Default-absent: an
// untouched view is absent, not a default object.

import { api } from "./api.mjs";

const views = new Map();   // key -> { s, txf, tyf, fh, fv, rot }
const dirty = new Set();
let timer = null;

export async function initViews() {
  const stored = await api.settings("core.views").catch(() => ({}));
  for (const [k, v] of Object.entries(stored)) if (v) views.set(k, v);
}

export function getView(key) {
  return views.get(key) ?? null;
}

export function setView(key, v) {
  if (v) views.set(key, v); else views.delete(key);
  dirty.add(key);
  clearTimeout(timer);
  timer = setTimeout(flushViews, 400);
}

export async function flushViews() {
  clearTimeout(timer);
  if (!dirty.size) return;
  const patch = {};
  for (const k of dirty) patch[k] = views.get(k) ?? null;
  dirty.clear();
  await api.setSettings("core.views", patch).catch(() => {});
}
