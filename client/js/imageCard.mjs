// client/js/imageCard.mjs — THE image card. One component, used by every
// feed. Pure presentation + pure inputs:
//
//   Inputs at construction: alt, ar, stripText, zoomKey, onZoomChange,
//                           onOpen, onErrorClick, title, titleActions, footer
//   Input after construction: setSrc(url | null)  — the ONLY one
//   Read-only outputs: el, state
//
// The component knows its children, never its parents. It doesn't know what
// a candidate or an anchor is; it renders an image and executes the
// callbacks it was given, unaware of what they do. No caller reaches into
// its DOM: no setSrc poking, no class flipping from outside.
//
// Internal states are scoped (ic-*) so page CSS can never collide with them.

import { makeZoomable } from "./zoomable.mjs";

export function imageCard({
  alt, ar = null, stripText = "",
  zoomKey, onZoomChange,
  onOpen, onErrorClick,
  title, titleActions = [], footer = [],
}) {
  const card = document.createElement("div");
  card.className = "card";

  // --- image box: presentation + load lifecycle, owned here -----------------
  const wrap = document.createElement("div");
  wrap.className = "imgwrap ic-empty";
  if (ar) wrap.style.setProperty("--ar", ar);

  const img = document.createElement("img");
  img.alt = alt;
  wrap.appendChild(img);

  const strip = document.createElement("div");
  strip.className = "mstrip";
  strip.textContent = stripText ?? "";
  strip.style.display = stripText ? "block" : "none";
  wrap.appendChild(strip);

  let state = "empty"; // "empty" | "loading" | "loaded" | "error"

  img.addEventListener("load", () => {
    if (img.naturalWidth && img.naturalHeight) {
      wrap.style.setProperty("--ar", `${img.naturalWidth} / ${img.naturalHeight}`);
    }
    wrap.classList.remove("ic-loading", "ic-error", "ic-empty");
    state = "loaded";
  });
  img.addEventListener("error", () => {
    if (!img.getAttribute("src")) return; // unload-triggered: not an error
    wrap.classList.remove("ic-loading", "ic-empty");
    wrap.classList.add("ic-error");
    state = "error";
  });

  makeZoomable(img, { key: zoomKey, onZoomChange });

  wrap.addEventListener("click", () => {
    if (state === "error") {
      onErrorClick?.(); // never open the lightbox on a broken frame
      return;
    }
    onOpen?.();
  });

  card.appendChild(wrap);

  // --- title row -------------------------------------------------------------
  if (title) {
    const row = document.createElement("div");
    row.className = "ctitle";
    row.appendChild(title);
    if (titleActions.length) {
      const btns = document.createElement("span");
      btns.className = "btnwrap";
      for (const b of titleActions) btns.appendChild(b);
      row.appendChild(btns);
    }
    card.appendChild(row);
  }

  // --- footer slots -----------------------------------------------------------
  for (const el of [].concat(footer)) card.appendChild(el);

  // --- the public handle -------------------------------------------------------
  return {
    el: card,
    get state() { return state; },

    // the ONLY post-construction input: "here is the image source" / "none".
    setSrc(src) {
      if (src === null || src === undefined) {
        img.removeAttribute("src"); // aborts the fetch, releases decoded bytes
        wrap.classList.remove("ic-loading", "ic-error");
        wrap.classList.add("ic-empty");
        state = "empty";
        return;
      }
      wrap.classList.remove("ic-error", "ic-empty");
      wrap.classList.add("ic-loading");
      state = "loading";
      img.src = src;
    },

    // presentation setters — no one reaches into the DOM
    setStripText(text) {
      strip.textContent = text ?? "";
      strip.style.display = text ? "block" : "none";
    },
    setAr(value) {
      if (value) wrap.style.setProperty("--ar", value);
    },
  };
}

// helper for callers: aspect string from extracted metadata
export function aspectFromMeta(meta) {
  return meta?.width && meta?.height ? `${meta.width} / ${meta.height}` : null;
}

// action button factory — the row renders; the callback executes.
export function actionButton(cls, innerHtml, title, onClick, active = false) {
  const b = document.createElement("button");
  b.className = "votebtn " + cls + (active ? " on" : "");
  b.innerHTML = innerHtml;
  b.title = title;
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick(e);
  });
  return b;
}
