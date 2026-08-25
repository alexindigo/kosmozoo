// client/js/diff.mjs — the /diff comparison workbench.
//
// The URL /diff#<srcL>#<fileL>:<srcR>#<fileR> names the pair; everything
// else here is view state: composition mode, alignment, blink column,
// zoom/pan registrations. Sources resolve through route.resolveSide
// (configured hosts, local anchors — more feeds plug in later).
//
// Compositions: side (two figures), flicker (blink), blend (top
// opacity), split (draggable wipe), difference (mix-blend-mode).
// Alignment: shared registration vs independent per side — the
// box-fraction view state (geometry.mjs) makes identical registration
// work across differing dimensions.

import { state } from "./state.mjs";
import { render } from "../app/services/notify.mjs";
import { diffUrl, resolveSide } from "./route.mjs";
import { setVote, toggleFavorite } from "./judgment.mjs";
import { freshView, transform, panFrac, viewToPersisted, viewFromPersisted } from "./geometry.mjs";
import { getView, setView, flushViews } from "./views.mjs";
import { api } from "./api.mjs";

const $ = (id) => document.getElementById(id);

const MODES = ["flicker", "blend", "split", "difference", "side"];

export function initDiff() {
  document.addEventListener("keydown", onKey);

  const stage = $("diffStage");
  stage.addEventListener("wheel", onWheel, { passive: false });
  stage.addEventListener("pointerdown", onPointerDown);
  stage.addEventListener("dblclick", () => {
    writeBackViews();
    if (state.diff.alignment === "shared") state.diff.view = freshView();
    else state.diff.views[state.diff.col] = freshView();
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

async function onKey(e) {
  if (!state.diff.open) return;
  if (state.keysPanelOpen || state.capturing) return; // panel outranks
  const d = state.diff;
  switch (e.key) {
    case "Escape":
      e.preventDefault(); closeDiff(); return;
    case "ArrowLeft":
    case "ArrowRight":
      e.preventDefault();
      d.col = d.col === "left" ? "right" : "left";
      applyMode();
      return;
    case "c":
      e.preventDefault();
      d.composition = MODES[(MODES.indexOf(d.composition) + 1) % MODES.length];
      applyMode();
      return;
    case "a":
      e.preventDefault();
      writeBackViews();
      d.alignment = d.alignment === "shared" ? "independent" : "shared";
      applyMode();
      applyView();
      return;
    case "x":
      e.preventDefault();
      await swapSides();
      return;
    case "ArrowUp":
      e.preventDefault(); await step(e.shiftKey ? "right" : "left", -1); return;
    case "ArrowDown":
      e.preventDefault(); await step(e.shiftKey ? "right" : "left", 1); return;
    case "u":
      e.preventDefault(); await judge("up"); return;
    case "d":
      e.preventDefault(); await judge("down"); return;
    case "f":
      e.preventDefault(); await judge("favorite"); return;
  }
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

// --- the pair ---------------------------------------------------------

export function openDiff(left, right, { push } = {}) {
  if (!resolveSide(left) || !resolveSide(right)) return false;
  const d = state.diff;
  const reopen = d.open && sameSide(d.left, left) && sameSide(d.right, right);
  d.open = true;
  d.left = left;
  d.right = right;
  if (!reopen) {
    d.col = "left";
    d.view = viewFromPersisted(getView(sideKey(left))) ?? freshView();
    d.views = {
      left: viewFromPersisted(getView(sideKey(left))) ?? freshView(),
      right: viewFromPersisted(getView(sideKey(right))) ?? freshView(),
    };
    d.leftList = null;
    d.rightList = null;
  }
  const url = diffUrl(left, right);
  if (push) history.pushState({ kz: 1 }, "", url);
  else if (location.pathname + location.hash !== url) {
    history.replaceState(history.state, "", url);
  }
  render();
  applyMode();
  loadSide("left");
  loadSide("right");
  warmList("left");
  warmList("right");
  return true;
}

// URL already moved (popstate/hashchange): drop the view, no history writes
export function hideDiff() {
  const d = state.diff;
  if (!d.open) return;
  writeBackViews();
  d.open = false;
  d.left = null;
  d.right = null;
  d.leftList = null;
  d.rightList = null;
  render();
}

export function closeDiff() {
  if (!state.diff.open) return;
  const left = state.diff.left;
  writeBackViews();
  flushViews();
  hideDiff();
  if (history.state?.kz) {
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

function sameSide(a, b) {
  return a?.source === b?.source && a?.file === b?.file;
}

export function sideKey(side) {
  return side.source === "anchor" ? `anchor:${side.file}` : `${side.source}:${side.file}`;
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
  const img = new Image();
  img.src = r.src;
  try { await img.decode(); } catch { return; }
  if (gen !== gens[which] || !d.open) return;
  if (el.dataset.cur !== r.src) { el.src = r.src; el.dataset.cur = r.src; }
  el.dataset.nw = img.naturalWidth;
  el.dataset.nh = img.naturalHeight;
  applyView();
}

// fit box for an el inside the stage (or its half, in side mode)
function fitBox(el) {
  const nw = Number(el.dataset.nw) || 1, nh = Number(el.dataset.nh) || 1;
  const host = state.diff.composition === "side" ? el.closest(".diffside") : $("diffStage");
  const r = host.getBoundingClientRect();
  const scale = Math.min(r.width / nw, r.height / nh) || 1;
  return { w: nw * scale, h: nh * scale };
}

function viewFor(which) {
  const d = state.diff;
  if (d.alignment === "shared") return d.view;
  return d.views[which];
}

function applyView() {
  const sbs = state.diff.composition === "side";
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

// --- compositions ------------------------------------------------------

function applyMode() {
  const d = state.diff;
  const stage = $("diffStage");
  stage.dataset.mode = d.composition;
  const L = $("diffL"), R = $("diffR");
  L.style.mixBlendMode = "";
  L.style.clipPath = "";
  L.style.opacity = "";
  R.style.opacity = "";
  $("diffBlend").hidden = d.composition !== "blend";
  if (d.composition === "blend") $("diffBlend").value = String(d.blend);
  $("diffSplitLine").hidden = d.composition !== "split";
  if (d.composition === "split") $("diffSplitLine").style.left = `${d.split * 100}%`;
  if (d.composition === "flicker") {
    L.style.opacity = d.col === "left" ? "1" : "0";
    R.style.opacity = d.col === "right" ? "1" : "0";
  } else if (d.composition === "blend") {
    L.style.opacity = String(d.blend);
  } else if (d.composition === "split") {
    // left image left of the wipe, right image right of it
    L.style.clipPath = `inset(0 ${100 - d.split * 100}% 0 0)`;
  } else if (d.composition === "difference") {
    L.style.mixBlendMode = "difference";
  }
  $("diffMode").textContent = d.composition;
  $("diffAlign").textContent = d.alignment === "shared" ? "linked" : "unlinked";
  $("diffFL").classList.toggle("on", d.col === "left");
  $("diffFR").classList.toggle("on", d.col === "right");
  applyView();
}

// --- navigation ---------------------------------------------------------

async function warmList(which) {
  const d = state.diff;
  const side = which === "left" ? d.left : d.right;
  if (!side || side.source === "anchor") {
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
  const side = which === "left" ? d.left : d.right;
  let list = listFor(which);
  if (!list) { await warmList(which); list = listFor(which); } // warm may have raced a booting host
  if (!side || !list) return;
  const pos = list.findIndex((f) => f === side.file || f === side.source + "#" + side.file);
  if (pos < 0) return;
  const next = pos + dir;
  if (next < 0 || next >= list.length) return;
  writeBackViews();
  const nextSide = { source: side.source, file: side.source === "anchor" ? list[next] : stripFor(side, list[next]) };
  if (which === "left") d.left = nextSide; else d.right = nextSide;
  history.replaceState(history.state, "", diffUrl(d.left, d.right));
  // the next view arrives with its image (readBack inside loadSide path)
  const v = viewFromPersisted(getView(sideKey(nextSide)));
  if (d.alignment === "shared") d.view = v ?? freshView();
  else d.views[which] = v ?? freshView();
  prefetch(which, next, dir);
  render();
  applyMode();
  await loadSide(which);
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
  writeBackViews();
  [d.left, d.right] = [d.right, d.left];
  [d.leftList, d.rightList] = [d.rightList, d.leftList];
  [d.views.left, d.views.right] = [d.views.right, d.views.left];
  history.replaceState(history.state, "", diffUrl(d.left, d.right));
  render();
  applyMode();
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
  if (d.alignment === "shared") setView(sideKey(d.left), viewToPersisted(d.view));
  else {
    setView(sideKey(d.left), viewToPersisted(d.views.left));
    if (d.right) setView(sideKey(d.right), viewToPersisted(d.views.right));
  }
}

// --- pointer: wheel zoom + drag pan -------------------------------------

function onWheel(e) {
  if (!state.diff.open || state.diff.composition === "side") return;
  e.preventDefault();
  const d = state.diff;
  const el = d.col === "left" ? $("diffL") : $("diffR");
  if (!el.dataset.nw) return;
  const box = fitBox(el);
  const v = viewFor(d.col);
  const s2 = Math.min(Math.max(v.s * (e.deltaY < 0 ? 1.2 : 1 / 1.2), 0.2), 40);
  const r = $("diffStage").getBoundingClientRect();
  const px = e.clientX - (r.left + r.width / 2);
  const py = e.clientY - (r.top + r.height / 2);
  v.txf += (px / box.w) * (1 / s2 - 1 / v.s);
  v.tyf += (py / box.h) * (1 / s2 - 1 / v.s);
  v.s = s2;
  applyView();
}

let panning = null;

function onPointerDown(e) {
  if (!state.diff.open || state.diff.composition === "side") return;
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

// --- renderer -----------------------------------------------------------
//
// <DiffStage> owns the #diff hidden flag from state.diff.open. The old
// onRender writer re-applied the mode styling on every render while open;
// that styling is idempotent, so the renders that happen while open
// (openDiff, step, swapSides) call applyMode() explicitly instead.
