// client-solid/components/Grid.tsx — the candidates feed as a virtualized window.
//
// @tanstack/solid-virtual (vendored, pristine + checksummed) owns the window
// math: which view indices render at the current scroll offset, top/bottom
// spacers, and scrollToIndex for deep jumps. The DOM only ever holds the
// window — restore/step costs O(window), not O(scroll position).
//
// The feed's invariant: a card mounts only when its size is known and never
// changes height while mounted. estimateSize IS cardHeight — exact for
// every mounted row — so the library's measurement pass is not wired and
// no timer coordinates geometry. A size landing that inserts an entry above
// the viewport is compensated by the feed itself (see below): the list does
// not shift.

import { onMount, onCleanup, createEffect } from "solid-js";
import { For, Show } from "solid-js";
import { createVirtualizer } from "@tanstack/solid-virtual";
import { useAppStore } from "../store/app-store.js";
import { WINDOW_PAD } from "../store/image-window.js";
import { cardHeight, gridGapPx, measureGeometry, invalidateGeometry } from "../store/sizes.js";
import { iconSvg } from "/js/icons.mjs";
import { Card } from "./Card.js";
import { IconButton } from "./IconButton.js";

export function Grid() {
  const store = useAppStore();
  // the feed's scroll container — Grid owns it and hands it to the store via
  // feed.register (the seam), so nothing walks the DOM by id
  let col;
  let probe;
  const scrollEl = () => col;

  // the virtualizer's item list is entriesWithKnownSize (the size-known
  // view) — count, keys and estimates ALL map through that ONE list, keyed
  // by entry id: a string, so identity is stable by construction. knownAt
  // is the store's feedEntryAt — the one feed→entry conversion
  const knownAt = (i) => store.state.feedEntryAt(i);

  const virtualizer = createVirtualizer({
    get count() { return store.state.entriesWithKnownSize().length; },
    getScrollElement: scrollEl,
    getItemKey: (i) => knownAt(i)?.id ?? i,
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
    store.actions.feed.register({ virtualizer, scrollEl: col });
    // scrolling is render + rail tracking only; the model (current selection,
    // snap tidy) moves at settle — the store owns the debounce. The handler
    // is the ONLY writer of the store's scrollTop signal (one signal, both
    // consumers: settle and the rail's wave)
    const onScroll = () => store.actions.feed.scrolled(col?.scrollTop ?? 0);
    col?.addEventListener("scroll", onScroll, { passive: true });
    onCleanup(() => col?.removeEventListener("scroll", onScroll));
    // the probe card makes the rendered geometry measurable on mount (no
    // waiting for a live card); a column-size change re-measures and re-runs
    // the estimates
    measureGeometry(probe, col?.clientWidth ?? 0);
    const ro = new ResizeObserver(() => {
      invalidateGeometry();
      measureGeometry(probe, col?.clientWidth ?? 0);
      virtualizer.measure();
    });
    if (col) ro.observe(col);
    onCleanup(() => ro.disconnect());
  });

  // The feed-owned above-fold rule: an entry above the viewport whose size
  // lands INSERTS a card above the fold and would shift the visible content.
  // The list must not shift — when insertions land above the item at the
  // viewport's top, the scroll position is compensated by their exact
  // heights in the same tick (estimates are exact, so the compensation is
  // exact). Not a virtualizer patch: the feed owns this rule.
  //
  // The rule fires ONLY for size landings: a landing does not change the
  // view (view does not subscribe to dims paths), so a known-list change
  // with a STABLE view is a landing — a vote, a reveal toggle, a filter, or
  // a host switch recomputes the view, and those shifts belong to the user.
  let prevView = null;
  let prevList = null;
  let anchor = { id: null, pos: 0 };
  const anchorNow = () => {
    const top = col?.scrollTop ?? 0;
    const items = virtualizer.getVirtualItems();
    const first = items.find((it) => it.end > top) ?? items[0];
    anchor = first
      ? { id: knownAt(first.index)?.id ?? null, pos: first.index }
      : { id: null, pos: 0 };
  };
  createEffect(() => {
    const v = store.state.view();
    const list = store.state.entriesWithKnownSize();
    virtualizer.getVirtualItems(); // the virtualizer's own reactivity
    const landing = prevView === v && prevList && prevList !== list;
    if (landing && anchor.id != null) {
      const prevSet = new Set(prevList);
      const newPos = list.findIndex((i) => store.state.images[i]?.id === anchor.id);
      if (newPos > anchor.pos) {
        let delta = 0;
        for (let k = anchor.pos; k < newPos; k++) {
          const id = store.state.images[list[k]]?.id;
          if (id == null || prevSet.has(id)) continue; // not a fresh insertion
          const s = store.state.cardSize(list[k]);
          // the DOM shift is the card AND its margin — the same value the
          // estimateSize formula returns for the inserted item
          if (s) delta += cardHeight(s, col?.clientWidth ?? 800) + gridGapPx();
        }
        if (delta > 0) {
          // compensation is a programmatic scroll, not a user gesture:
          // the settle's snap must not re-tidy the restored position
          store.actions.feed.quiet();
          col.scrollTop += delta;
        }
      }
    }
    prevView = v;
    prevList = list;
    // refresh the anchor from the post-compensation state
    anchorNow();
  });

  const items = () => virtualizer.getVirtualItems();
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
    <section
      id="candidatesCol"
      ref={(el) => { col = el; }}
    >
      <div id="grid">
        {/* the stable measuring card: styled by the card rule (class
 card--probe, so test/card selectors never see it) but never
 visible — the geometry constants are measured from IT, never
 from a live feed card. Mirrors the real card's chrome: the
 btnwrap's icon button drives the title row's height, and the
 notes rows' real labels wrap exactly like a live card's. */}
        <div class="card--probe" aria-hidden="true" ref={(el) => { probe = el; }}>
          <div class="imgwrap" />
          <div class="ctitle">
            <span class="ctitle-left">
              <input type="checkbox" class="selcb" tabindex="-1" />
              <span class="copyable">probe</span>
            </span>
            <span class="btnwrap">
              <IconButton icon={iconSvg("wand", 16)} variant="variations" title="probe" onAction={() => {}} />
              <button class="savebtn" tabindex="-1">save</button>
            </span>
          </div>
          <div class="pair">
            <div class="boxcol">
              <textarea class="neg" tabindex="-1" />
              <div class="btnrow"><button tabindex="-1">copy from below</button><button tabindex="-1">copy from above</button></div>
            </div>
            <div class="boxcol">
              <textarea class="pos" tabindex="-1" />
              <div class="btnrow"><button tabindex="-1">copy from below</button><button tabindex="-1">copy from above</button></div>
            </div>
          </div>
        </div>
        <div style={`height:${padStart()}px`} />
        <For each={items()}>
          {(vi) => <CardSlot entryId={vi.key} />}
        </For>
        <div style={`height:${padEnd()}px`}>
          <Show when={pending() > 0}>
            <div class="sentinel">{pending()} images measuring…</div>
          </Show>
          <Show when={count() > 0}>
            <div class="endoflist">
              {store.state.filter()
                ? `— all ${count()} matching “${store.state.filter()}” —`
                : `— all ${store.state.images.length} images —`}
            </div>
          </Show>
        </div>
      </div>
    </section>
  );
}

// One virtual slot: the .card contract wrapper + the Card. The slot receives
// the entry id (the virtualizer's item key — a string) and resolves the
// image through the store's id → index map — O(1), never a scan.
function CardSlot(props) {
  const store = useAppStore();
  const imgIdx = () => store.state.imageIdxById().get(props.entryId);
  const image = () => store.state.images[imgIdx()];
  const j = () => image()?.judgment ?? {};
  // the store's currentEntry memo owns the pointer→entry derivation (G7)
  const isCurrent = () => store.state.currentEntry()?.index === imgIdx();
  // the vote/comment foot sticks to the viewport ONLY when the card is
  // taller than it — on a fitting card the foot stays at the card's bottom
  // (sticky would otherwise clamp it to the card's top over the image)
  const isTall = () => {
    const el = store.state.feedScrollEl();
    const s = store.state.cardSize(imgIdx());
    if (!s || !el) return false;
    return cardHeight(s, el.clientWidth) + gridGapPx() > el.clientHeight;
  };

  return (
    <div
      class={"card" + (isCurrent() ? " current" : "") + (isTall() ? " card--tall" : "")}
      data-idx={imgIdx()}
      data-name={image()?.filename}
      data-vote={j().vote || undefined}
      data-favorite={j().favorite ? "1" : undefined}
    >
      <Card entryId={props.entryId} />
    </div>
  );
}
