// client-solid/components/Grid.tsx — the candidates feed as a virtualized window.
//
// @tanstack/solid-virtual (vendored, pristine + checksummed) owns the window
// math: which view indices render at the current scroll offset, top/bottom
// spacers, and scrollToIndex for deep jumps. The DOM only ever holds the
// window — restore/step costs O(window), not O(scroll position).
//
// The feed's invariant: a card mounts at known or terminally failed size and never
// changes height while mounted. estimateSize IS cardHeight — exact for
// every mounted row — so the library's measurement pass is not wired and
// no timer coordinates geometry. A size landing that inserts an entry above
// the viewport is compensated by the feed itself (see below): the list does
// not shift.

import { onMount, onCleanup, createEffect, createMemo, createSignal } from "solid-js";
import { For, Show } from "solid-js";
import { createVirtualizer } from "@tanstack/solid-virtual";
import { useAppStore } from "../store/app-store.js";
import { WINDOW_PAD } from "../store/image-window.js";
import { cardHeight, feedOffsets, feedEntryAtOffset, gridGapPx, measureGeometry, invalidateGeometry, geometryMeasured } from "../store/sizes.js";
import { Card } from "./Card.js";
import { EntryActions } from "./EntryActions.js";
import { TextField } from "./TextField.js";
import { FeedGlimmer } from "./FeedGlimmer.js";

export function Grid() {
  const store = useAppStore();
  // the feed's scroll container — Grid owns it and hands it to the store via
  // feed.register (the seam), so nothing walks the DOM by id
  let col;
  let probe;
  const scrollEl = () => col;
  const [viewportSize, setViewportSize] = createSignal({ width: 0, height: 0 });
  const measureViewport = () => {
    const width = col?.clientWidth ?? 0, height = col?.clientHeight ?? 0;
    setViewportSize((previous) => previous.width === width && previous.height === height ? previous : { width, height });
  };

  // The feed-owned above-fold rule: an entry above the viewport whose size
  // lands INSERTS a card above the fold and would shift the visible content.
  // The list must not shift — when insertions land above the item at the
  // viewport's top, the scroll position is compensated by their exact
  // heights in the same tick (estimates are exact, so the compensation is
  // exact). Not a virtualizer patch: the feed owns this rule. The store's
  // compensate port applies the delta, so the settle pipeline never reads
  // the re-based position as gesture travel.
  //
  // The rule fires ONLY for size landings: a landing does not change the
  // view (view does not subscribe to dims paths), so a known-list change
  // with a STABLE view is a landing — a vote, a reveal toggle, a filter, or
  // a host switch recomputes the view, and those shifts belong to the user.
  //
  // The anchor is never cached: it is the entry under the ACTUAL scroll
  // position in the layout the feed showed until this landing. Programmatic
  // writes (a restore's jump, the tidy, back-to-top, an earlier compensation)
  // move scrollTop before their scroll events, so a remembered anchor or
  // scroll signal can describe a position the feed has already left.
  //
  // The rule is part of deriving the list the virtualizer windows, not a
  // reaction to its render: `feed` is that ONE list (count and keys read it),
  // and deriving it re-bases the virtualizer's offset first. The window of a
  // changed list is therefore never computed at the uncompensated offset — a
  // merge that removes or inserts many rows above the viewport cannot push
  // the mounted cards under it out of the window for a render (the keyed For
  // would drop and re-create them). The DOM scroll write follows the render
  // (below), when the spacers already hold the new layout and cannot clamp it.
  let virtualizer;
  let prevView = null;
  let prevList = null;
  let prevMerge = -1;
  let previous = null;
  let pendingCompensation = 0;
  const layout = createMemo(() => {
    const entries = store.state.entriesWithKnownSize().map((i) => store.state.images[i]);
    return {
      order: entries.map((entry) => entry.id),
      offsets: feedOffsets(entries,
        (entry) => cardHeight(store.state.cardSize(store.state.imageIdxById().get(entry.id)), col?.clientWidth ?? 800) + gridGapPx()),
    };
  });
  const feed = createMemo(() => {
    const v = store.state.view();
    const list = store.state.entriesWithKnownSize();
    const merge = store.state.feedMergeNonce();
    const next = layout();
    // a landing with a stable view — or a refresh-MERGE (the nonce moved):
    // new entries arrived from the server and the visible cards must not
    // shift. A filter/vote/host switch recomputes the view WITHOUT the
    // nonce — those shifts belong to the user.
    const landing = (prevView === v && prevList && prevList !== list) || merge !== prevMerge;
    if (landing && previous && col) {
      // the actual position includes a compensation not yet written to the DOM
      const top = col.scrollTop + pendingCompensation;
      const anchorId = feedEntryAtOffset(previous.order, previous.offsets, top);
      if (anchorId != null && next.offsets.has(anchorId)) {
        const delta = next.offsets.get(anchorId) - previous.offsets.get(anchorId);
        if (delta !== 0) {
          pendingCompensation += delta;
          if (virtualizer && virtualizer.scrollOffset != null) virtualizer.scrollOffset = Math.max(0, top + delta);
        }
      }
    }
    prevView = v;
    prevList = list;
    prevMerge = merge;
    previous = next;
    return next;
  });

  // the virtualizer's item list is `feed`, the size-known view (above) —
  // count, keys and estimates ALL map through that ONE list, keyed by entry
  // id: a string, so identity is stable by construction.
  // A new ordered identity snapshot invalidates the virtualizer's geometry
  // even when count is unchanged (reorder/replacement is not a count change).
  const itemKey = createMemo(() => {
    const ids = feed().order;
    return (i) => ids[i] ?? i;
  });

  virtualizer = createVirtualizer({
    get count() { return feed().order.length; },
    getScrollElement: scrollEl,
    get getItemKey() { return itemKey(); },
    estimateSize: (i) => {
      const w = col?.clientWidth ?? 800;
      // exact for every mounted row: the card's own height PLUS the inter-
      // card margin — the DOM lays out both, so the item size counts both.
      // A 16:9 estimate only for an entry the live count getter has not yet
      // caught up with (a race, never a state)
      const s = store.state.cardSize(store.state.entriesWithKnownSize()[i]);
      return (s ? cardHeight(s, w) : cardHeight({ w: 16, h: 9 }, w)) + gridGapPx();
    },
    overscan: WINDOW_PAD,
  });

  onMount(() => {
    measureGeometry(probe, col?.clientWidth ?? 0);
    measureViewport();
    const unregister = store.actions.feed.register({ virtualizer, scrollEl: col,
      viewport: () => ({ ...viewportSize(), ready: geometryMeasured(), items: virtualizer.getVirtualItems() }) });
    onCleanup(unregister);
    // scrolling is render + rail tracking only; the model (current selection,
    // snap tidy) moves at settle — the store owns the debounce. The handler
    // is the ONLY writer of the store's scrollTop signal (one signal, both
    // consumers: settle and the rail's wave)
    const onScroll = () => store.actions.feed.scrolled(col?.scrollTop ?? 0);
    col?.addEventListener("scroll", onScroll, { passive: true });
    onCleanup(() => col?.removeEventListener("scroll", onScroll));
    // One feed boundary, not per-image timers. MediaBox declares the stable
    // allocation; its own zoom binding still owns the fitted crop and player.
    const onWheel = e => {
      const media = e.target instanceof Element ? e.target.closest('.media-box:not(.media-stage)') : null;
      const unit = e.deltaMode === 1 ? parseFloat(getComputedStyle(col).lineHeight) || 16 : e.deltaMode === 2 ? col.clientHeight : 1;
      const result = store.actions.feed.wheel({ media: !!media, ctrl: e.ctrlKey,
        dx: e.deltaX * unit, dy: e.deltaY * unit, cancelable: e.cancelable });
      if (result.prevent) e.preventDefault();
    };
    col.addEventListener("wheel", onWheel, { capture: true, passive: false });
    onCleanup(() => col.removeEventListener("wheel", onWheel, true));
    // the probe card makes the rendered geometry measurable on mount (no
    // waiting for a live card); a column-size change re-measures and re-runs
    // the estimates
    const ro = new ResizeObserver(() => {
      invalidateGeometry();
      measureGeometry(probe, col?.clientWidth ?? 0);
      virtualizer.measure();
      measureViewport();
    });
    if (col) ro.observe(col);
    onCleanup(() => ro.disconnect());
  });

  // The compensation already re-based the virtualizer's window; the scroll
  // container follows once the render has laid out the new spacers.
  createEffect(() => {
    feed();
    if (!pendingCompensation) return;
    const delta = pendingCompensation;
    pendingCompensation = 0;
    store.actions.feed.compensate(delta);
  });

  const items = () => virtualizer.getVirtualItems();
  // Measurement objects are replaced on insertion/resize. Render identity is
  // the entry ID, not that transient object, so mounted editors survive.
  const slotsById = createMemo(() => new Map(items().map((item) => [item.key, item])));
  const renderedIds = createMemo(() => [...slotsById().keys()]);
  const count = () => store.state.entriesWithKnownSize().length;
  const padStart = () => items()[0]?.start ?? 0;
  // the bottom spacer reserves the rest of totalSize — the DOM height equals
  // totalSize exactly (estimates are exact, so totalSize is exact)
  const padEnd = () => {
    const it = items();
    return Math.max(0, virtualizer.getTotalSize() - (it[it.length - 1]?.end ?? 0));
  };
  const pending = () => store.state.pendingSizeCount();

  return (
    <div class="feed-viewport">
    <section
      id="candidatesCol"
      ref={(el) => { col = el; }}
    >
      <Show when={store.state.noSources()}>
        <div class="feed-empty">
          <p>No sources yet — <button type="button" onClick={(e) => {
            e.stopPropagation();
            store.handles.invoke("source.menu.open");
          }}>add a ComfyUI host or folder</button></p>
        </div>
      </Show>
      <div id="grid">
        {/* the stable measuring card: styled by the card rule (class
 card--probe, so test/card selectors never see it) but never
 visible — the geometry constants are measured from IT, never
 from a live feed card. Mirrors the real card's chrome: the
 btnwrap's icon button drives the title row's height, and the
 notes rows' real labels wrap exactly like a live card's. */}
        <div class="card--probe" aria-hidden="true" ref={(el) => { probe = el; }}>
          <div class="imgwrap" style={{ height: "1px" }} />
          <div class="media-controls media-controls-probe" />
          <div class="ctitle">
            <span class="ctitle-left">
              <input type="checkbox" class="selcb" tabindex="-1" />
              <span class="copyable">probe</span>
            </span>
            <span class="btnwrap">
              <EntryActions target={{ id: "probe" }} judgmentType="toggle"
                deleteCapability={store.state.currentCollection()?.capabilities?.delete} />
            </span>
          </div>
          <div class="pair">
            <div class="boxcol">
              <TextField multiline tone="negative" class="neg" tabindex="-1" />
              <div class="btnrow"><button tabindex="-1">copy from below</button><button tabindex="-1">copy from above</button></div>
            </div>
            <div class="boxcol">
              <TextField multiline tone="positive" class="pos" tabindex="-1" />
              <div class="btnrow"><button tabindex="-1">copy from below</button><button tabindex="-1">copy from above</button></div>
            </div>
          </div>
        </div>
        <div style={`height:${padStart()}px`} />
        <For each={renderedIds()}>
          {(id) => <CardSlot entryId={id} slotSize={slotsById().get(id)?.size} />}
        </For>
        <div style={`height:${padEnd()}px`}>
          <Show when={pending() > 0}>
            <div class="sentinel">{pending()} images measuring…</div>
          </Show>
          <Show when={count() > 0}>
            <div class="endoflist">
              {store.state.filter()
                ? `— all ${count()} matching “${store.state.filter()}” —`
                : `— all ${count()} images —`}
            </div>
          </Show>
        </div>
      </div>
    </section>
    <Show when={store.state.host() && store.state.inventory.loading && store.state.inventory.revision === null}>
      <FeedGlimmer />
    </Show>
    </div>
  );
}

// One virtual slot: the .card contract wrapper + the Card. The slot receives
// the entry id (the virtualizer's item key — a string) and resolves the
// image through the store's id → index map — O(1), never a scan.
//
// THE LAST-MILE GATE. The virtualizer's key mapping and the store's reactive
// memos update on different clocks (reconcile mutates the items in place on
// the core's schedule), so a slot CAN be handed an id that resolves to no
// image or to an image whose size is not yet known. The invariant "a card
// mounts only at known size, and never changes height while mounted" is
// enforced HERE, not just at the list: until the size is final the slot
// renders a blank placeholder at the virtual item's OWN size — the rendered
// list always matches the virtualizer's scroll math exactly, and the card
// appears once, at its final height. No 16:9 floor box, no shrink, no jump.
function CardSlot(props) {
  const store = useAppStore();
  let cardEl;
  const imgIdx = () => store.state.imageIdxById().get(props.entryId);
  const image = () => store.state.images[imgIdx()];
  const ready = () => imgIdx() != null && store.state.cardSize(imgIdx()) != null;
  const j = () => image()?.judgment ?? {};
  const state = () => store.state.cardState(props.entryId);

  return (
    <Show
      when={ready()}
      fallback={<div class="card--slot-gap" style={`height:${Math.max(0, (props.slotSize ?? 0) - gridGapPx())}px`} />}
    >
      <div
        ref={cardEl} tabIndex={-1}
        onPointerDown={() => cardEl.focus({ preventScroll: true })}
        class={"card" + (state().current ? " current" : "")}
        style={{ ...state().style, height: `${cardHeight(store.state.cardSize(imgIdx()), store.state.feedScrollEl()?.clientWidth ?? 800)}px` }}
        data-treatment={state().treatment}
        data-idx={imgIdx()}
        data-name={image()?.filename}
        data-vote={j().vote || undefined}
        data-favorite={state().active.favorite ? "1" : undefined}
        data-bookmark={state().active.bookmark ? "1" : undefined}
      >
        <Card entryId={props.entryId} focused={() => cardEl?.contains(document.activeElement)} />
      </div>
    </Show>
  );
}
