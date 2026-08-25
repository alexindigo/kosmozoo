// client/js/lightbox.mjs — the comparison workbench: lightbox + blink.
//
// The product. Blink navigation: Left/Right alternates candidate ↔ anchor at
// identical registration. Three harvested guards make it work:
//   #1 load-generation guard — a stale load must never overwrite the view
//   #2 write outgoing state back BEFORE reading the incoming one
//   #3 hold the outgoing frame until the incoming image has loaded
//   #4 derived state (face-aligned view) never persists over its source

import { state, render } from "./state.mjs";
import { api } from "./api.mjs";
import { freshView, transform, viewToPersisted, viewFromPersisted } from "./geometry.mjs";
import { cycleAxis } from "./axes.mjs";
import { zoomToRoi } from "./roi.mjs";
import { prefetchFrom, applyWindow, restoreToIndex } from "./feed.mjs";
import { browseToFile, stripHostPrefix, findByFile, parseUrl } from "./route.mjs";
import { applyComposition } from "./plugins-client.mjs";
import { setVote, toggleFavorite } from "./judgment.mjs";
import { getView, setView, flushViews } from "./views.mjs";
import { chrome } from "./chrome.mjs";

const $ = (id) => document.getElementById(id);

// Per-image persisted views live in views.mjs (shared with in-feed zoom).

export async function initLightbox() {
  document.addEventListener("keydown", onKey);
  let raf = 0;
  window.addEventListener("resize", () => {
    if (!state.lightbox.open || raf) return;
    raf = requestAnimationFrame(() => { raf = 0; relayout(); });
  });
  // Detector status drives the face-anchored alignment need (absent ≠ broken).
  try {
    const plugins = await api.plugins();
    if (plugins.some((p) => p.name === "detector")) {
      const r = await fetch("/api/plugins/detector/status");
      state.detector = await r.json();
    }
  } catch {
    state.detector = { state: "absent" };
  }
}

function lightboxCandidate() {
  return state.images[state.lightbox.index] ?? null;
}

// The imgs' load event, forwarded by <Lightbox>. Tracks natural dims in the
// dataset (a fresh src swap has naturalWidth 0 until decoded) and re-fits.
export function noteImgLoad(el) {
  el.dataset.nw = el.naturalWidth;
  el.dataset.nh = el.naturalHeight;
  if (state.lightbox.open) relayout();
}

function anchorImage() {
  return state.anchors[state.lightbox.anchorIndex ?? 0] ?? null;
}

function activeKey() {
  if (state.lightbox.col === "anchor") {
    const a = anchorImage();
    return a ? `anchor:${a.name}` : null;
  }
  const img = lightboxCandidate();
  return img ? img.id : null;
}

function activeSrc() {
  if (state.lightbox.col === "anchor") {
    return anchorImage()?.src ?? null;
  }
  const img = lightboxCandidate();
  return img ? api.imageBytesUrl(img.id) : null;
}

// harvest #2: write the outgoing view back BEFORE reading the incoming one.
// harvest #2: write the outgoing view back BEFORE reading the incoming one.
// Debounced: the map updates immediately; the engine write batches (400ms),
// so per-step navigation costs no network round trip. Closing flushes.
async function writeBack() {
  const key = activeKey();
  if (!key) return;
  setView(key, viewToPersisted(state.lightbox.view)); // debounced inside views.mjs
}

function readBack() {
  const key = activeKey();
  const stored = key ? getView(key) : null;
  // harvest #4: read from the persisted *source*; derived (face-aligned)
  // views are recomputed, never persisted over the source.
  state.lightbox.view = viewFromPersisted(stored) ?? freshView();
}

// Shared-view axis: the candidate/anchor pair shares one registration when
// alignment is "shared" — view carries over unchanged across a column switch
// (blink mechanism #1). Independent: each column keeps its own.
async function switchColumn() {
  const shared = state.axes.alignment !== "independent";
  if (!shared) await writeBack();
  state.lightbox.col = state.lightbox.col === "candidate" ? "anchor" : "candidate";
  if (!shared) readBack();
  // shared: leave state.lightbox.view untouched — identical registration.
  // lbShow loads the incoming column's src (generation-guarded), applies the
  // view, and lets the composition mode decide visibility.
  await lbShow();
}

// harvest #1 + #3: load with a generation guard; hold the outgoing frame
// until the incoming image has loaded (no flash during the swap).
export async function lbShow() {
  const lb = $("lightbox");
  const gen = ++state.lightbox.loadGen;
  const src = activeSrc();
  if (!src) { state.lightbox.open = false; lb.hidden = true; return; }
  lb.hidden = false;

  const el = state.lightbox.col === "anchor" ? $("lbAnchor") : $("lbCandidate");

  // Preload off-DOM; only swap once decoded (cover the swap). Slow hosts get
  // a loading chip rather than a black screen.
  chrome.status.active("lb-load", "loading image…");
  const img = new Image();
  img.src = src;
  try {
    await img.decode();
  } catch {
    // keep showing the outgoing frame on failure
  }
  chrome.status.clear("lb-load");
  if (gen !== state.lightbox.loadGen) return; // a newer navigation superseded us
  if (el.dataset.cur !== src) { el.src = src; el.dataset.cur = src; }
  el.dataset.nw = img.naturalWidth;
  el.dataset.nh = img.naturalHeight;
  el.style.transform = transform(state.lightbox.view, sizeTo(el));
  await applyComp(); // visibility is the composition mode's business
  render();
  // user-driven navigation names the shown candidate in the URL; the
  // anchor column keeps the last candidate's address
  if (state.lightbox.col === "candidate") {
    const img = lightboxCandidate();
    if (img) browseToFile(stripHostPrefix(state.host, img.filename));
  }
}

// fit-to-screen box (upscales small images too — the view transform's
// own s multiplies on top, so s=1 always means "fitted")
function currentBox(img) {
  const nw = img?.naturalWidth || 1, nh = img?.naturalHeight || 1;
  const winW = window.innerWidth, winH = window.innerHeight;
  const scale = Math.min(winW / nw, winH / nh) || 1;
  return { w: nw * scale, h: nh * scale };
}

// layout size IS the fit box; the transform only carries the user view.
// Natural dims come from the load-tracked dataset (a fresh src swap has
// naturalWidth 0 until decoded).
function sizeTo(el) {
  const box = currentBox({
    naturalWidth: Number(el.dataset.nw) || el.naturalWidth,
    naturalHeight: Number(el.dataset.nh) || el.naturalHeight,
  });
  el.style.width = box.w + "px";
  el.style.height = box.h + "px";
  return box;
}

function relayout() {
  applyView();
  applyComp();
}

// Blink: Left/Right alternates candidate ↔ anchor.
// c/a cycle the composition/alignment axes (keys are the primary input);
// r frames the ROI.
async function onKey(e) {
  if (!state.lightbox.open) return;
  if (state.diff.open) return; // the diff view owns the keyboard
  if (state.keysPanelOpen || state.capturing) return; // the keys panel outranks
  switch (e.key) {
    case "ArrowLeft":
    case "ArrowRight":
      if (state.anchors.length) { e.preventDefault(); await switchColumn(); }
      break;
    case "ArrowUp":
      e.preventDefault(); await step(-1); break;
    case "ArrowDown":
      e.preventDefault(); await step(1); break;
    case "c":
      e.preventDefault(); cycleAxis("composition"); applyComp(); break;
    case "a":
      e.preventDefault(); cycleAxis("alignment"); break;
    case "u":
      e.preventDefault();
      await setVote(lightboxCandidate(), lightboxCandidate()?.judgment?.vote === "up" ? null : "up");
      break;
    case "d":
      e.preventDefault();
      await setVote(lightboxCandidate(), lightboxCandidate()?.judgment?.vote === "down" ? null : "down");
      break;
    case "f":
      e.preventDefault();
      await toggleFavorite(lightboxCandidate());
      break;
    case "r":
      e.preventDefault();
      if (state.roi) { state.lightbox.view = zoomToRoi(state.lightbox.view); applyView(); }
      break;
    case "Escape":
      e.preventDefault(); await close(); break;
  }
}

// Apply the current view transform to the visible column's image.
function applyView() {
  const el = state.lightbox.col === "anchor" ? $("lbAnchor") : $("lbCandidate");
  if (el?.src) {
    el.style.transform = transform(state.lightbox.view, sizeTo(el));
  }
}

// Composition modes composite the pair; flicker (default) shows one column.
async function applyComp() {
  const cand = $("lbCandidate"), anch = $("lbAnchor");
  const mode = state.axes.composition;
  const candImg = lightboxCandidate();
  const anchImg = anchorImage();
  const candSrc = candImg ? api.imageBytesUrl(candImg.id) : null;
  const anchSrc = anchImg?.src ?? null;
  if (mode === "flicker") {
    // one column visible — blink territory; src handled by lbShow
    cand.style.mixBlendMode = "";
    cand.style.clipPath = "none";
    cand.style.opacity = state.lightbox.col === "candidate" ? "1" : "0";
    anch.style.opacity = state.lightbox.col === "anchor" ? "1" : "0";
    return;
  }
  if (!anchSrc) return; // composite modes need an anchor
  // both visible: anchor is the underlay, candidate takes the mode's blend
  if (anch.dataset.cur !== anchSrc) { anch.src = anchSrc; anch.dataset.cur = anchSrc; }
  if (candSrc && cand.dataset.cur !== candSrc) { cand.src = candSrc; cand.dataset.cur = candSrc; }
  anch.style.opacity = "1";
  cand.style.opacity = "1";
  anch.style.transform = transform(state.lightbox.view, sizeTo(anch));
  cand.style.transform = transform(state.lightbox.view, sizeTo(cand));
  if (mode === "blend") {
    cand.style.mixBlendMode = "";
    cand.style.clipPath = "none";
    cand.style.opacity = "0.5";
  } else if (mode === "split") {
    cand.style.mixBlendMode = "";
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
  const next = state.lightbox.index + dir;
  if (next < 0 || next >= state.images.length) return;
  state.lightbox.index = next;
  state.lightbox.col = "candidate";
  browseToFile(stripHostPrefix(state.host, state.images[next].filename));
  readBack();
  prefetchFrom(next, dir);
  applyWindow();
  await lbShow();
}

export async function openAt(index) {
  state.lightbox.open = true;
  state.lightbox.index = index;
  state.lightbox.col = "candidate";
  browseToFile(stripHostPrefix(state.host, state.images[index].filename));
  readBack();
  await lbShow();
}

// Clicking an anchor in the anchors column opens THAT anchor in the
// lightbox (anchor column); blink from there compares against the feed.
export async function openAnchor(anchorIdx) {
  state.lightbox.open = true;
  state.lightbox.col = "anchor";
  state.lightbox.anchorIndex = anchorIdx;
  readBack();
  await lbShow();
}

export async function close() {
  await writeBack();
  await flushViews(); // durability point: closing flushes pending view writes
  state.lightbox.open = false;
  $("lightbox").hidden = true;
  render();
  // the hash already names the last candidate (step/openAt wrote it);
  // just re-center the feed where browsing left off
  const idx = findByFile(parseUrl().file);
  if (idx >= 0) restoreToIndex(idx);
}
