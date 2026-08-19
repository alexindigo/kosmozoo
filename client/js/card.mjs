// client/js/card.mjs — the record card: the feed is the judgment editor.
//
// A card carries the complete per-image workbench, no mode switch required:
//   image box (aspect-true, reserved before load so the feed never jumps;
//   metadata strip over the image bottom; click → lightbox; click-on-error →
//   retry)
//   header row: filename (click copies host#file) · saved-flash ·
//     vote down/up · favorite · save-to-downloads
//   metadata: grouped field panel (left) + prompt excerpt (right)
//   feedback: negatives | positives textareas, 500ms-debounced autosave with
//     blur flush, copy-from-neighbor skipping empties (live text wins over
//     stored judgment)

import { S } from "./state.mjs";
import { api } from "./api.mjs";
import { setVote, toggleFavorite, saveNotes } from "./judgment.mjs";
import { metaStripText, fillCardMeta } from "./fields.mjs";
import { retryImage } from "./feed.mjs";
import { makeZoomable } from "./zoomable.mjs";
import { iconSvg } from "./icons.mjs";

// which filenames already exist in the downloads dir (save button greys)
export const savedSet = new Set();

export function buildCard(image, imgIdx) {
  const card = document.createElement("div");
  card.className = "card";
  card.dataset.idx = imgIdx;
  card.dataset.name = image.filename;
  if (image.judgment?.vote) card.dataset.vote = image.judgment.vote;
  if (image.judgment?.favorite) card.dataset.favorite = "1";

  card.appendChild(buildImageBox(image, imgIdx));
  card.appendChild(buildHeaderRow(image));
  card.appendChild(buildMetaRow(image));
  card.appendChild(buildNotesRow(image, imgIdx));
  return card;
}

// A card rendered before its metadata arrived gets patched in place.
export function patchCardMeta(card, meta) {
  const props = card.querySelector(".props");
  const desc = card.querySelector(".desc");
  if (props && desc) fillCardMeta(props, desc, meta);
  const strip = card.querySelector(".mstrip");
  if (strip) {
    const txt = meta ? metaStripText(meta) : "";
    strip.textContent = txt;
    strip.style.display = txt ? "block" : "none";
  }
  if (meta?.width && meta?.height) {
    card.querySelector(".imgwrap")?.style.setProperty("--ar", `${meta.width} / ${meta.height}`);
  }
}

// --- image box ---------------------------------------------------------------

function buildImageBox(image, imgIdx) {
  const wrap = document.createElement("div");
  wrap.className = "imgwrap empty";
  if (image.meta?.width && image.meta?.height) {
    wrap.style.setProperty("--ar", `${image.meta.width} / ${image.meta.height}`);
  }
  const img = document.createElement("img");
  img.alt = image.filename;
  img.addEventListener("load", () => {
    if (img.naturalWidth) {
      wrap.style.setProperty("--ar", `${img.naturalWidth} / ${img.naturalHeight}`);
    }
    wrap.classList.remove("loading");
  });
  img.addEventListener("error", () => {
    if (!img.getAttribute("src")) return; // unload-triggered: not an error
    wrap.classList.remove("loading");
    wrap.classList.add("error");
  });
  wrap.appendChild(img);
  // in-feed zoom: same code path as anchor thumbs; crops persist and carry
  makeZoomable(img, { key: image.id });

  const strip = document.createElement("div");
  strip.className = "mstrip";
  const txt = image.meta ? metaStripText(image.meta) : "";
  strip.textContent = txt;
  strip.style.display = txt ? "block" : "none";
  wrap.appendChild(strip);

  wrap.addEventListener("click", async () => {
    if (wrap.classList.contains("error")) {
      retryImage(imgIdx);
      return; // never open the lightbox on a broken frame
    }
    const { openAt } = await import("./lightbox.mjs");
    openAt(imgIdx);
  });
  return wrap;
}

// --- header row -----------------------------------------------------------------

// "Feedback saved" flash elements, keyed by image id (one per rendered card)
const savedFlashes = new Map();

function buildHeaderRow(image) {
  const row = document.createElement("div");
  row.className = "fname";

  const name = document.createElement("span");
  name.className = "copyable";
  name.textContent = image.filename;
  name.title = "click to copy host#filename";
  name.addEventListener("click", async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(image.id.replace(":", "#"));
      name.classList.add("copied");
      setTimeout(() => name.classList.remove("copied"), 800);
    } catch { /* clipboard unavailable */ }
  });

  const saved = document.createElement("span");
  saved.className = "saved";
  saved.textContent = "Feedback saved";
  savedFlashes.set(image.id, saved);

  const j = image.judgment ?? {};
  const down = voteButton("down", iconSvg("thumb-down"), "thumbs down — hides (Unhide up top restores)", j.vote === "down");
  down.addEventListener("click", async () => {
    await setVote(image, "down");
    removeCard(image); // hides by default: the card leaves the feed
  });
  const up = voteButton("up", iconSvg("thumb-up"), "thumbs up", j.vote === "up");
  up.addEventListener("click", async () => {
    await setVote(image, j.vote === "up" ? null : "up");
    up.classList.toggle("on", image.judgment?.vote === "up");
  });
  const fav = voteButton("favorite", iconSvg("star"), "favorite — interesting in itself, not project fitness", !!j.favorite);
  fav.addEventListener("click", async () => {
    await toggleFavorite(image);
    fav.classList.toggle("on", !!image.judgment?.favorite);
  });

  const save = document.createElement("button");
  save.className = "savebtn";
  const paint = () => {
    const has = savedSet.has(image.filename);
    save.textContent = has ? "saved" : "save";
    save.title = has ? "already in ~/Downloads (click to download again)" : "download this image";
  };
  paint();
  save.addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = api.imageBytesUrl(image.id);
    a.download = image.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    savedSet.add(image.filename); // optimistic; refreshed from disk on load
    paint();
  });

  const wrap = document.createElement("span");
  wrap.className = "btnwrap";
  wrap.append(saved, down, up, fav, save);
  row.append(name, wrap);
  return row;
}

function voteButton(cls, label, title, on) {
  const b = document.createElement("button");
  b.className = "votebtn " + cls + (on ? " on" : "");
  b.innerHTML = label;
  b.title = title;
  return b;
}

// card removal on down-vote: surgical, no feed rebuild
function removeCard(image) {
  const idx = S.images.indexOf(image);
  if (idx < 0) return;
  document.querySelector(`.card[data-idx="${idx}"]`)?.remove();
}

// --- metadata row -------------------------------------------------------------------

function buildMetaRow(image) {
  const row = document.createElement("div");
  row.className = "pair";
  const props = document.createElement("div");
  props.className = "props";
  const desc = document.createElement("div");
  desc.className = "desc";
  fillCardMeta(props, desc, image.meta);
  row.append(props, desc);
  return row;
}

// --- notes row -------------------------------------------------------------------------

const noteTimers = new Map();

function buildNotesRow(image, imgIdx) {
  const row = document.createElement("div");
  row.className = "pair";
  row.append(noteCol(image, imgIdx, "neg", "negatives…", image.judgment?.notes?.neg ?? ""),
             noteCol(image, imgIdx, "pos", "positives…", image.judgment?.notes?.pos ?? ""));
  return row;
}

function noteCol(image, imgIdx, cls, placeholder, initial) {
  const col = document.createElement("div");
  col.className = "boxcol";
  const ta = document.createElement("textarea");
  ta.className = cls;
  ta.placeholder = placeholder;
  ta.value = initial;

  const flush = () => {
    clearTimeout(noteTimers.get(image.id + cls));
    noteTimers.delete(image.id + cls);
    const notes = { ...(image.judgment?.notes ?? {}), [cls]: ta.value };
    saveNotes(image, notes).then(() => flashSaved(image));
  };
  ta.addEventListener("input", () => {
    clearTimeout(noteTimers.get(image.id + cls));
    noteTimers.set(image.id + cls, setTimeout(flush, 500));
  });
  ta.addEventListener("blur", flush);

  const btns = document.createElement("div");
  btns.className = "btnrow";
  const below = document.createElement("button");
  below.textContent = "copy from below";
  below.addEventListener("click", () => copyFrom(imgIdx, cls, 1, ta));
  const above = document.createElement("button");
  above.textContent = "copy from above";
  above.addEventListener("click", () => copyFrom(imgIdx, cls, -1, ta));
  btns.append(below, above);
  col.append(ta, btns);
  return col;
}

function flashSaved(image) {
  const el = savedFlashes.get(image.id);
  if (!el) return;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 1200);
}

// First neighbor WITH CONTENT in that direction (skips empty neighbors,
// rendered or not). A rendered neighbor's live textarea wins (it may hold
// unsaved edits); an unrendered one contributes its stored judgment.
function copyFrom(srcIdx, cls, dir, ta) {
  for (let i = srcIdx + dir; i >= 0 && i < S.images.length; i += dir) {
    let text = "";
    const rendered = document.querySelector(`.card[data-idx="${i}"] textarea.${cls}`);
    if (rendered) {
      text = rendered.value;
    } else {
      text = S.images[i]?.judgment?.notes?.[cls] ?? "";
    }
    if (text) {
      ta.value = text;
      ta.dispatchEvent(new Event("input", { bubbles: true })); // schedules save
      return;
    }
  }
}
