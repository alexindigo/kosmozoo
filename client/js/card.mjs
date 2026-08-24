// client/js/card.mjs — the CANDIDATE instance of the shared image card.
// The card (imageCard.mjs) owns presentation; this module injects what a
// candidate is: filename (copy), vote/favorite/save actions, saved flash,
// notes boxes with copy-from-neighbor, and the params+prompt panel.
//
// Encapsulation: onOpen/onErrorClick are INJECTED (the parent wires them to
// the lightbox/feed). This module doesn't know the lightbox exists.

import { state } from "./state.mjs";
import { matchesFile, parseUrl } from "./route.mjs";
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
  // Shared state: the buttons' click handlers need handle.setJudgment,
  // but imageCard only creates .btnwrap when titleActions.length > 0.
  // The handlers reference this shared object, which gets the handle's
  // setJudgment assigned after the card is built.
  const cardState = { setJudgment: null };

  // Build the action buttons (they reference cardState for setJudgment)
  const actions = buildActions(image, cardState);

  // size/dimension facts for the collapsed bar — filled as they arrive:
  // list size now, pixels on decode, byte size via HEAD when not listed
  const facts = {
    w: image.meta?.width ?? null,
    h: image.meta?.height ?? null,
    bytes: image.size ?? null,
  };

  function paintMetaBar() {
    const el = handle.el.querySelector(".metabar-info");
    if (el) {
      el.textContent = metaBarText(facts);
      el.title = el.textContent;
    }
  }

  const handle = imageCard({
    alt: image.filename,
    ar: aspectFromMeta(image.meta),
    stripText: image.meta ? metaStripText(image.meta) : "",
    zoomKey: image.id,
    onOpen,
    onErrorClick,
    onLoaded: (w, h) => {
      facts.w = w;
      facts.h = h;
      paintMetaBar();
    },
    title: buildTitle(image),
    titleActions: actions,
    between: [buildMetaRow(image, facts)],
    footer: [buildNotesRow(image, imgIdx)],
  });
  handle.el.dataset.idx = imgIdx;
  handle.el.dataset.name = image.filename;
  const urlFile = parseUrl().file;
  if (urlFile && matchesFile(image, state.host, urlFile)) {
    handle.el.classList.add("current");
  }

  // Judgment visual state — ONE place, derived from image.judgment at call
  // time. Never captured from a stale closure. Called at creation and after
  // every judgment mutation. No render() is ever called for judgment changes.
  handle.setJudgment = (judgment) => {
    const j = judgment ?? {};
    // data attributes drive the card's border colors via CSS
    if (j.vote) handle.el.dataset.vote = j.vote;
    else delete handle.el.dataset.vote;
    if (j.favorite) handle.el.dataset.favorite = "1";
    else delete handle.el.dataset.favorite;
    // button .on classes
    const btn = (cls) => handle.el.querySelector(`.votebtn.${cls}`);
    btn("down")?.classList.toggle("on", j.vote === "down");
    btn("up")?.classList.toggle("on", j.vote === "up");
    btn("favorite")?.classList.toggle("on", !!j.favorite);
  };

  // Wire the shared state so the buttons can call handle.setJudgment
  cardState.setJudgment = handle.setJudgment;

  // instance-level meta updates: strip + aspect are the card's; props/desc
  // are this instance's own footer content
  // byte size isn't in every host's listing — a HEAD on the bytes route
  // fills it the moment the card renders
  if (facts.bytes == null) {
    fetch(api.imageBytesUrl(image.id), { method: "HEAD" })
      .then((r) => {
        const cl = r.headers.get("content-length");
        if (r.ok && cl) {
          facts.bytes = Number(cl);
          image.size = facts.bytes;
          paintMetaBar();
        }
      })
      .catch(() => {});
  }

  const propsEl = handle.el.querySelector(".props");
  const descEl = handle.el.querySelector(".desc");
  handle.setMeta = (meta) => {
    handle.setStripText(meta ? metaStripText(meta) : "");
    if (meta?.width && meta?.height) handle.setAr(`${meta.width} / ${meta.height}`);
    if (meta?.width && meta?.height) {
      facts.w = meta.width;
      facts.h = meta.height;
    }
    paintMetaBar();
    fillCardMeta(propsEl, descEl, meta);
  };

  // Initial judgment state
  handle.setJudgment(image.judgment);
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
//
// The card's visual state is derived from image.judgment in ONE place:
// handle.setJudgment(). Click handlers mutate the judgment then call it.
// No render() is ever called for judgment changes — the card updates its
// own DOM in place, so e.currentTarget is never a stale reference.

function buildActions(image, cardState) {
  const saved = document.createElement("span");
  saved.className = "saved";
  saved.textContent = "Feedback saved";
  savedFlashes.set(image.id, saved);

  const actions = [
    actionButton("variations", iconSvg("wand", 16), "generate variations", (e) => {
      toggleVariations(e.currentTarget.closest(".card"), image);
    }),
    actionButton("down", iconSvg("thumb-down"), "thumbs down — hides (Unhide up top restores)", async () => {
      await setVote(image, "down");
      cardState.setJudgment?.(image.judgment);
    }, false),
    actionButton("up", iconSvg("thumb-up"), "thumbs up", async () => {
      await setVote(image, image.judgment?.vote === "up" ? null : "up");
      cardState.setJudgment?.(image.judgment);
    }, false),
    actionButton("favorite", iconSvg("star"), "favorite — interesting in itself, not project fitness", async () => {
      await toggleFavorite(image);
      cardState.setJudgment?.(image.judgment);
    }, false),
  ];
  actions.unshift(saved);

  const save = document.createElement("button");
  save.className = "savebtn";
  const paint = () => {
    const has = savedSet.has(image.filename)
      || savedSet.has(hostPrefixed(image.host, image.filename));
    save.textContent = has ? "saved" : "save";
    save.title = has ? "already in ~/Downloads (click to download again)" : "download this image";
  };
  paint();
  save.addEventListener("click", (e) => {
    e.stopPropagation();
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
  const idx = state.images.indexOf(image);
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
  for (let i = srcIdx + dir; i >= 0 && i < state.images.length; i += dir) {
    let text = "";
    const rendered = document.querySelector(`.card[data-idx="${i}"] textarea.${cls}`);
    if (rendered) {
      text = rendered.value;
    } else {
      text = state.images[i]?.judgment?.notes?.[cls] ?? "";
    }
    if (text) {
      ta.value = text;
      ta.dispatchEvent(new Event("input", { bubbles: true })); // schedules save
      return;
    }
  }
}

// --- injected: params + prompt (props left, description right) ------------------

// collapsed by default: one line — pixel size + on-disk size left,
// expand toggle right. The full fields-config panel lives inside, hidden.
// facts fill in as they arrive: list size / HEAD size, decoded pixels,
// then extracted metadata — the line is never "waiting" for the scan.
function buildMetaRow(image, facts) {
  const row = document.createElement("div");
  row.className = "metabar";
  const info = document.createElement("span");
  info.className = "metabar-info";
  info.textContent = metaBarText(facts);
  info.title = info.textContent;
  const btn = document.createElement("button");
  btn.className = "metabar-toggle";
  btn.innerHTML = iconSvg("chevron-down", 14);
  btn.title = "show parameters";
  const full = document.createElement("div");
  full.className = "pair metabar-full";
  full.hidden = true;
  const props = document.createElement("div");
  props.className = "props";
  const desc = document.createElement("div");
  desc.className = "desc";
  fillCardMeta(props, desc, image.meta);
  full.append(props, desc);
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    full.hidden = !full.hidden;
    row.classList.toggle("open", !full.hidden);
    btn.title = full.hidden ? "show parameters" : "hide parameters";
  });
  row.append(info, btn, full);
  return row;
}

function fmtBytes(n) {
  if (n == null) return null;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function metaBarText(f) {
  const bits = [];
  if (f.w && f.h) bits.push(`${f.w}×${f.h}px`);
  const sz = fmtBytes(f.bytes);
  if (sz) bits.push(sz);
  return bits.length ? bits.join(" · ") : "no metadata yet";
}

