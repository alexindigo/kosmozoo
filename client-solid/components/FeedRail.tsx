// client-solid/components/FeedRail.tsx — the feed position rail.
//
// A narrow sliver at the left edge of the feed: a dense TAPE of small grey
// ticks — one per view item — with the viewport-visible images rendered over
// it as a WAVE of wider, brighter ticks. When the view is taller than the
// rail the tape windows itself: the wave runs inside the tape and the tape
// re-centers on it at the edges (tapeWindow below). The tape window's edge
// indices sit at the rail's top and bottom, the total count below.
// Click/drag scrubs: the tick under the cursor becomes the centered card.
//
// The component owns the rail div's lifecycle; the tick/wave paint stays
// the measured imperative loop (rAF-coalesced) — reactivity funnels view
// turnovers into the same paint.

import { onMount, onCleanup, createEffect } from "solid-js";
import { useAppStore } from "../store/app-store.js";

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

export function FeedRail() {
  const store = useAppStore();
  let rail;

  onMount(() => {
    const col = document.getElementById("candidatesCol");
    if (!rail || !col) return;

    let raf = 0;
    let tapeStart = 0;
    let tickEls = [];
    let topEl, bottomEl, totalEl;
    let lastViewLen = -1;

    const viewLength = () => store.state.view().length;
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
      const imgIdx = store.state.view()[viewPos];
      if (imgIdx != null) store.actions.feed.restoreToIndex(imgIdx);
    };
    let dragging = false;
    const onDown = (e) => {
      dragging = true;
      // synthetic events (probes) carry no active pointer — capture is a
      // nicety for real drags, never a hard requirement
      try { rail.setPointerCapture(e.pointerId); } catch { /* no active pointer */ }
      scrub(e);
    };
    const onMove = (e) => { if (dragging) scrub(e); };
    const onUp = () => { dragging = false; };
    rail.addEventListener("pointerdown", onDown);
    rail.addEventListener("pointermove", onMove);
    rail.addEventListener("pointerup", onUp);

    // scroll + rebuilds + resizes all funnel into paint
    col.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    // a view turnover (filter/judgment/host) repaints the tape (the effect
    // inherits the component root, so it disposes with it)
    createEffect(() => { store.state.view(); onScroll(); });
    build();
    paint();

    onCleanup(() => {
      cancelAnimationFrame(raf);
      rail.removeEventListener("pointerdown", onDown);
      rail.removeEventListener("pointermove", onMove);
      rail.removeEventListener("pointerup", onUp);
      col.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    });
  });

  return (
    <div
      id="feedRail"
      title="feed position — click or drag to jump"
      ref={(el) => { rail = el; }}
    />
  );
}
