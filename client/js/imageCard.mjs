// client/js/imageCard.mjs — THE image card. One component, two instances:
// the candidate feed and the anchor feed render the same card and inject
// their contents at render time.
//
// The card owns presentation: rounded shell with the gap between card edge
// and image, the aspect-true image box (reserves height before pixels land,
// load/error states, zoom attachment, click semantics), and the slots —
// title row, action row, footer. Behavior belongs to the caller's
// callbacks; the card is presentation only.

import { makeZoomable } from "./zoomable.mjs";

export function imageCard({
  src = null,            // assigned at build when present (anchors);
                         // the feed's window loader assigns for candidates
  alt, ar,               // aspect-true reservation, "w / h" or null
  stripText = "",
  zoomKey, onZoomChange,
  onOpen, onErrorClick,
  title,                 // element for the title row's left side
  titleActions = [],     // elements for the title row's right side
  footer = [],           // element(s) appended after the title row
}) {
  const card = document.createElement("div");
  card.className = "card";
  card.appendChild(buildImageBox({ src, alt, ar, stripText, zoomKey, onZoomChange, onOpen, onErrorClick }));
  card.appendChild(buildTitleRow(title, titleActions));
  for (const el of [].concat(footer)) card.appendChild(el);
  return card;
}

function buildImageBox({ src, alt, ar, stripText, zoomKey, onZoomChange, onOpen, onErrorClick }) {
  const wrap = document.createElement("div");
  wrap.className = "imgwrap empty";
  if (ar) wrap.style.setProperty("--ar", ar);

  const img = document.createElement("img");
  img.alt = alt;
  img.addEventListener("load", () => {
    if (img.naturalWidth && img.naturalHeight) {
      wrap.style.setProperty("--ar", `${img.naturalWidth} / ${img.naturalHeight}`);
    }
    wrap.classList.remove("loading");
  });
  img.addEventListener("error", () => {
    if (!img.getAttribute("src")) return; // unload-triggered: not an error
    wrap.classList.remove("loading");
    wrap.classList.add("error");
  });
  if (src) img.src = src;
  wrap.appendChild(img);

  const strip = document.createElement("div");
  strip.className = "mstrip";
  strip.textContent = stripText ?? "";
  strip.style.display = stripText ? "block" : "none";
  wrap.appendChild(strip);

  makeZoomable(img, { key: zoomKey, onZoomChange });

  wrap.addEventListener("click", () => {
    if (wrap.classList.contains("error")) {
      onErrorClick?.();
      return; // never open the lightbox on a broken frame
    }
    onOpen?.();
  });
  return wrap;
}

// the row under the image: title left, actions right — one layout for both
function buildTitleRow(title, actions) {
  const row = document.createElement("div");
  row.className = "ctitle";
  if (title) row.appendChild(title);
  if (actions.length) {
    const wrap = document.createElement("span");
    wrap.className = "btnwrap";
    for (const b of actions) wrap.appendChild(b);
    row.appendChild(wrap);
  }
  return row;
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
