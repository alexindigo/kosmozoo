// client/js/diff.mjs — the workbench: ONE full-screen viewer.
//
// Comparison view and feed browser in a single surface. The URL
// /diff#<srcL>#<fileL>:<srcR>#<fileR> names an explicit pair; opened from
// the feed (card click / anchor card) the left side is the candidate and
// the right side the last-used anchor, and the viewer doubles as the
// feed's full-screen browser: Up/Down walk the filtered feed view (window
// + prefetch + feed hash), Esc re-centers the feed where browsing left off.
//
// Composition + alignment are the app-wide axes (state.axes, js/axes.mjs):
// flicker, blend, split, difference, side; shared / independent /
// face-anchored registration. Sources resolve through route.resolveSide
// (configured hosts, local anchors — more feeds plug in later).

import { state } from "./state.mjs";
import { render } from "../app/services/notify.mjs";
import { diffUrl, resolveSide, browseToFile, findByFile, parseUrl, stripHostPrefix } from "./route.mjs";
import { setVote, toggleFavorite } from "./judgment.mjs";
import { freshView, transform, panFrac, viewToPersisted, viewFromPersisted } from "./geometry.mjs";
import { getView, setView, flushViews } from "./views.mjs";
import { api } from "./api.mjs";
import { cycleAxis } from "./axes.mjs";
import { zoomToRoi } from "./roi.mjs";
import { viewStep, prefetchFrom, applyWindow, restoreToIndex } from "./feed.mjs";
import { chrome } from "./chrome.mjs";

const $ = (id) => document.getElementById(id);

export async function initDiff() {
  registerWorkbenchKeys();

  // the window resizes under a fitted pair — re-fit (rAF-debounced)
  let raf = 0;
  window.addEventListener("resize", () => {
    if (!state.diff.open || raf) return;
    raf = requestAnimationFrame(() => { raf = 0; applyMode(); });
  });

  // Detector status drives the face-anchored alignment need (absent ≠ broken).
  try {
    const plugins = await api.plugins();
    if (plugins.some((p) => p.name === "detector")) {
      const r = await fetch("/api/plugins/detector/status");
      state.detector = await r.json();
    }
  } catch {
    state.detector = { state: "absent" };
  }

  const stage = $("diffStage");
  stage.addEventListener("wheel", onWheel, { passive: false });
  stage.addEventListener("pointerdown", onPointerDown);
  stage.addEventListener("dblclick", () => {
    writeBackViews();
    if (state.axes.alignment === "independent") state.diff.views[state.diff.col] = freshView();
    else state.diff.view = freshView();
    applyView();
    writeBackViews();
  });

  const line = $("diffSplitLine");
  line.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    try { line.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    const move = (ev) => {
      const r = stage.getBoundingClientRect();
      state.diff.split = Math.min(Math.max((ev.clientX - r.left) / r.width, 0), 1);
      line.style.left = `${state.diff.split * 100}%`;
    };
    const up = () => {
      line.removeEventListener("pointermove", move);
      line.removeEventListener("pointerup", up);
    };
    line.addEventListener("pointermove", move);
    line.addEventListener("pointerup", up);
  });
}

// Workbench shortcuts are registered actions (ctx "workbench"), so the keys
// panel lists them — the bar itself stays free of shortcut hints. Each fires
// only while the workbench is open and no overlay outranks it.
function registerWorkbenchKeys() {
  const when = () => state.diff.open && !state.keysPanelOpen;
  const blink = () => {
    const d = state.diff;
    if (!d.left || !d.right) return; // single image — nothing to blink
    d.col = d.col === "left" ? "right" : "left";
    applyMode();
  };
  const frameRoi = () => {
    const d = state.diff;
    if (!state.roi) return;
    const v = zoomToRoi(viewFor(d.col) ?? freshView());
    if (state.axes.alignment === "independent") d.views[d.col] = v;
    else d.view = v;
    applyView();
  };
  const o = { when, ctx: "workbench" };
  chrome.bind("wb.close", "Escape", () => closeDiff(), { ...o, desc: "close the workbench" });
  chrome.bind("wb.blink.left", "ArrowLeft", blink, { ...o, desc: "blink candidate ↔ anchor" });
  chrome.bind("wb.blink.right", "ArrowRight", blink, { ...o, desc: "blink candidate ↔ anchor" });
  chrome.bind("wb.prev", "ArrowUp", () => step("left", -1), { ...o, desc: "previous candidate" });
  chrome.bind("wb.next", "ArrowDown", () => step("left", 1), { ...o, desc: "next candidate" });
  chrome.bind("wb.prev.right", "Shift+ArrowUp", () => step("right", -1), { ...o, desc: "previous right-side image" });
  chrome.bind("wb.next.right", "Shift+ArrowDown", () => step("right", 1), { ...o, desc: "next right-side image" });
  chrome.bind("wb.comp", "c", () => { cycleAxis("composition"); applyMode(); }, { ...o, desc: "cycle composition mode" });
  chrome.bind("wb.align", "a", () => { writeBackViews(); cycleAxis("alignment"); applyMode(); applyView(); }, { ...o, desc: "cycle alignment" });
  chrome.bind("wb.swap", "x", () => swapSides(), { ...o, desc: "swap the two sides" });
  chrome.bind("wb.vote.up", "u", () => judge("up"), { ...o, desc: "thumbs-up the left image" });
  chrome.bind("wb.vote.down", "d", () => judge("down"), { ...o, desc: "thumbs-down the left image" });
  chrome.bind("wb.fav", "f", () => judge("favorite"), { ...o, desc: "favorite the left image" });
  chrome.bind("wb.roi", "r", frameRoi, { ...o, desc: "zoom to the ROI" });
}

// save both sides: host images via the bytes route (host#file names, same
// convention as the card's save), anchors by their stored data URL
export function saveBoth() {
  for (const side of [state.diff.left, state.diff.right]) {
    if (!side) continue;
    if (side.source === "anchor") {
      const a = state.anchors.find((x) => x.name === side.file);
      if (a) download(a.src, a.name);
    } else {
      download(api.imageBytesUrl(`${side.source}:${side.file}`),
        `${side.source}#${side.file}`);
    }
  }
}

function download(href, name) {
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// the blend slider's input, forwarded by <DiffStage>
export function setBlend(value) {
  state.diff.blend = Number(value);
  applyMode();
}

// --- opening ----------------------------------------------------------------

function sameSide(a, b) {
  return a?.source === b?.source && a?.file === b?.file;
}

export function sideKey(side) {
  return side.source === "anchor" ? `anchor:${side.file}` : `${side.source}:${side.file}`;
}

const keyOf = (side) => (side ? sideKey(side) : null);

// The left side is "the feed's" when it names the currently loaded host —
// then Up/Down walk the filtered feed view and the URL stays the feed hash.
function isFeedSide(side) {
  return !!side && side.source === state.host;
}

function feedImageFor(side) {
  if (!isFeedSide(side)) return null;
  return state.images.find((i) =>
    i.filename === side.file || i.filename === side.source + "#" + side.file) ?? null;
}

function openWorkbench(left, right, { fromFeed = false, push = false } = {}) {
  if (!resolveSide(left) && !resolveSide(right)) return false;
  const d = state.diff;
  const reopen = d.open && sameSide(d.left, left) && sameSide(d.right, right);
  d.open = true;
  d.fromFeed = fromFeed;
  d.left = left;
  d.right = right;
  if (!reopen) {
    d.col = left ? "left" : "right";
    d.view = viewFromPersisted(getView(keyOf(left ?? right))) ?? freshView();
    d.views = {
      left: viewFromPersisted(getView(keyOf(left))) ?? freshView(),
      right: viewFromPersisted(getView(keyOf(right))) ?? freshView(),
    };
    d.leftList = null;
    d.rightList = null;
  }
  if (!fromFeed) {
    const url = diffUrl(left, right);
    if (push) history.pushState({ kz: 1 }, "", url);
    else if (location.pathname + location.hash !== url) {
      history.replaceState(history.state, "", url);
    }
  }
  render();
  loadSide("left");
  loadSide("right");
  warmList("left");
  warmList("right");
  return true;
}

// /diff URL entry: an explicit pair, both sides required.
export function openDiff(left, right, { push } = {}) {
  if (!resolveSide(left) || !resolveSide(right)) return false;
  return openWorkbench(left, right, { fromFeed: false, push });
}

// Feed card click: left = that candidate, right = the last-used anchor
// (single image when there are no anchors). The URL stays the feed hash.
// side.file keeps the filename EXACTLY: `source:file` must reconstruct the
// image id, and some hosts' filenames carry the host prefix.
export function openFromFeed(imgIdx) {
  const image = state.images[imgIdx];
  if (!image) return;
  const d = state.diff;
  d.candidateIdx = imgIdx;
  const anchor = state.anchors[d.anchorIndex ?? 0] ?? null;
  openWorkbench(
    { source: image.host, file: image.filename },
    anchor ? { source: "anchor", file: anchor.name } : null,
    { fromFeed: true },
  );
}

// Anchor card click: right = that anchor, left = the last candidate.
export function openFromAnchor(anchorIdx) {
  const anchor = state.anchors[anchorIdx];
  if (!anchor) return;
  const d = state.diff;
  d.anchorIndex = anchorIdx;
  const cand = d.candidateIdx >= 0 ? state.images[d.candidateIdx] : null;
  openWorkbench(
    cand ? { source: cand.host, file: cand.filename } : null,
    { source: "anchor", file: anchor.name },
    { fromFeed: true },
  );
}

// URL already moved (popstate/hashchange): drop the view, no history writes
export function hideDiff() {
  const d = state.diff;
  if (!d.open) return;
  writeBackViews();
  d.open = false;
  d.fromFeed = false;
  d.left = null;
  d.right = null;
  d.leftList = null;
  d.rightList = null;
  render();
}

export function closeDiff() {
  if (!state.diff.open) return;
  const d = state.diff;
  const left = d.left;
  const fromFeed = d.fromFeed;
  writeBackViews();
  flushViews();
  hideDiff();
  if (fromFeed) {
    // the hash already names the last browsed candidate — re-center the
    // feed where browsing left off
    const idx = findByFile(parseUrl().file);
    if (idx >= 0) restoreToIndex(idx);
  } else if (history.state?.kz) {
    history.back(); // popstate lands on the feed URL; onUrlChange applies it
  } else {
    const feed = left && state.hosts[left.source]
      ? `/#${encodeURIComponent(left.source)}#${encodeURIComponent(left.file)}`
      : `/#${encodeURIComponent(state.host)}`;
    history.replaceState(null, "", feed);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
  render();
}

// --- loading (harvest #1 + #3: generation guard; hold the outgoing
//     frame until the incoming image has decoded) -------------------------

const gens = { left: 0, right: 0 };

async function loadSide(which) {
  const d = state.diff;
  const side = which === "left" ? d.left : d.right;
  const r = resolveSide(side);
  const el = which === "left" ? $("diffL") : $("diffR");
  const lbl = which === "left" ? $("diffLblL") : $("diffLblR");
  lbl.textContent = side ? `${side.source}#${side.file}` : "";
  if (!r) { el.removeAttribute("src"); el.dataset.cur = ""; return; }
  const gen = ++gens[which];
  chrome.status.active("wb-load", "loading image…");
  const img = new Image();
  img.src = r.src;
  try { await img.decode(); } catch { chrome.status.clear("wb-load"); return; }
  chrome.status.clear("wb-load");
  if (gen !== gens[which] || !d.open) return;
  if (el.dataset.cur !== r.src) { el.src = r.src; el.dataset.cur = r.src; }
  el.dataset.nw = img.naturalWidth;
  el.dataset.nh = img.naturalHeight;
  applyView();
}

// fit box for an el inside the stage (or its half, in side mode)
function fitBox(el) {
  const nw = Number(el.dataset.nw) || 1, nh = Number(el.dataset.nh) || 1;
  const host = state.axes.composition === "side" ? el.closest(".diffside") : $("diffStage");
  const r = host.getBoundingClientRect();
  const scale = Math.min(r.width / nw, r.height / nh) || 1;
  return { w: nw * scale, h: nh * scale };
}

function viewFor(which) {
  const d = state.diff;
  if (state.axes.alignment === "independent") return d.views[which];
  return d.view;
}

function applyView() {
  const sbs = state.axes.composition === "side";
  for (const which of ["left", "right"]) {
    const el = which === "left" ? $("diffL") : $("diffR");
    if (sbs) {
      // side mode lays out via flex/object-fit; no manual registration
      el.style.width = "";
      el.style.height = "";
      el.style.transform = "";
      continue;
    }
    if (!el.dataset.nw) continue;
    const box = fitBox(el);
    el.style.width = box.w + "px";
    el.style.height = box.h + "px";
    el.style.transform = transform(viewFor(which), box);
  }
}

// --- compositions (the app-wide composition axis) --------------------------

function applyMode() {
  const d = state.diff;
  const mode = state.axes.composition;
  const stage = $("diffStage");
  stage.dataset.mode = mode;
  const L = $("diffL"), R = $("diffR");
  L.style.mixBlendMode = "";
  L.style.clipPath = "";
  L.style.opacity = "";
  R.style.opacity = "";
  $("diffBlend").hidden = mode !== "blend";
  if (mode === "blend") $("diffBlend").value = String(d.blend);
  $("diffSplitLine").hidden = mode !== "split";
  if (mode === "split") $("diffSplitLine").style.left = `${d.split * 100}%`;
  if (mode === "flicker") {
    L.style.opacity = d.col === "left" ? "1" : "0";
    R.style.opacity = d.col === "right" ? "1" : "0";
  } else if (mode === "blend") {
    L.style.opacity = String(d.blend);
  } else if (mode === "split") {
    // left image left of the wipe, right image right of it
    L.style.clipPath = `inset(0 ${100 - d.split * 100}% 0 0)`;
  } else if (mode === "difference") {
    L.style.mixBlendMode = "difference";
  }
  $("diffMode").textContent = mode;
  $("diffAlign").textContent = state.axes.alignment === "independent" ? "unlinked" : "linked";
  $("diffFL").classList.toggle("on", d.col === "left");
  $("diffFR").classList.toggle("on", d.col === "right");
  applyView();
}

// --- navigation ---------------------------------------------------------

async function warmList(which) {
  const d = state.diff;
  const side = which === "left" ? d.left : d.right;
  if (!side) return;
  if (side.source === "anchor") {
    if (which === "left") d.leftList = state.anchors.map((a) => a.name);
    else d.rightList = state.anchors.map((a) => a.name);
    return;
  }
  if (!state.hosts[side.source]) return;
  try {
    const list = (await api.images(side.source)).map((i) => i.filename);
    if (which === "left") d.leftList = list;
    else d.rightList = list;
  } catch { /* stepping just won't work for this side */ }
}

function listFor(which) {
  return which === "left" ? state.diff.leftList : state.diff.rightList;
}

function stripFor(side, filename) {
  const pfx = side.source + "#";
  return filename.startsWith(pfx) ? filename.slice(pfx.length) : filename;
}

async function step(which, dir) {
  const d = state.diff;
  // the feed's own host steps through the FILTERED view (the browser role);
  // every other source walks its raw file list
  if (which === "left" && isFeedSide(d.left)) return stepFeed(dir);
  const side = which === "left" ? d.left : d.right;
  let list = listFor(which);
  if (!list) { await warmList(which); list = listFor(which); }
  if (!side || !list) return;
  const pos = list.findIndex((f) => f === side.file || f === side.source + "#" + side.file);
  if (pos < 0) return;
  const next = pos + dir;
  if (next < 0 || next >= list.length) return;
  writeBackViews();
  const nextSide = { source: side.source, file: side.source === "anchor" ? list[next] : stripFor(side, list[next]) };
  if (which === "left") d.left = nextSide; else d.right = nextSide;
  if (!d.fromFeed) history.replaceState(history.state, "", diffUrl(d.left, d.right));
  // the next view arrives with its image
  const v = viewFromPersisted(getView(sideKey(nextSide)));
  if (state.axes.alignment === "independent") d.views[which] = v ?? freshView();
  else d.view = v ?? freshView();
  prefetch(which, next, dir);
  render();
  await loadSide(which);
}

// Feed browsing: walk the filtered view, move the feed's image window,
// write the feed hash — exactly what the outgoing lightbox did.
async function stepFeed(dir) {
  const d = state.diff;
  const img = feedImageFor(d.left);
  if (!img) return;
  const curIdx = state.images.indexOf(img);
  const nextIdx = viewStep(curIdx, dir);
  if (nextIdx === curIdx) return; // at the view's edge
  const next = state.images[nextIdx];
  writeBackViews();
  d.candidateIdx = nextIdx;
  d.left = { source: next.host, file: next.filename };
  d.col = "left";
  browseToFile(stripHostPrefix(next.host, next.filename));
  const v = viewFromPersisted(getView(sideKey(d.left)));
  if (state.axes.alignment === "independent") d.views.left = v ?? freshView();
  else d.view = v ?? freshView();
  prefetchFrom(nextIdx, dir);
  applyWindow();
  render();
  await loadSide("left");
}

function prefetch(which, pos, dir) {
  const d = state.diff;
  const side = which === "left" ? d.left : d.right;
  const list = listFor(which);
  for (let i = 1; i <= 2; i++) {
    const p = pos + dir * i;
    if (p < 0 || p >= list.length) break;
    const file = side.source === "anchor" ? list[p] : stripFor(side, list[p]);
    const r = resolveSide({ source: side.source, file });
    if (r) fetch(r.src).then((x) => x.arrayBuffer()).catch(() => {});
  }
}

async function swapSides() {
  const d = state.diff;
  if (!d.left || !d.right) return;
  writeBackViews();
  [d.left, d.right] = [d.right, d.left];
  [d.leftList, d.rightList] = [d.rightList, d.leftList];
  [d.views.left, d.views.right] = [d.views.right, d.views.left];
  if (!d.fromFeed) history.replaceState(history.state, "", diffUrl(d.left, d.right));
  render();
  await Promise.all([loadSide("left"), loadSide("right")]);
}

// --- judgments on the left side (host sources) -----------------------------

async function judge(kind) {
  const d = state.diff;
  const side = d.left;
  if (!side || side.source === "anchor") return;
  let img = state.images.find((i) => i.host === side.source &&
    (i.filename === side.file || i.filename === side.source + "#" + side.file));
  if (!img) {
    img = { id: sideKey(side), host: side.source, filename: side.file, judgment: null };
  }
  if (kind === "favorite") await toggleFavorite(img);
  else await setVote(img, kind === "up"
    ? (img.judgment?.vote === "up" ? null : "up")
    : (img.judgment?.vote === "down" ? null : "down"));
}

// --- view writes ------------------------------------------------------

function writeBackViews() {
  const d = state.diff;
  if (!d.left) return;
  if (state.axes.alignment === "independent") {
    setView(sideKey(d.left), viewToPersisted(d.views.left));
    if (d.right) setView(sideKey(d.right), viewToPersisted(d.views.right));
  } else {
    setView(sideKey(d.left), viewToPersisted(d.view));
  }
}

// --- pointer: wheel zoom + drag pan -------------------------------------

// Wheel input: two-finger scroll / mouse wheel PANS; pinch (which browsers
// report as ctrl+wheel) zooms toward the cursor. Zoom is proportional to the
// gesture's deltaY with a low intensity — the old fixed ±20% per event made
// pinching wildly oversensitive.
const PINCH_ZOOM = 0.005;

function onWheel(e) {
  if (!state.diff.open || state.axes.composition === "side") return;
  e.preventDefault();
  const d = state.diff;
  const el = d.col === "left" ? $("diffL") : $("diffR");
  if (!el.dataset.nw) return;
  const box = fitBox(el);
  const v = viewFor(d.col);
  if (e.ctrlKey) {
    const s2 = Math.min(Math.max(v.s * Math.exp(-e.deltaY * PINCH_ZOOM), 0.2), 40);
    const r = $("diffStage").getBoundingClientRect();
    const px = e.clientX - (r.left + r.width / 2);
    const py = e.clientY - (r.top + r.height / 2);
    v.txf += (px / box.w) * (1 / s2 - 1 / v.s);
    v.tyf += (py / box.h) * (1 / s2 - 1 / v.s);
    v.s = s2;
  } else {
    // scroll pans like a drag would (content follows the fingers)
    const [fx, fy] = panFrac(v, box, -e.deltaX, -e.deltaY);
    v.txf += fx;
    v.tyf += fy;
  }
  applyView();
}

let panning = null;

function onPointerDown(e) {
  if (!state.diff.open || state.axes.composition === "side") return;
  if (e.target.closest("#diffSplitLine, #diffClose, #diffBlend")) return;
  const stage = $("diffStage");
  panning = { x: e.clientX, y: e.clientY, id: e.pointerId };
  try { stage.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
  stage.classList.add("dragging");
}

document.addEventListener("pointermove", (e) => {
  if (!panning) return;
  const d = state.diff;
  const el = d.col === "left" ? $("diffL") : $("diffR");
  if (!el.dataset.nw) return;
  const box = fitBox(el);
  const v = viewFor(d.col);
  const [fx, fy] = panFrac(v, box, e.clientX - panning.x, e.clientY - panning.y);
  v.txf += fx;
  v.tyf += fy;
  panning.x = e.clientX;
  panning.y = e.clientY;
  applyView();
});

document.addEventListener("pointerup", () => {
  if (!panning) return;
  panning = null;
  $("diffStage").classList.remove("dragging");
  writeBackViews();
});
