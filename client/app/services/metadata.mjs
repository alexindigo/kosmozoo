// client/app/services/metadata.mjs — the metadata channel: poll + patch in
// place + scroll-driven wants. (Moved verbatim from main.mjs; the legacy feed
// still drives it through wantMeta/pollMetadata/refreshAllCardMeta.)

import { state, render } from "../../js/state.mjs";
import { api } from "../../js/api.mjs";
import { chrome } from "../../js/chrome.mjs";
import { cardAt, eachCard } from "../../js/feed.mjs";

let metaVersion = 0;
let metaPending = 0;
let metaPollTimer = null;
const wantSet = new Set();
let wantTimer = null;

export function wantMeta(image) {
  if (image.meta || wantSet.has(image.filename)) return;
  wantSet.add(image.filename);
  clearTimeout(wantTimer);
  wantTimer = setTimeout(flushWant, 1500);
}

async function flushWant() {
  if (!state.host) return;
  const files = [...wantSet];
  wantSet.clear();
  if (!files.length) return;
  try {
    const r = await api.metaWant(state.host, files);
    if (typeof r.pending === "number") {
      metaPending = r.pending;
      updateScanChip();
      if (metaPending > 0) scheduleMetaPoll();
    }
  } catch { /* next render re-wants */ }
}

function scheduleMetaPoll(delay = 5000) {
  clearTimeout(metaPollTimer);
  metaPollTimer = setTimeout(pollMetadata, delay);
}

export async function pollMetadata() {
  if (!state.host) return;
  try {
    const r = await api.metadata(state.host);
    metaPending = r.pending ?? 0;
    updateScanChip();
    if (r.v !== metaVersion) {
      metaVersion = r.v;
      mergeMetadata(r.items ?? {});
    }
  } catch { /* transient; next poll retries */ }
  if (metaPending > 0) scheduleMetaPoll();
}

// A card rendered before its metadata arrived gets patched in place —
// through the instance's own setMeta, never by reaching into its DOM.
function mergeMetadata(items) {
  for (const [name, meta] of Object.entries(items)) {
    const idx = state.images.findIndex((i) => i.filename === name);
    if (idx < 0) continue;
    if (!state.images[idx].meta) state.images[idx].meta = meta;
    const card = cardAt(idx);
    if (card) card.setMeta(meta);
  }
}

function updateScanChip() {
  if (metaPending > 0) chrome.status.active("meta", `metadata scan — ${metaPending} left`);
  else chrome.status.clear("meta");
}

// Picker changes re-apply to every rendered card through the instances' own
// setMeta — the parent orchestrates; nobody reaches into a card's DOM.
export function refreshAllCardMeta() {
  eachCard((handle, idx) => handle.setMeta(state.images[idx]?.meta ?? null));
  if (state.lightbox.open) render();
}
