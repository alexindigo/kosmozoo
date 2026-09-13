// client-solid/components/Grid.tsx — the candidates feed as a virtualized window.
//
// @tanstack/solid-virtual (vendored, pristine + checksummed) owns the window
// math: which view indices render at the current scroll offset, top/bottom
// spacers, and scrollToIndex for deep jumps. The DOM only ever holds the
// window — restore/step costs O(window), not O(scroll position).
//
// §3.5's invariant: a card mounts only when its size is known and never
// changes height while mounted. estimateSize IS cardHeight() — exact for
// every mounted row — so the library's measurement pass is not wired and
// no timer coordinates geometry.

import { onMount, onCleanup, createEffect } from "solid-js";
import { For, Show } from "solid-js/web";
import { createVirtualizer } from "@tanstack/solid-virtual";
import { useAppStore } from "../store/app-store.js";
import { WINDOW_PAD } from "../store/image-window.js";
import { cardHeight, measureGeometry, geometryMeasured, invalidateGeometry } from "../store/sizes.js";
import { Card } from "./Card.js";

export function Grid() {
  const store = useAppStore();
  // the feed's scroll container — Grid owns it and hands it to the store via
  // feed.register (the seam), so nothing walks the DOM by id
  let col;
  const scrollEl = () => col;

  // §3.5: the virtualizer's item list is entriesWithKnownSize (the
  // size-known view) — count, keys and estimates ALL map through that ONE
  // list, keyed by entry id: a string, so identity is stable by
  // construction and the A1/A2 vendor patches are unnecessary
  const knownAt = (i) => store.state.images[store.state.entriesWithKnownSize()[i]];

  const virtualizer = createVirtualizer({
    get count() { return store.state.entriesWithKnownSize().length; },
    getScrollElement: scrollEl,
    getItemKey: (i) => knownAt(i)?.id ?? i,
    estimateSize: (i) => {
      const w = col?.clientWidth ?? 800;
      // exact for every mounted row; a 16:9 estimate only for an entry the
      // live count getter has not yet caught up with (a race, never a state)
      const s = store.state.cardSize(store.state.entriesWithKnownSize()[i]);
      return s ? cardHeight(s, w) : cardHeight({ w: 16, h: 9 }, w);
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
    // a column-size change is the only legitimate height change: re-measure
    // the rendered geometry constants, then re-run the estimates
    const ro = new ResizeObserver(() => {
      invalidateGeometry();
      measureGeometry(col?.clientWidth ?? 0);
      virtualizer.measure();
    });
    if (col) ro.observe(col);
    onCleanup(() => ro.disconnect());
    // the first mounted card makes the rendered geometry measurable —
    // measure it and re-run the estimates so every row switches from the
    // CSS-var fallback to the exact constants (§3.5: estimate === rect)
    const mo = new MutationObserver(() => {
      if (geometryMeasured() || !col?.querySelector(".card")) return;
      measureGeometry(col.clientWidth);
      if (geometryMeasured()) {
        mo.disconnect();
        virtualizer.measure();
      }
    });
    if (col) mo.observe(col, { childList: true, subtree: true });
    onCleanup(() => mo.disconnect());
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
// image on demand — nothing here re-measures anything.
function CardSlot(props) {
  const store = useAppStore();
  const image = () => store.state.images.find((i) => i.id === props.entryId);
  const imgIdx = () => store.state.images.indexOf(image());
  const j = () => image()?.judgment ?? {};
  // the store's currentEntry memo owns the pointer→entry derivation (G7)
  const isCurrent = () => store.state.currentEntry()?.index === imgIdx();

  return (
    <div
      class={"card" + (isCurrent() ? " current" : "")}
      data-idx={imgIdx()}
      data-name={image()?.filename}
      data-vote={j().vote || undefined}
      data-favorite={j().favorite ? "1" : undefined}
    >
      <Card imgIdx={imgIdx} />
    </div>
  );
}
