// client/app/components/Card.mjs — the CANDIDATE image card, declared.
//
// Composes <Zoomable> (image box), the title row (filename + <IconButton>
// actions + save), the notes pair (<NoteBox>), and the <MetaBar>. Judgment is
// read from image.judgment (the source of truth); vote/favorite mutate it and
// refresh. mountCard adapts the card to the legacy feed engine's handle
// contract (el / setSrc / setMeta / setJudgment / state) until <Grid> owns the
// list.

import { h, Fragment } from "../../vendor/preact/vendor.mjs";
import { useState, useEffect } from "../../vendor/preact/vendor.mjs";
import { state, render } from "../../js/state.mjs";
import { api } from "../../js/api.mjs";
import { setVote, toggleFavorite, saveNotes } from "../../js/judgment.mjs";
import { metaStripText } from "../../js/fields.mjs";
import { iconSvg } from "../../js/icons.mjs";
import { toggleVariations } from "../../js/variations.mjs";
import { matchesFile, parseUrl } from "../../js/route.mjs";
import { Zoomable } from "./Zoomable.mjs";
import { IconButton } from "./IconButton.mjs";
import { MetaBar } from "./MetaBar.mjs";
import { NoteBox } from "./NoteBox.mjs";

// which filenames already exist in the downloads dir (save button greys)
export const savedSet = new Set();

// Prepend "<host>#" only if the filename doesn't already start with it.
function hostPrefixed(host, filename) {
  const pfx = host + "#";
  return filename.startsWith(pfx) ? filename : pfx + filename;
}

function aspectFromMeta(meta) {
  return meta?.width && meta?.height ? `${meta.width} / ${meta.height}` : null;
}

export function Card({ image, imgIdx, src, meta, onOpen, onErrorClick, onImgPhase }) {
  const [ar, setAr] = useState(() => aspectFromMeta(meta));
  const [facts, setFacts] = useState(() => ({
    w: meta?.width ?? null, h: meta?.height ?? null, bytes: image.size ?? null,
  }));
  const [expanded, setExpanded] = useState(false);
  const [flash, setFlash] = useState(false);

  // metadata arriving after first render fills aspect + pixel facts
  useEffect(() => {
    if (meta?.width && meta?.height) {
      setAr(`${meta.width} / ${meta.height}`);
      setFacts((f) => ({ ...f, w: meta.width, h: meta.height }));
    }
  }, [meta]);

  // byte size isn't in every host's listing — a HEAD on the bytes route fills it
  useEffect(() => {
    if (image.size == null) {
      fetch(api.imageBytesUrl(image.id), { method: "HEAD" })
        .then((r) => {
          const cl = r.headers.get("content-length");
          if (r.ok && cl) {
            image.size = Number(cl);
            setFacts((f) => ({ ...f, bytes: Number(cl) }));
          }
        })
        .catch(() => {});
    }
  }, []);

  const j = image.judgment ?? {};
  const stripText = meta ? metaStripText(meta) : "";

  const onLoaded = (w, hp) => {
    setAr(`${w} / ${hp}`);
    setFacts((f) => ({ ...f, w, h: hp }));
  };

  const flashSaved = () => {
    setFlash(true);
    setTimeout(() => setFlash(false), 1200);
  };

  const saveNote = (cls) => (text) => {
    const notes = { ...(image.judgment?.notes ?? {}), [cls]: text };
    saveNotes(image, notes).then(() => flashSaved());
  };

  // First neighbor WITH CONTENT in that direction; a rendered neighbor's live
  // textarea wins (it may hold unsaved edits).
  const neighborText = (cls) => (dir) => {
    for (let i = imgIdx + dir; i >= 0 && i < state.images.length; i += dir) {
      const rendered = document.querySelector(`.card[data-idx="${i}"] textarea.${cls}`);
      const text = rendered ? rendered.value : (state.images[i]?.judgment?.notes?.[cls] ?? "");
      if (text) return text;
    }
    return "";
  };

  const saved = savedSet.has(image.filename) || savedSet.has(hostPrefixed(image.host, image.filename));
  const download = (e) => {
    e.stopPropagation();
    const downloadName = hostPrefixed(image.host, image.filename);
    const a = document.createElement("a");
    a.href = api.imageBytesUrl(image.id);
    a.download = downloadName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    savedSet.add(downloadName); // optimistic; refreshed from disk on load
    render();
  };

  const copyName = (e) => {
    e.stopPropagation();
    const el = e.currentTarget;
    navigator.clipboard?.writeText(hostPrefixed(image.host, image.filename))
      .then(() => {
        el.classList.add("copied");
        setTimeout(() => el.classList.remove("copied"), 800);
      })
      .catch(() => {});
  };

  return h(Fragment, null,
    h(Zoomable, {
      src, alt: image.filename, ar, stripText, zoomKey: image.id,
      onLoaded, onOpen, onErrorClick, onImgPhase,
    }),
    h("div", { class: "ctitle" },
      h("span", { class: "copyable", title: "click to copy host#filename", onClick: copyName }, image.filename),
      h("span", { class: "btnwrap" },
        h("span", { class: "saved" + (flash ? " show" : "") }, "Feedback saved"),
        h(IconButton, {
          icon: iconSvg("wand", 16), variant: "variations", title: "generate variations",
          onAction: (e) => toggleVariations(e.currentTarget.closest(".card"), image),
        }),
        h(IconButton, {
          icon: iconSvg("thumb-down"), variant: "down", active: j.vote === "down",
          title: "thumbs down — hides (Unhide up top restores)",
          onAction: async () => { await setVote(image, "down"); render(); },
        }),
        h(IconButton, {
          icon: iconSvg("thumb-up"), variant: "up", active: j.vote === "up", title: "thumbs up",
          onAction: async () => { await setVote(image, image.judgment?.vote === "up" ? null : "up"); render(); },
        }),
        h(IconButton, {
          icon: iconSvg("star"), variant: "favorite", active: !!j.favorite,
          title: "favorite — interesting in itself, not project fitness",
          onAction: async () => { await toggleFavorite(image); render(); },
        }),
        h("button", {
          class: "savebtn",
          title: saved ? "already in ~/Downloads (click to download again)" : "download this image",
          onClick: download,
        }, saved ? "saved" : "save"),
      ),
    ),
    h("div", { class: "pair" },
      h(NoteBox, {
        sign: "neg", placeholder: "negatives…", initialValue: image.judgment?.notes?.neg ?? "",
        onSave: saveNote("neg"), getNeighborText: neighborText("neg"),
      }),
      h(NoteBox, {
        sign: "pos", placeholder: "positives…", initialValue: image.judgment?.notes?.pos ?? "",
        onSave: saveNote("pos"), getNeighborText: neighborText("pos"),
      }),
    ),
    h(MetaBar, { facts, meta, expanded, onToggle: () => setExpanded((x) => !x) }),
  );
}
