// client/js/card.mjs — the CANDIDATE instance of the shared image card.
// The card (imageCard.mjs) owns presentation; this module injects what a
// candidate is: filename (copy), vote/favorite/save actions, saved flash,
// notes boxes with copy-from-neighbor, and the params+prompt panel.
//
// Encapsulation: onOpen/onErrorClick are INJECTED (the parent wires them to
// the lightbox/feed). This module doesn't know the lightbox exists.

import { S } from "./state.mjs";
import { api } from "./api.mjs";
import { setVote, toggleFavorite, saveNotes } from "./judgment.mjs";
import { metaStripText, fillCardMeta } from "./fields.mjs";
import { iconSvg } from "./icons.mjs";
import { imageCard, aspectFromMeta, actionButton } from "./imageCard.mjs";
import { toggleVariations } from "./variations.mjs";

// which filenames already exist in the downloads dir (save button greys)
export const savedSet = new Set();

// "Feedback saved" flash elements, keyed by image id
const savedFlashes = new Map();

export function buildCard(image, imgIdx, { onOpen, onErrorClick } = {}) {
  const handle = imageCard({
    alt: image.filename,
    ar: aspectFromMeta(image.meta),
    stripText: image.meta ? metaStripText(image.meta) : "",
    zoomKey: image.id,
    onOpen,
    onErrorClick,
    title: buildTitle(image),
    titleActions: buildActions(image),
    footer: [buildNotesRow(image, imgIdx), buildMetaRow(image)],
  });
  handle.el.dataset.idx = imgIdx;
  handle.el.dataset.name = image.filename;
  if (image.judgment?.vote) handle.el.dataset.vote = image.judgment.vote;
  if (image.judgment?.favorite) handle.el.dataset.favorite = "1";

  // instance-level meta updates: strip + aspect are the card's; props/desc
  // are this instance's own footer content
  const propsEl = handle.el.querySelector(".props");
  const descEl = handle.el.querySelector(".desc");
  handle.setMeta = (meta) => {
    handle.setStripText(meta ? metaStripText(meta) : "");
    if (meta?.width && meta?.height) handle.setAr(`${meta.width} / ${meta.height}`);
    fillCardMeta(propsEl, descEl, meta);
  };
  return handle;
}

// --- injected: title (filename, click-to-copy host#file) -----------------------

// Prepend "<host>#" only if the filename doesn't already start with it —
// avoids "host#host#name" when a filename was authored with the prefix
// baked in (e.g. imports).
function hostPrefixed(host, filename) {
  const pfx = host + "#";
  return filename.startsWith(pfx) ? filename : pfx + filename;
}

function buildTitle(image) {
  const name = document.createElement("span");
  name.className = "copyable";
  name.textContent = image.filename;
  name.title = "click to copy host#filename";
  name.addEventListener("click", async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(hostPrefixed(image.host, image.filename));
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
    actionButton("variations", iconSvg("wand", 16), "generate variations", (e) => {
      toggleVariations(e.currentTarget.closest(".card"), image);
    }),
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
      // No render() in toggleFavorite, so this button stays in the DOM and
      // the .on class lands on the live element.
      e.currentTarget.classList.toggle("on", !!image.judgment?.favorite);
    }, !!j.favorite),
  ];
  actions.unshift(saved);

  const save = document.createElement("button");
  save.className = "savebtn";
  const paint = () => {
    // Save button greys when either the raw filename or the host-prefixed
    // form is on disk — legacy saves lack the prefix, new saves have it.
    const has = savedSet.has(image.filename)
      || savedSet.has(hostPrefixed(image.host, image.filename));
    save.textContent = has ? "saved" : "save";
    save.title = has ? "already in ~/Downloads (click to download again)" : "download this image";
  };
  paint();
  save.addEventListener("click", (e) => {
    e.stopPropagation();
    // Downloads land in ~/Downloads with a `<host>#<filename>` name so
    // files from different hosts don't collide when they share a name.
    // Skip the prefix if the filename already carries it.
    const downloadName = hostPrefixed(image.host, image.filename);
    const a = document.createElement("a");
    a.href = api.imageBytesUrl(image.id);
    a.download = downloadName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    savedSet.add(downloadName); // optimistic; refreshed from disk on load
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

