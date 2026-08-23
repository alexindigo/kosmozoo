// client/js/workspace.mjs — the right column is a workspace of spaces.
//
// Two spaces share the pane: the anchors feed and the metadata details of
// the current image. A narrow vertical bar on the window's right edge holds
// one button per space (details on top, the default); the choice persists.
//
// The current image is the URL (route.mjs); this module only reads it and
// renders. Scroll is a writer: it moves the hash and updates the ring and
// details directly — no render(), no cached copy to drift.

import { state, onRender } from "./state.mjs";
import { buildMetaBody } from "./fields.mjs";
import { parseUrl, findByFile, writeFeedHash, stripHostPrefix } from "./route.mjs";

const LS_SPACE = "kosmozoo.workspace.v1";

export function initWorkspace() {
  try {
    if (localStorage.getItem(LS_SPACE) === "anchors") state.workspace = "anchors";
  } catch { /* private mode: session-only */ }

  const bar = document.getElementById("wsBar");
  for (const btn of bar.querySelectorAll("button[data-space]")) {
    btn.addEventListener("click", () => {
      if (state.workspace === btn.dataset.space) return;
      state.workspace = btn.dataset.space;
      try { localStorage.setItem(LS_SPACE, state.workspace); } catch { /* ignore */ }
      applySpace();
    });
  }
  applySpace();

  // scrolling IS browsing: the top card becomes the current image
  const col = document.getElementById("candidatesCol");
  let raf = 0;
  col.addEventListener("scroll", () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (state.lightbox.open) return;
      const file = topCardFile(col);
      if (!file || file === parseUrl().file) return;
      writeFeedHash(file);
      markCurrent();
      if (state.workspace === "details") renderDetails();
    });
  });
}

function applySpace() {
  document.getElementById("wsDetails").hidden = state.workspace !== "details";
  document.getElementById("wsAnchors").hidden = state.workspace !== "anchors";
  document.getElementById("wsBtnDetails").classList.toggle("on", state.workspace === "details");
  document.getElementById("wsBtnAnchors").classList.toggle("on", state.workspace === "anchors");
  if (state.workspace === "details") renderDetails();
}

// the last card whose top crossed the feed's vertical midpoint
function topCardFile(col) {
  const mid = col.getBoundingClientRect().top + col.clientHeight / 2;
  let file = null;
  for (const el of col.querySelectorAll(".card[data-idx]")) {
    if (el.getBoundingClientRect().top > mid) break;
    const img = state.images[Number(el.dataset.idx)];
    if (img) file = stripHostPrefix(state.host, img.filename);
  }
  return file;
}

// sky-blue ring on the card the URL names (hidden/absent → no ring, URL kept)
function markCurrent() {
  for (const el of document.querySelectorAll(".card.current")) el.classList.remove("current");
  const file = parseUrl().file;
  if (!file) return;
  for (const el of document.querySelectorAll(".card[data-idx]")) {
    const img = state.images[Number(el.dataset.idx)];
    if (img && stripHostPrefix(state.host, img.filename) === file) {
      el.classList.add("current");
      return;
    }
  }
}

// lightbox image while open, else the URL's file — hidden included
function detailsImage() {
  if (state.lightbox.open) {
    if (state.lightbox.col === "candidate") return state.images[state.lightbox.index] ?? null;
    return state.anchors[state.lightbox.anchorIndex ?? 0] ?? null;
  }
  const idx = findByFile(parseUrl().file);
  return idx >= 0 ? state.images[idx] : null;
}

function renderDetails() {
  const body = document.getElementById("wsDetailsBody");
  body.innerHTML = "";
  const img = detailsImage();
  if (!img) {
    const p = document.createElement("div");
    p.className = "info-none";
    p.textContent = "No image selected.";
    body.appendChild(p);
    return;
  }
  const head = document.createElement("div");
  head.className = "ws-head";
  const name = document.createElement("div");
  name.className = "ws-name";
  name.textContent = img.filename ?? img.name ?? "";
  name.title = img.filename ?? img.name ?? "";
  const sub = document.createElement("div");
  sub.className = "ws-sub";
  sub.textContent = img.host ? `host ${img.host}` : "local anchor";
  head.append(name, sub);
  body.appendChild(head);
  body.appendChild(buildMetaBody(img.meta ?? null));
}

// ring + details follow the URL; no hash writes here
onRender((s) => {
  if (typeof document === "undefined") return;
  markCurrent();
  if (s.workspace === "details") renderDetails();
});
