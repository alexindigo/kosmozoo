// client/app/services/metadata.mjs — the metadata channel: poll + patch in
// place + scroll-driven wants. (Moved verbatim from main.mjs; the legacy feed
// still drives it through wantMeta/pollMetadata/refreshAllCardMeta.)

import { state, render } from "../../js/state.mjs";
import { api } from "../../js/api.mjs";
import { chrome } from "../../js/chrome.mjs";

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

// A card rendered before its metadata arrived picks it up declaratively: the
// engine writes image.meta and re-renders; <Card>/<MetaBar> read it.
function mergeMetadata(items) {
  let changed = false;
  for (const [name, meta] of Object.entries(items)) {
    const idx = state.images.findIndex((i) => i.filename === name);
    if (idx < 0) continue;
    if (!state.images[idx].meta) {
      state.images[idx].meta = meta;
      changed = true;
    }
  }
  if (changed) render();
}

function updateScanChip() {
  if (metaPending > 0) chrome.status.active("meta", `metadata scan — ${metaPending} left`);
  else chrome.status.clear("meta");
}

// Picker changes re-apply to every card declaratively: a re-render makes each
// <MetaBar> re-read image.meta against the new fields config.
export function refreshAllCardMeta() {
  render();
}
