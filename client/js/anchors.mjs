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

import { S, render, onRender } from "./state.mjs";
import { api } from "./api.mjs";
import { metaFromPngBytes } from "/shared/extractor.mjs";
import { fullFieldRows } from "./fields.mjs";
import { chrome } from "./chrome.mjs";
import { iconSvg } from "./icons.mjs";
import { openAnchor } from "./lightbox.mjs";
import { imageCard, aspectFromMeta, actionButton } from "./imageCard.mjs";

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
    S.anchors.push({ name: file.name, src: await shrinkToStore(dataUrl, file.name), meta });
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
    S.anchors = (JSON.parse(localStorage.getItem(LS_KEY)) || [])
      .filter((a) => a && a.name && a.src);
  } catch {
    S.anchors = [];
  }
}

function persistAnchors() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(
      S.anchors.map((a) => ({ name: a.name, src: a.src, ...(a.meta ? { meta: a.meta } : {}) }))));
  } catch {
    chrome.status.error("anchors not saved: browser storage full");
  }
}

function removeAnchor(name) {
  const i = S.anchors.findIndex((a) => a.name === name);
  if (i < 0) return;
  S.anchors.splice(i, 1);
  persistAnchors();
  render();
}

// --- pane setup ---------------------------------------------------------------------

export function initAnchorsPane() {
  const dz = document.getElementById("dropzone");
  const fi = document.getElementById("fileInput");
  dz.addEventListener("click", () => fi.click());
  fi.addEventListener("change", async () => {
    if (fi.files.length) await addAnchorFiles([...fi.files]);
    fi.value = "";
  });
  dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("over"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("over"));
  dz.addEventListener("drop", async (e) => {
    e.preventDefault();
    dz.classList.remove("over");
    if (reorderDrag) return; // was an anchor reorder, not files
    if (e.dataTransfer?.files?.length) await addAnchorFiles([...e.dataTransfer.files]);
  });

  // divider drag resizes the split between the feeds (persisted)
  const divider = document.getElementById("divider");
  const aside = document.getElementById("anchors");
  divider.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    divider.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing");
    const move = (ev) => {
      const w = Math.min(Math.max(window.innerWidth - ev.clientX - 12, 220), window.innerWidth * 0.7);
      S.anchorPaneWidth = Math.round(w);
      aside.style.width = S.anchorPaneWidth + "px";
    };
    const up = () => {
      document.body.classList.remove("resizing");
      divider.removeEventListener("pointermove", move);
      divider.removeEventListener("pointerup", up);
      api.setSettings("core.ui", { anchorWidth: S.anchorPaneWidth + "px" }).catch(() => {});
    };
    divider.addEventListener("pointermove", move);
    divider.addEventListener("pointerup", up);
  });
  loadAnchors();
}

export async function initAnchorsWidth() {
  const ui = await api.settings("core.ui").catch(() => ({}));
  if (ui.anchorWidth) {
    S.anchorPaneWidth = parseInt(ui.anchorWidth, 10) || S.anchorPaneWidth;
    document.getElementById("anchors").style.width = S.anchorPaneWidth + "px";
  }
}

// --- reorder (marked internal drag) ----------------------------------------------------

let reorderDrag = null;

function initReorder(list) {
  list.addEventListener("dragover", (e) => {
    if (!reorderDrag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const over = e.target.closest(".anchor");
    if (!over || over === reorderDrag) return;
    const rect = over.getBoundingClientRect();
    const before = (e.clientY - rect.top) < rect.height / 2;
    list.insertBefore(reorderDrag, before ? over : over.nextSibling);
  });
  list.addEventListener("drop", (e) => {
    if (reorderDrag) e.preventDefault();
  });
}

function syncOrderFromDom() {
  const order = [...document.querySelectorAll("#anchorList .anchor")].map((el) => el.dataset.name);
  S.anchors.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  persistAnchors();
}

// --- ⓘ overlay (every field, picker-exempt) -----------------------------------------------

export function initInfoOverlay() {
  const ov = document.getElementById("infoOverlay");
  document.getElementById("infoClose").addEventListener("click", () => { ov.hidden = true; });
  ov.addEventListener("click", (e) => { if (e.target === ov) ov.hidden = true; });
}

function showAnchorInfo(name, meta) {
  document.getElementById("infoTitle").textContent = name;
  const body = document.getElementById("infoBody");
  body.innerHTML = "";
  const rows = meta ? fullFieldRows(meta) : [];
  if (!rows.length && !meta?.prompt && !meta?.negPrompt) {
    const p = document.createElement("div");
    p.className = "info-none";
    p.textContent = "This image has no embedded parameters.";
    body.appendChild(p);
  } else {
    if (rows.length) {
      const props = document.createElement("div");
      props.className = "props";
      for (const [k, v] of rows) {
        const line = document.createElement("div");
        const label = document.createElement("span");
        label.className = "plabel";
        label.textContent = `${k}: `;
        line.append(label, document.createTextNode(v));
        props.appendChild(line);
      }
      body.appendChild(props);
    }
    for (const [label, text] of [["prompt", meta.prompt], ["negative", meta.negPrompt]]) {
      if (!text) continue;
      const sec = document.createElement("div");
      sec.className = "infosec";
      const lab = document.createElement("div");
      lab.className = "plabel";
      lab.textContent = label;
      const txt = document.createElement("div");
      txt.className = "infotext";
      txt.textContent = text;
      sec.append(lab, txt);
      body.appendChild(sec);
    }
  }
  document.getElementById("infoOverlay").hidden = false;
}

// --- renderer (the column's only DOM writer) -------------------------------------------
// The anchor INSTANCE of the shared image card: same card, injected with
// name / info+remove actions / meta-summary strip.

onRender((s) => {
  if (typeof document === "undefined") return;
  const list = document.getElementById("anchorList");
  if (!list) return;
  if (!list.dataset.reorderInit) {
    list.dataset.reorderInit = "1";
    initReorder(list);
  }
  list.innerHTML = "";
  for (const a of s.anchors) {
    const idx = s.anchors.indexOf(a);
    let cardEl = null; // assigned when imageCard returns; the zoom hook skips until then
    const card = imageCard({
      src: a.src,
      alt: a.name,
      ar: aspectFromMeta(a.meta),
      stripText: anchorSummary(a.meta),
      zoomKey: `anchor:${a.name}`,
      onZoomChange: (zoomed) => { if (cardEl) cardEl.draggable = !zoomed; },
      onOpen: () => openAnchor(idx),
      title: anchorTitle(a.name),
      titleActions: [
        actionButton("ainfo", iconSvg("info-circle", 14), "embedded parameters",
          () => showAnchorInfo(a.name, a.meta)),
        actionButton("rm", iconSvg("trash", 13), "remove anchor",
          () => removeAnchor(a.name)),
      ],
    });
    cardEl = card;
    card.classList.add("anchor");
    card.dataset.name = a.name;
    card.draggable = true;
    card.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/x-anchor", "");
      e.dataTransfer.effectAllowed = "move";
      reorderDrag = card;
      card.classList.add("dragging");
    });
    card.addEventListener("dragend", () => {
      card.classList.remove("dragging");
      reorderDrag = null;
      syncOrderFromDom();
    });
    list.appendChild(card);
  }
});

function anchorTitle(name) {
  const el = document.createElement("span");
  el.className = "aname";
  el.textContent = name;
  el.title = name;
  return el;
}

function anchorSummary(meta) {
  if (!meta) return "";
  const bits = [];
  if (meta.seed != null) bits.push(`seed ${meta.seed}`);
  if (meta.steps != null) bits.push(`${meta.steps} steps`);
  if (meta.guidance != null) bits.push(`g ${meta.guidance}`);
  if (meta.model) bits.push(meta.model);
  return bits.join(" · ");
}
