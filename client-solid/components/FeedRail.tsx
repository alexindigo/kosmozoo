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
// the measured imperative loop (rAF-coalesced) — the wave BOUNDS derive
// from the store-registered virtualizer's visible range (index math), and
// reactivity funnels view turnovers into the same paint.

import { onCleanup, createEffect } from "solid-js";
import { useAppStore } from "../store/app-store.js";
import { tapeWindow } from "/js/rail.mjs";

// rail geometry is owned by the CSS (#feedRail's --fr-* custom properties) —
// read once at setup so the capacity/scrub math can never silently desync
function railGeometry(rail) {
  const cs = getComputedStyle(rail);
  const px = (name, fallback) => {
    const v = parseFloat(cs.getPropertyValue(name));
    return Number.isFinite(v) ? v : fallback;
  };
  return {
    tickPx: px("--fr-tick-step", 5),
    labelTop: px("--fr-label-top", 14),
    labelBottom: px("--fr-label-bottom", 28),
  };
}

export function FeedRail() {
  const store = useAppStore();
  let rail;

  // the feed scroll element + virtualizer arrive via the store seam (Grid
  // registers them, after this component mounts) — the signal reads re-run
  // this effect when registration lands
  createEffect(() => {
    const col = store.state.feedScrollEl();
    const vz = store.state.feedVirtualizer();
    if (!rail || !col || !vz) return;

    const { tickPx, labelTop, labelBottom } = railGeometry(rail);

    let raf = 0;
    let tapeStart = 0;
    let tickEls = [];
    let topEl, bottomEl, totalEl;
    let lastViewLen = -1;

    const viewLength = () => store.state.view().length;
    const capacity = () => Math.max(0, Math.floor((rail.clientHeight - labelTop - labelBottom) / tickPx));

    // viewport-visible cards → view positions, derived from the virtualizer's
    // visible range (items outside the viewport are overscan — filtered by
    // the same intersection test the old rect walk applied). Index math, no
    // DOM walk. A hard ±8 px hysteresis band: meta-decode corrections move
    // tops by a few px each frame, and we must not flicker a boundary tick
    // on and off the wave
    const waveBounds = () => {
      const top = col.scrollTop + 8, bottom = top + col.clientHeight - 16;
      let first = -1, last = -1;
      for (const it of vz.getVirtualItems()) {
        if (it.end <= top || it.start >= bottom) continue;
        if (first < 0 || it.index < first) first = it.index;
        if (it.index > last) last = it.index;
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
      const k = Math.floor((e.clientY - r.top) / tickPx);
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
