// client/js/feedrail.mjs — the feed position rail.
//
// A narrow sliver at the left edge of the feed (Grok's edge indicator,
// mirrored to the left): a dense TAPE of small grey ticks — one per view
// item — with the viewport-visible images rendered over it as a WAVE of
// wider, brighter ticks. When the view is taller than the rail the tape
// windows itself: the wave runs inside the tape and the tape re-centers on
// it at the edges (tapeWindow below). The tape window's edge indices sit at
// the rail's top and bottom, the total count below. Click/drag scrubs: the
// tick under the cursor becomes the centered card.
//
// The rail is a plain flex child of <main> (a static div declared in App.mjs
// that pushes the feed column right, like the right rail pushes the
// workspace panels) — this module owns only its inner ticks/labels, so
// preact never re-renders it and <main>'s reconciliation can't drop it.

import { viewIndices, restoreToIndex } from "./feed.mjs";
import { subscribe } from "../app/services/notify.mjs";

const TICK_PX = 5;                 // 2px tick + 3px gap
const LABEL_TOP = 14, LABEL_BOTTOM = 28; // px reserved for the numbers

// The tape's start index given the wave's position. Holds while the wave is
// inside a quarter-capacity margin of the window (hysteresis — no constant
// sliding); re-centers on the wave past that. Clamps at both ends.
export function tapeWindow(viewLength, capacity, waveStart, waveEnd, tapeStart) {
  if (viewLength <= capacity || capacity <= 0) return 0;
  const maxStart = viewLength - capacity;
  const margin = Math.max(1, Math.floor(capacity / 4));
  if (waveStart >= tapeStart + margin && waveEnd <= tapeStart + capacity - margin) {
    return Math.max(0, Math.min(maxStart, tapeStart));
  }
  const center = Math.floor((waveStart + waveEnd) / 2);
  return Math.max(0, Math.min(maxStart, center - Math.floor(capacity / 2)));
}

export function initFeedRail() {
  const rail = document.getElementById("feedRail");
  const col = document.getElementById("candidatesCol");
  if (!rail || !col) return;

  let raf = 0;
  let tapeStart = 0;
  let tickEls = [];
  let topEl, bottomEl, totalEl;
  let lastViewLen = -1;

  const viewLength = () => viewIndices().length;
  const capacity = () => Math.max(0, Math.floor((rail.clientHeight - LABEL_TOP - LABEL_BOTTOM) / TICK_PX));

  // viewport-visible cards → view positions (DOM order = view order)
  const waveBounds = () => {
    const r = col.getBoundingClientRect();
    let first = -1, last = -1, i = 0;
    for (const el of col.querySelectorAll(".card[data-idx]")) {
      const b = el.getBoundingClientRect();
      if (b.bottom > r.top && b.top < r.bottom) { if (first < 0) first = i; last = i; }
      i++;
    }
    return first < 0 ? null : [first, last];
  };

  const labels = (N, cap) => {
    topEl.textContent = String(tapeStart + 1);
    bottomEl.textContent = String(Math.min(tapeStart + cap, N));
    totalEl.textContent = String(N);
  };

  const build = () => {
    const N = viewLength();
    rail.innerHTML = "";
    tickEls = [];
    if (N <= 1) { rail.style.visibility = "hidden"; return; }
    rail.style.visibility = "";
    const cap = capacity();
    const tape = document.createElement("div");
    tape.className = "fr-tape";
    for (let i = 0; i < Math.min(cap, N - tapeStart); i++) {
      const t = document.createElement("div");
      t.className = "fr-tick";
      tape.appendChild(t);
      tickEls.push(t);
    }
    topEl = document.createElement("div");
    topEl.className = "fr-num fr-top";
    bottomEl = document.createElement("div");
    bottomEl.className = "fr-num fr-bottom";
    totalEl = document.createElement("div");
    totalEl.className = "fr-num fr-total";
    rail.append(tape, topEl, bottomEl, totalEl);
    labels(N, cap);
  };

  const paint = () => {
    raf = 0;
    const N = viewLength();
    if (N <= 1) { rail.style.visibility = "hidden"; return; }
    rail.style.visibility = "";
    if (N !== lastViewLen) { // a new view: the old tape window is meaningless
      lastViewLen = N;
      tapeStart = 0;
      tickEls = [];
    }
    const cap = capacity();
    if (tickEls.length === 0 || (cap !== tickEls.length && cap < N)) build();
    const wb = waveBounds();
    if (!wb) return;
    const next = tapeWindow(N, cap, wb[0], wb[1], tapeStart);
    if (next !== tapeStart) { tapeStart = next; build(); }
    tickEls.forEach((el, k) => {
      const idx = tapeStart + k;
      el.classList.toggle("wave", idx >= wb[0] && idx <= wb[1]);
    });
    labels(N, cap);
  };

  const onScroll = () => { if (!raf) raf = requestAnimationFrame(paint); };

  // click/drag scrubs: the tick under the cursor becomes the centered card
  const scrub = (e) => {
    const N = viewLength();
    if (N <= 1) return;
    const tape = rail.querySelector(".fr-tape");
    if (!tape) return;
    const r = tape.getBoundingClientRect();
    const k = Math.floor((e.clientY - r.top) / TICK_PX);
    const viewPos = Math.max(0, Math.min(N - 1, tapeStart + k));
    const imgIdx = viewIndices()[viewPos];
    if (imgIdx != null) restoreToIndex(imgIdx);
  };
  let dragging = false;
  rail.addEventListener("pointerdown", (e) => { dragging = true; rail.setPointerCapture(e.pointerId); scrub(e); });
  rail.addEventListener("pointermove", (e) => { if (dragging) scrub(e); });
  rail.addEventListener("pointerup", () => { dragging = false; });

  // scroll + rebuilds + resizes all funnel into paint
  col.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll);
  subscribe(onScroll); // a render() means the view may have changed
  build();
  paint();
}
