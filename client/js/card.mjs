// client/js/card.mjs — the CANDIDATE instance of the shared image card.
// The card (imageCard.mjs) owns presentation; this module injects what a
// candidate is: filename (copy), vote/favorite/save actions, saved flash,
// notes boxes with copy-from-neighbor, and the params+prompt panel.

import { S } from "./state.mjs";
import { api } from "./api.mjs";
import { setVote, toggleFavorite, saveNotes } from "./judgment.mjs";
import { metaStripText, fillCardMeta } from "./fields.mjs";
import { retryImage } from "./feed.mjs";
import { iconSvg } from "./icons.mjs";
import { openAt } from "./lightbox.mjs";
import { imageCard, aspectFromMeta, actionButton } from "./imageCard.mjs";

// which filenames already exist in the downloads dir (save button greys)
export const savedSet = new Set();

// "Feedback saved" flash elements, keyed by image id
const savedFlashes = new Map();

export function buildCard(image, imgIdx) {
  const card = imageCard({
    alt: image.filename,
    ar: aspectFromMeta(image.meta),
    stripText: image.meta ? metaStripText(image.meta) : "",
    zoomKey: image.id,
    onOpen: () => openAt(imgIdx),
    onErrorClick: () => retryImage(imgIdx),
    title: buildTitle(image),
    titleActions: buildActions(image),
    footer: [buildNotesRow(image, imgIdx), buildMetaRow(image)],
  });
  card.dataset.idx = imgIdx;
  card.dataset.name = image.filename;
  if (image.judgment?.vote) card.dataset.vote = image.judgment.vote;
  if (image.judgment?.favorite) card.dataset.favorite = "1";
  return card;
}

// --- injected: title (filename, click-to-copy host#file) -----------------------

function buildTitle(image) {
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
  return name;
}

// --- injected: action row (saved flash + down/up/favorite/save) ----------------

function buildActions(image) {
  const saved = document.createElement("span");
  saved.className = "saved";
  saved.textContent = "Feedback saved";
  savedFlashes.set(image.id, saved);

  const j = image.judgment ?? {};
  const actions = [
    actionButton("down", iconSvg("thumb-down"), "thumbs down — hides (Unhide up top restores)", async () => {
      await setVote(image, "down");
      card_remove(image);
    }, j.vote === "down"),
    actionButton("up", iconSvg("thumb-up"), "thumbs up", async (e) => {
      await setVote(image, j.vote === "up" ? null : "up");
      e.currentTarget.classList.toggle("on", image.judgment?.vote === "up");
    }, j.vote === "up"),
    actionButton("favorite", iconSvg("star"), "favorite — interesting in itself, not project fitness", async (e) => {
      await toggleFavorite(image);
      e.currentTarget.classList.toggle("on", !!image.judgment?.favorite);
    }, !!j.favorite),
  ];
  actions.unshift(saved);

  const save = document.createElement("button");
  save.className = "savebtn";
  const paint = () => {
    const has = savedSet.has(image.filename);
    save.textContent = has ? "saved" : "save";
    save.title = has ? "already in ~/Downloads (click to download again)" : "download this image";
  };
  paint();
  save.addEventListener("click", (e) => {
    e.stopPropagation();
    const a = document.createElement("a");
    a.href = api.imageBytesUrl(image.id);
    a.download = image.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    savedSet.add(image.filename); // optimistic; refreshed from disk on load
    paint();
  });
  actions.push(save);
  return actions;
}

function card_remove(image) {
  const idx = S.images.indexOf(image);
  if (idx < 0) return;
  document.querySelector(`.card[data-idx="${idx}"]`)?.remove();
}

// --- injected: notes (neg/pos textareas, autosave, copy-from-neighbor) --------

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

// --- injected: params + prompt (props left, description right) ------------------

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
