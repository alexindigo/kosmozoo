// client/js/anchors.mjs — the anchors column: the reference feed.
//
// Anchor cards share the candidate card's anatomy minus judgment: same
// aspect-true image box, name, metadata summary, ⓘ full-params overlay,
// × remove. Click opens that anchor in the lightbox (anchor column).
// Live zoom in the pane persists the view; the thumbnail itself never loads
// zoomed — the crop transfers to the lightbox via core.views.
//
// Anchors are chosen furniture: drops are shrunk to ≤1200px and persisted as
// data URLs in localStorage (never uploaded; a detector plugin may opt to
// send bytes). Reorder by drag with a marked internal type so the dropzone
// can tell reorder from file drop.

import { state } from "./state.mjs";
import { render } from "../app/services/notify.mjs";
import { api } from "./api.mjs";
import { metaFromPngBytes } from "/shared/extractor.mjs";
import { chrome } from "./chrome.mjs";

const LS_KEY = "kosmozoo.anchors.v1";
const MAX_DIM = 1200;

// --- drop: read → extract → shrink → store -------------------------------------

export async function addAnchorFiles(files) {
  for (const file of files) {
    if (!file.type.startsWith("image/")) continue;
    const [dataUrl, buf] = await Promise.all([
      readAsDataUrl(file),
      file.arrayBuffer(),
    ]);
    if (!dataUrl) continue;
    let meta = null;
    try {
      [meta] = await metaFromPngBytes(new Uint8Array(buf));
    } catch { /* metadata optional */ }
    state.anchors.push({ name: file.name, src: await shrinkToStore(dataUrl, file.name), meta });
  }
  persistAnchors();
  render();
}

function readAsDataUrl(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

// Downscale via canvas so persisted anchors fit the storage quota.
function shrinkToStore(src, fileName) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      if (Math.max(img.width, img.height) <= MAX_DIM) return resolve(src);
      const k = MAX_DIM / Math.max(img.width, img.height);
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      resolve(/\.png$/i.test(fileName) ? c.toDataURL("image/png") : c.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => resolve(src);
    img.src = src;
  });
}

// --- persistence ----------------------------------------------------------------

export function loadAnchors() {
  try {
    state.anchors = (JSON.parse(localStorage.getItem(LS_KEY)) || [])
      .filter((a) => a && a.name && a.src);
  } catch {
    state.anchors = [];
  }
}

export function persistAnchors() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(
      state.anchors.map((a) => ({ name: a.name, src: a.src, ...(a.meta ? { meta: a.meta } : {}) }))));
  } catch {
    chrome.status.error("anchors not saved: browser storage full");
  }
}

export function removeAnchor(name) {
  const i = state.anchors.findIndex((a) => a.name === name);
  if (i < 0) return;
  state.anchors.splice(i, 1);
  persistAnchors();
  render();
}

// --- pane setup ---------------------------------------------------------------------

export function initAnchorsPane() {
  // divider drag resizes the split between the feeds (persisted)
  const divider = document.getElementById("divider");
  const aside = document.getElementById("workspace");
  divider.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    divider.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing");
    const move = (ev) => {
      // right of the divider: workspace + the 32px workspace bar
      const w = Math.min(Math.max(window.innerWidth - ev.clientX - 34, 220), window.innerWidth * 0.7);
      state.anchorPaneWidth = Math.round(w);
      aside.style.width = state.anchorPaneWidth + "px";
    };
    const up = () => {
      document.body.classList.remove("resizing");
      divider.removeEventListener("pointermove", move);
      divider.removeEventListener("pointerup", up);
      api.setSettings("core.ui", { anchorWidth: state.anchorPaneWidth + "px" }).catch(() => {});
    };
    divider.addEventListener("pointermove", move);
    divider.addEventListener("pointerup", up);
  });
  loadAnchors();
}

export async function initAnchorsWidth() {
  const ui = await api.settings("core.ui").catch(() => ({}));
  if (ui.anchorWidth) {
    state.anchorPaneWidth = parseInt(ui.anchorWidth, 10) || state.anchorPaneWidth;
    document.getElementById("workspace").style.width = state.anchorPaneWidth + "px";
  }
}

// --- ⓘ overlay (every field, picker-exempt) -----------------------------------------------
// <InfoOverlay> owns the panel; this just hands it the anchor's name + meta.

export function showAnchorInfo(name, meta) {
  state.infoOverlay.open = true;
  state.infoOverlay.name = name;
  state.infoOverlay.meta = meta;
  render();
}
