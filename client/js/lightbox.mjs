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
import { cycleAxis } from "./axes.mjs";
import { zoomToRoi } from "./roi.mjs";
import { prefetchFrom, applyWindow } from "./volume.mjs";
import { applyComposition } from "./plugins-client.mjs";

const $ = (id) => document.getElementById(id);

// Per-image persisted views (box-fractions), keyed "host:filename".
const viewStoreKey = "core.views";
let persistedViews = {};

export async function initLightbox() {
  persistedViews = await api.settings(viewStoreKey).catch(() => ({}));
  document.addEventListener("keydown", onKey);
  // Detector status drives the face-anchored alignment need (absent ≠ broken).
  try {
    const plugins = await api.plugins();
    if (plugins.some((p) => p.name === "detector")) {
      const r = await fetch("/api/plugins/detector/status");
      S.detector = await r.json();
    }
  } catch {
    S.detector = { state: "absent" };
  }
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
  await applyComp(); // column visibility is the composition mode's business
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
  await applyComp(); // visibility is the composition mode's business
  render();
}

function currentBox(img) {
  const nw = img?.naturalWidth || 1, nh = img?.naturalHeight || 1;
  const winW = window.innerWidth, winH = window.innerHeight;
  const scale = Math.min(winW / nw, winH / nh, 1) || 1;
  return { w: nw * scale, h: nh * scale };
}

// Blink: Left/Right alternates candidate ↔ anchor.
// c/a cycle the composition/alignment axes (keys are the primary input);
// r frames the ROI.
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
    case "c":
      e.preventDefault(); cycleAxis("composition"); applyComp(); break;
    case "a":
      e.preventDefault(); cycleAxis("alignment"); break;
    case "r":
      e.preventDefault();
      if (S.roi) { S.lightbox.view = zoomToRoi(S.lightbox.view); applyView(); }
      break;
    case "Escape":
      e.preventDefault(); await close(); break;
  }
}

// Apply the current view transform to the visible column's image.
function applyView() {
  const el = S.lightbox.col === "anchor" ? $("lbAnchor") : $("lbCandidate");
  if (el?.src) {
    el.style.transform = transform(S.lightbox.view, currentBox(el));
  }
}

// Composition modes composite the pair; flicker (default) shows one column.
async function applyComp() {
  const cand = $("lbCandidate"), anch = $("lbAnchor");
  const mode = S.axes.composition;
  if (mode === "flicker") {
    // one column visible — blink territory
    cand.style.mixBlendMode = "";
    cand.style.clipPath = "none";
    cand.style.opacity = S.lightbox.col === "candidate" ? "1" : "0";
    anch.style.opacity = S.lightbox.col === "anchor" ? "1" : "0";
    return;
  }
  if (!anchorImage()) return; // composite modes need an anchor
  // both visible: anchor is the underlay, candidate takes the mode's blend
  anch.style.opacity = "1";
  anch.style.transform = transform(S.lightbox.view, currentBox(anch));
  if (mode === "blend") {
    cand.style.mixBlendMode = "";
    cand.style.clipPath = "none";
    cand.style.opacity = "0.5";
  } else if (mode === "split") {
    cand.style.mixBlendMode = "";
    cand.style.opacity = "1";
    cand.style.clipPath = "inset(0 0 0 50%)"; // right half candidate
  } else {
    // plugin-provided modes (difference, …) via the client registry
    await applyComposition(mode, cand, anch);
  }
  render();
}

// harvest #2 on navigation too: write back before moving. The window
// follows the keyboard; prefetch warms the direction of travel.
async function step(dir) {
  await writeBack();
  const next = S.lightbox.index + dir;
  if (next < 0 || next >= S.images.length) return;
  S.lightbox.index = next;
  S.lightbox.col = "candidate";
  readBack();
  prefetchFrom(next, dir);
  applyWindow();
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
