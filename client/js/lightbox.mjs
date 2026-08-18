// client/js/lightbox.mjs — the comparison workbench: lightbox + blink.
//
// The product. Blink navigation: Left/Right alternates candidate ↔ anchor at
// identical registration. Three harvested guards make it work:
//   #1 load-generation guard — a stale load must never overwrite the view
//   #2 write outgoing state back BEFORE reading the incoming one
//   #3 hold the outgoing frame until the incoming image has loaded
//   #4 derived state (face-aligned view) never persists over its source

import { S, render } from "./state.mjs";
import { api } from "./api.mjs";
import { freshView, transform, viewToPersisted, viewFromPersisted } from "./geometry.mjs";

const $ = (id) => document.getElementById(id);

// Per-image persisted views (box-fractions), keyed "host:filename".
const viewStoreKey = "core.views";
let persistedViews = {};

export async function initLightbox() {
  persistedViews = await api.settings(viewStoreKey).catch(() => ({}));
  document.addEventListener("keydown", onKey);
}

function currentImage() {
  return S.images[S.lightbox.index] ?? null;
}

function anchorImage() {
  return S.anchors[S.lightbox.anchorIndex ?? 0] ?? null;
}

function activeKey() {
  if (S.lightbox.col === "anchor") {
    const a = anchorImage();
    return a ? `anchor:${a.name}` : null;
  }
  const img = currentImage();
  return img ? img.id : null;
}

function activeSrc() {
  if (S.lightbox.col === "anchor") {
    return anchorImage()?.src ?? null;
  }
  const img = currentImage();
  return img ? api.imageBytesUrl(img.id) : null;
}

// harvest #2: write the outgoing view back BEFORE reading the incoming one.
async function writeBack() {
  const key = activeKey();
  if (!key) return;
  const p = viewToPersisted(S.lightbox.view);
  if (p) persistedViews[key] = p; else delete persistedViews[key];
  await api.setSettings(viewStoreKey, { [key]: p ?? null }).catch(() => {});
}

function readBack() {
  const key = activeKey();
  const stored = key ? persistedViews[key] : null;
  // harvest #4: read from the persisted *source*; derived (face-aligned)
  // views are recomputed, never persisted over the source.
  S.lightbox.view = viewFromPersisted(stored) ?? freshView();
}

// Shared-view axis: the candidate/anchor pair shares one registration when
// alignment is "shared" — view carries over unchanged across a column switch
// (blink mechanism #1). Independent: each column keeps its own.
async function switchColumn() {
  const shared = S.axes.alignment !== "independent";
  if (!shared) await writeBack();
  S.lightbox.col = S.lightbox.col === "candidate" ? "anchor" : "candidate";
  if (!shared) readBack();
  // shared: leave S.lightbox.view untouched — identical registration.
  render();
}

// harvest #1 + #3: load with a generation guard; hold the outgoing frame
// until the incoming image has loaded (no flash during the swap).
export async function lbShow() {
  const lb = $("lightbox");
  const gen = ++S.lightbox.loadGen;
  const src = activeSrc();
  if (!src) { lb.hidden = true; return; }
  lb.hidden = false;

  const el = S.lightbox.col === "anchor" ? $("lbAnchor") : $("lbCandidate");
  const other = S.lightbox.col === "anchor" ? $("lbCandidate") : $("lbAnchor");

  // Preload off-DOM; only swap once decoded (cover the swap).
  const img = new Image();
  img.src = src;
  try {
    await img.decode();
  } catch {
    // keep showing the outgoing frame on failure
  }
  if (gen !== S.lightbox.loadGen) return; // a newer navigation superseded us
  el.src = src;
  el.style.transform = transform(S.lightbox.view, currentBox(img));
  other.style.opacity = "0";
  el.style.opacity = "1";
  render();
}

function currentBox(img) {
  const nw = img?.naturalWidth || 1, nh = img?.naturalHeight || 1;
  const winW = window.innerWidth, winH = window.innerHeight;
  const scale = Math.min(winW / nw, winH / nh, 1) || 1;
  return { w: nw * scale, h: nh * scale };
}

// Blink: Left/Right alternates candidate ↔ anchor.
async function onKey(e) {
  if (!S.lightbox.open) return;
  switch (e.key) {
    case "ArrowLeft":
    case "ArrowRight":
      if (S.anchors.length) { e.preventDefault(); await switchColumn(); }
      break;
    case "ArrowUp":
      e.preventDefault(); await step(-1); break;
    case "ArrowDown":
      e.preventDefault(); await step(1); break;
    case "Escape":
      e.preventDefault(); await close(); break;
  }
}

// harvest #2 on navigation too: write back before moving.
async function step(dir) {
  await writeBack();
  const next = S.lightbox.index + dir;
  if (next < 0 || next >= S.images.length) return;
  S.lightbox.index = next;
  S.lightbox.col = "candidate";
  readBack();
  await lbShow();
}

export async function openAt(index) {
  S.lightbox.open = true;
  S.lightbox.index = index;
  S.lightbox.col = "candidate";
  readBack();
  await lbShow();
}

export async function close() {
  await writeBack();
  S.lightbox.open = false;
  $("lightbox").hidden = true;
  render();
}
