// client/js/diff.mjs — the workbench: a single-image viewer.
//
// Shows state.current (the single "current image" pointer) full-screen.
// Stripped to the studs: no composition modes, no blink, no zoom/pan, no
// stepping — those are being rebuilt on a better foundation. What remains:
// open the current image, close back to the feed (re-centering it), and the
// Escape shortcut. The image fits the stage via object-fit.

import { state } from "./state.mjs";
import { render } from "../app/services/notify.mjs";
import { resolveSide, setCurrent, stripHostPrefix, findByFile, diffUrl } from "./route.mjs";
import { restoreToIndex } from "./feed.mjs";
import { chrome } from "./chrome.mjs";

const $ = (id) => document.getElementById(id);

export function initDiff() {
  // The one workbench shortcut: Escape closes. Listed in the keys panel.
  chrome.bind("wb.close", "Escape", () => closeDiff(), {
    when: () => state.diff.open && !state.keysPanelOpen,
    ctx: "workbench",
    desc: "close the workbench",
  });
}

// --- opening ----------------------------------------------------------------

// Open the workbench on state.current.
export function openWorkbench() {
  if (!state.current || !resolveSide(state.current)) return false;
  state.diff.open = true;
  render();
  loadCurrent();
  return true;
}

// Feed card click: the current image is that candidate.
export function openFromFeed(imgIdx) {
  const image = state.images[imgIdx];
  if (!image) return;
  setCurrent(image.host, image.filename);
  openWorkbench();
}

// Anchor card click: the current image is that anchor.
export function openFromAnchor(anchorIdx) {
  const anchor = state.anchors[anchorIdx];
  if (!anchor) return;
  setCurrent("anchor", anchor.name);
  openWorkbench();
}

// Info-panel discovered image click: the current image is that input file.
export function openFromInput(host, file) {
  if (!host || !file) return;
  setCurrent(`input:${host}`, file);
  openWorkbench();
}

// Kept for the window.kosmozoo seam and /diff deep links. The pair view is
// gone — the workbench is a single-image viewer — so this opens the workbench
// on the left side and ignores the right. A push entry keeps the /diff URL so
// browser back/forward close/re-open via the route.
export function openDiff(left, right, { push } = {}) {
  if (!left || !resolveSide(left)) return false;
  setCurrent(left.source ?? left.remote, left.file ?? left.image);
  if (push && right) history.pushState({ kz: 1 }, "", diffUrl(left, right));
  return openWorkbench();
}

// --- closing ----------------------------------------------------------------

export function hideDiff() {
  if (!state.diff.open) return;
  state.diff.open = false;
  render();
}

export function closeDiff() {
  if (!state.diff.open) return;
  const c = state.current;
  hideDiff();
  if (location.pathname === "/diff") {
    // opened from a /diff URL: land back on the feed
    if (history.state?.kz) {
      history.back(); // a pushed entry: popstate lands on the feed URL
    } else {
      const feed = c && c.remote !== "anchor" && state.hosts[c.remote]
        ? `/#${encodeURIComponent(c.remote)}#${encodeURIComponent(stripHostPrefix(c.remote, c.image))}`
        : `/#${encodeURIComponent(state.host)}`;
      history.replaceState(null, "", feed);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  } else if (c && c.remote !== "anchor" && c.remote === state.host) {
    // opened from the feed: re-center it on the current image
    const idx = findByFile(stripHostPrefix(c.remote, c.image));
    if (idx >= 0) restoreToIndex(idx);
  }
}

// --- loading (generation guard: a stale load never clobbers a newer one) ---

let gen = 0;

async function loadCurrent() {
  const r = resolveSide(state.current);
  const el = $("diffImg");
  if (!r) { el.removeAttribute("src"); el.dataset.cur = ""; return; }
  const g = ++gen;
  chrome.status.active("wb-load", "loading image…");
  const img = new Image();
  img.src = r.src;
  try { await img.decode(); } catch { chrome.status.clear("wb-load"); return; }
  chrome.status.clear("wb-load");
  if (g !== gen || !state.diff.open) return; // superseded or closed mid-load
  if (el.dataset.cur !== r.src) { el.src = r.src; el.dataset.cur = r.src; }
}
