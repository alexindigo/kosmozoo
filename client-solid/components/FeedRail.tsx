// client-solid/components/FeedRail.tsx — the feed position rail.
//
// A narrow sliver at the left edge of the feed: a dense TAPE of small grey
// ticks — one per feed entry — with the viewport-visible images rendered over
// it as a WAVE of wider, brighter ticks. When the feed is taller than the
// rail the tape windows itself: the wave runs inside the tape and the tape
// re-centers on it at the edges (tapeWindow below). The tape window's edge
// indices sit at the rail's top and bottom, the total count below.
// Click/drag scrubs: the tick under the cursor becomes the centered card.
// Wheel browses the tape independently; actual feed motion resumes following.
//
// The tape and ticks are JSX : the wave bounds derive EXACTLY from the
// virtualizer's visible range — no hysteresis band ( existed only because
// tops moved; exact sizes mean they don't) — the tape window is the pure
// tapeWindow fold, and scroll reactivity is the store's scrollTop signal
// (Grid's handler is its only writer). No innerHTML rebuilds, no querySelector
// walks, no paint loop.

import { createSignal, createMemo, createEffect, createRenderEffect, untrack, onMount, onCleanup, For, Show } from "solid-js";
import { useAppStore } from "../store/app-store.js";
import { tapeWindow, scrollTapeOffset } from "/js/rail.mjs";
import { RailPreview } from "./RailPreview.js";

const BAND_TICKS = 20;
const HOVER_DELAY_MS = 120;

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
  const [hovered, setHovered] = createSignal(null), [preview, setPreview] = createSignal(null);
  let hoverTimer = null;
  const hidePreview = () => { clearTimeout(hoverTimer); hoverTimer = null; setHovered(null); setPreview(null); };
  const hover = (event, idx, tick) => {
    if (dragging || event.pointerType === "touch") return;
    hidePreview();
    const entry = store.state.feedEntryAt(idx);
    if (!entry) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const tickRect = tick.getBoundingClientRect();
    const target = { idx, id: entry.id, hash: entry.hash, entry,
      anchor: { left: rect.left, right: rect.right, top: tickRect.top, bottom: tickRect.bottom },
      size: store.state.cardSize(store.state.entriesWithKnownSize()[idx]) };
    setHovered(target);
    hoverTimer = setTimeout(() => { hoverTimer = null; if (hovered() === target) setPreview(target); }, HOVER_DELAY_MS);
  };
  createEffect(() => {
    const target = hovered();
    if (!target) return;
    const entry = store.state.feedEntryAt(target.idx);
    if (entry?.id !== target.id || target.hash && entry.hash && entry.hash !== target.hash) untrack(hidePreview);
  });
  const tickRefs = new Map();
  let arrivalEpoch;
  createEffect(() => {
    const event = store.state.railArrivalEvent();
    untrack(() => {
      if (arrivalEpoch !== event.epoch) for (const tick of tickRefs.values()) tick.cancel();
      arrivalEpoch = event.epoch;
      // Take the whole ready event now: off-tape/filtered ticks never play later.
      for (const id of store.actions.feed.takeArrivals(event)) tickRefs.get(id)?.glow();
    });
  });

  const recompute = () => {
    if (!rail) return;
    geom = railGeometry(rail);
    setCapacity(Math.max(0, Math.floor((rail.clientHeight - geom.labelTop - geom.labelBottom) / geom.tickPx)));
  };

  // the rail's index space is the size-known list — exactly what the
  // virtualizer renders (one tick per feed row; pending sizes are the
  // "measuring…" tail, not rows)
  const N = () => store.state.entriesWithKnownSize().length;
  // One read-only live target for the whole tape; cards keep committed current.
  const markerId = createMemo(() => store.state.feedMarkerEntryId());

  // viewport-visible cards → known-list positions, derived EXACTLY from the
  // virtualizer's visible range (items outside the viewport are overscan —
  // filtered by the intersection test). The scroll position is the store
  // signal's VALUE (Grid's handler is its only writer) — no DOM read.
  const waveBounds = createMemo(() => {
    const top = store.state.feedScrollTop();
    const n = N();
    const vz = store.state.feedVirtualizer();
    const col = store.state.feedScrollEl();
    if (!vz || !col || n <= 1) return null;
    const bottom = top + col.clientHeight;
    let first = -1, last = -1;
    for (const it of vz.getVirtualItems()) {
      if (it.end <= top || it.start >= bottom) continue;
      if (first < 0 || it.index < first) first = it.index;
      if (it.index > last) last = it.index;
    }
    return first < 0 ? null : [first, last];
  });

  // the tape window: the pure tapeWindow fold over the wave — ONE memo
  // with prev (no reset-to-0 on count change: a new feed re-centers
  // through the same fold instead of flickering the tape away and back)
  const followedStart = createMemo((prev) => {
    const wb = waveBounds();
    const cap = capacity();
    if (!wb || cap <= 0) return prev;
    return tapeWindow(N(), cap, wb[0], wb[1], prev);
  }, 0);

  // Presentation-only browsing, never another feed/current writer. Fractional
  // offsets accumulate smooth trackpad motion; rendered/scrubbed rows are whole.
  const [browsedStart, setBrowsedStart] = createSignal(null);
  createEffect(() => {
    store.state.feedMotionRevision();
    store.state.feedScrollEl();
    untrack(() => { setBrowsedStart(null); hidePreview(); });
  });
  const tapeStart = createMemo(() => Math.floor(Math.max(0, Math.min(
    Math.max(0, N() - capacity()), browsedStart() ?? followedStart(),
  ))));
  const onWheel = (e) => {
    e.preventDefault();
    hidePreview();
    setBrowsedStart(scrollTapeOffset(N(), capacity(), browsedStart() ?? tapeStart(),
      e.deltaY, e.deltaMode, geom.tickPx));
  };

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
    if (imgIdx != null) store.handles.invoke("feed.revealEntry", { id: store.state.images[imgIdx].id });
  };
  let dragging = false;
  const onDown = (e) => {
    hidePreview();
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
    rail.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("scroll", hidePreview, { capture: true, passive: true });
    window.addEventListener("resize", hidePreview, { passive: true });
    onCleanup(() => {
      hidePreview(); ro.disconnect(); rail.removeEventListener("wheel", onWheel);
      window.removeEventListener("scroll", hidePreview, true); window.removeEventListener("resize", hidePreview);
    });
  });

  return (
    <div
      id="feedRail"
      aria-label="feed position — scroll to browse; click or drag to jump"
      ref={(el) => { rail = el; }}
      style={{ visibility: N() <= 1 ? "hidden" : "" }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
    >
      <div class="fr-tape" ref={(el) => { tape = el; }}>
        <For each={ticks()}>
          {(idx) => {
            const entry = () => store.state.feedEntryAt(idx);
            const entryId = createMemo(() => entry()?.id);
            let el, animation;
            const cancel = () => { animation?.cancel(); animation = null; };
            const glow = () => {
              cancel();
              const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
              animation = el.animate({ offset: 0, backgroundColor: "var(--foreground-bright)",
                ...(reduced ? {} : { boxShadow: "0 0 5px var(--foreground-bright)" }) },
              { id: "rail-arrival", duration: 1400, easing: "ease-out", iterations: 1 });
            };
            // Numeric tape positions can acquire another identity without remounting.
            // Render effects register the new refs before the event-consumer effect.
            createRenderEffect(() => {
              const id = entryId();
              const binding = { glow, cancel };
              if (id) tickRefs.set(id, binding);
              onCleanup(() => { cancel(); if (tickRefs.get(id) === binding) tickRefs.delete(id); });
            });
            const state = () => store.state.cardState(entry()?.id, {
              current: !!entry() && entry().id === markerId(), surface: "rail",
            });
            return <div class="fr-row" classList={{ "fr-band-alt": Math.floor(idx / BAND_TICKS) % 2 === 1 }}
              onPointerEnter={event => hover(event, idx, el)} onPointerLeave={hidePreview}>
              <div class="fr-tick"
              ref={el}
              classList={{ wave: inWave(idx), current: state().current, hovered: preview()?.idx === idx }}
              style={state().style}
              data-entry-id={entry()?.id}
              data-treatment={state().treatment}
              />
            </div>;
          }}
        </For>
      </div>
      <div class="fr-num fr-top">{topLabel()}</div>
      <div class="fr-num fr-bottom">{bottomLabel()}</div>
      <div class="fr-num fr-total">{N()}</div>
      <Show when={preview()} keyed>{target => <RailPreview entry={target.entry} size={target.size}
        anchor={target.anchor} registerDisplay={store.actions.images.surface} />}</Show>
    </div>
  );
}
