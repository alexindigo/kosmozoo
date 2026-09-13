// client-solid/components/FeedRail.tsx — the feed position rail.
//
// A narrow sliver at the left edge of the feed: a dense TAPE of small grey
// ticks — one per feed entry — with the viewport-visible images rendered over
// it as a WAVE of wider, brighter ticks. When the feed is taller than the
// rail the tape windows itself: the wave runs inside the tape and the tape
// re-centers on it at the edges (tapeWindow below). The tape window's edge
// indices sit at the rail's top and bottom, the total count below.
// Click/drag scrubs: the tick under the cursor becomes the centered card.
//
// The tape and ticks are JSX (§3.5): the wave bounds derive EXACTLY from the
// virtualizer's visible range — no hysteresis band (B10 existed only because
// tops moved; exact sizes mean they don't) — the tape window is the pure
// tapeWindow() fold, and scroll reactivity is the store's scrollTop signal
// (Grid's handler is its only writer). No innerHTML rebuilds, no querySelector
// walks, no paint loop.

import { createSignal, createEffect, createMemo, onMount, onCleanup, For } from "solid-js";
import { useAppStore } from "../store/app-store.js";
import { tapeWindow } from "/js/rail.mjs";

// rail geometry is owned by the CSS (#feedRail's --fr-* custom properties) —
// read at mount and on resize so the capacity/scrub math can never silently
// desync
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
  let tape;
  let geom = { tickPx: 5, labelTop: 14, labelBottom: 28 };
  const [capacity, setCapacity] = createSignal(0);

  const recompute = () => {
    if (!rail) return;
    geom = railGeometry(rail);
    setCapacity(Math.max(0, Math.floor((rail.clientHeight - geom.labelTop - geom.labelBottom) / geom.tickPx)));
  };

  // the rail's index space is the size-known list — exactly what the
  // virtualizer renders (one tick per feed row; pending sizes are the
  // "measuring…" tail, not rows)
  const N = () => store.state.entriesWithKnownSize().length;

  // viewport-visible cards → known-list positions, derived EXACTLY from the
  // virtualizer's visible range (items outside the viewport are overscan —
  // filtered by the intersection test). Tracks the store's scroll signal;
  // Grid's handler is its only writer.
  const waveBounds = createMemo(() => {
    store.state.feedScrollTop(); // the scroll reactivity
    const n = N();
    const vz = store.state.feedVirtualizer();
    const col = store.state.feedScrollEl();
    if (!vz || !col || n <= 1) return null;
    const top = col.scrollTop;
    const bottom = top + col.clientHeight;
    let first = -1, last = -1;
    for (const it of vz.getVirtualItems()) {
      if (it.end <= top || it.start >= bottom) continue;
      if (first < 0 || it.index < first) first = it.index;
      if (it.index > last) last = it.index;
    }
    return first < 0 ? null : [first, last];
  });

  // the tape window: the pure tapeWindow() fold over the wave
  const [tapeStart, setTapeStart] = createSignal(0);
  createEffect(() => {
    const wb = waveBounds();
    const cap = capacity();
    if (!wb || cap <= 0) return;
    const next = tapeWindow(N(), cap, wb[0], wb[1], tapeStart());
    if (next !== tapeStart()) setTapeStart(next);
  });
  // a new feed (filter/judgment/host): the old tape window is meaningless
  createEffect(() => { N(); setTapeStart(0); });

  const ticks = createMemo(() => {
    const count = Math.max(0, Math.min(capacity(), N() - tapeStart()));
    const out = new Array(count);
    for (let k = 0; k < count; k++) out[k] = tapeStart() + k;
    return out;
  });
  const inWave = (idx) => {
    const wb = waveBounds();
    return !!wb && idx >= wb[0] && idx <= wb[1];
  };

  const topLabel = () => tapeStart() + 1;
  const bottomLabel = () => Math.min(tapeStart() + capacity(), N());

  // click/drag scrubs: the tick under the cursor becomes the centered card
  const scrub = (e) => {
    const n = N();
    if (n <= 1 || !tape) return;
    const r = tape.getBoundingClientRect();
    const k = Math.floor((e.clientY - r.top) / geom.tickPx);
    const pos = Math.max(0, Math.min(n - 1, tapeStart() + k));
    const imgIdx = store.state.entriesWithKnownSize()[pos];
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

  onMount(() => {
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(rail);
    onCleanup(() => ro.disconnect());
  });

  return (
    <div
      id="feedRail"
      title="feed position — click or drag to jump"
      ref={(el) => { rail = el; }}
      style={{ visibility: N() <= 1 ? "hidden" : "" }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
    >
      <div class="fr-tape" ref={(el) => { tape = el; }}>
        <For each={ticks()}>
          {(idx) => <div class="fr-tick" classList={{ wave: inWave(idx) }} />}
        </For>
      </div>
      <div class="fr-num fr-top">{topLabel()}</div>
      <div class="fr-num fr-bottom">{bottomLabel()}</div>
      <div class="fr-num fr-total">{N()}</div>
    </div>
  );
}
