// client-solid/components/Grid.tsx — the candidates feed as a virtualized window.
//
// @tanstack/solid-virtual (vendored) owns the window math: which view indices
// render at the current scroll offset, measured-element corrections,
// top/bottom spacers, and scrollToIndex for deep jumps. The DOM only ever
// holds the window — restore/step costs O(window), not O(scroll position).
//
// The image-src window (visible ∪ workbench ± WINDOW_PAD) stays with the
// store's image window — independent of the DOM window.

import { onMount, onCleanup, createEffect } from "solid-js";
import { For, Show } from "solid-js/web";
import { createVirtualizer, measureElement } from "@tanstack/solid-virtual";
import { matchesFile } from "/js/route-parse.mjs";
import { useAppStore } from "../store/app-store.js";
import { WINDOW_PAD } from "../store/image-window.js";
import { Card } from "./Card.js";

// measured chrome under the image box (title row + notes + meta bar)
const CHROME_PX = 178;

export function Grid() {
  const store = useAppStore();
  const scrollEl = () => document.getElementById("candidatesCol");

  const virtualizer = createVirtualizer({
    get count() { return store.state.view().length; },
    getScrollElement: scrollEl,
    getItemKey: (i) => store.state.view()[i] ?? i,
    estimateSize: (i) => {
      const img = store.state.images[store.state.view()[i]];
      const ar = img?.meta?.width && img?.meta?.height ? img.meta.width / img.meta.height : 1.5;
      return Math.round((scrollEl()?.clientWidth ?? 800) / ar + CHROME_PX);
    },
    measureElement: (el, entry, inst) => measureElement(el, entry, inst),
    overscan: WINDOW_PAD,
  });

  onMount(() => {
    store.actions.feed.register({ virtualizer });
    const col = scrollEl();
    const onScroll = () => store.actions.feed.safetyNet();
    col?.addEventListener("scroll", onScroll, { passive: true });
    onCleanup(() => col?.removeEventListener("scroll", onScroll));
    // scrolling IS browsing: the settled scroll makes the midpoint card
    // current (debounced — a fast scroll must not render per frame)
    let settleTimer = 0;
    const onSettle = () => {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settleTimer = 0;
        const c = scrollEl();
        if (c) store.actions.current.settleFromScroll(c);
      }, 150);
    };
    col?.addEventListener("scroll", onSettle, { passive: true });
    onCleanup(() => {
      col?.removeEventListener("scroll", onSettle);
      clearTimeout(settleTimer);
    });
  });

  // meta-want sweep when the view turns over (load/filter/judgment)
  createEffect(() => {
    store.state.view();
    store.actions.feed.wantRangeNow();
  });

  const items = () => virtualizer.getVirtualItems();
  const count = () => store.state.view().length;
  const hasMore = () => {
    const it = items();
    const endIdx = it[it.length - 1]?.index ?? -1;
    return count() > 0 && endIdx < count() - 1;
  };
  const padStart = () => items()[0]?.start ?? 0;
  // the bottom spacer ALWAYS reserves the rest of totalSize — the DOM height
  // must equal totalSize or deep scrollToIndex targets clamp short of the
  // tail and the reconcile loop gives up
  const padEnd = () => {
    const it = items();
    return Math.max(0, virtualizer.getTotalSize() - (it[it.length - 1]?.end ?? 0));
  };

  return (
    <>
      <div style={`height:${padStart()}px`} />
      <For each={items()}>
        {(vi) => <CardSlot vi={vi} virtualizer={virtualizer} />}
      </For>
      <div style={`height:${padEnd()}px`}>
        <Show when={hasMore()}>
          <div class="sentinel">loading more…</div>
        </Show>
        <Show when={!hasMore()}>
          <div class="endoflist">
            {store.state.filter()
              ? `— all ${count()} matching “${store.state.filter()}” —`
              : `— all ${store.state.images.length} images —`}
          </div>
        </Show>
      </div>
    </>
  );
}

// One virtual slot: the .card contract wrapper + the Card. The slot's image
// index is DERIVED (view position → image index), so a view turnover retargets
// the slot without remounting it.
function CardSlot(props) {
  const store = useAppStore();
  const idx = () => store.state.view()[props.vi.index];
  const image = () => store.state.images[idx()];
  const j = () => image()?.judgment ?? {};
  const isCurrent = () => {
    const cur = store.state.current();
    const im = image();
    return !!cur && !!im && cur.remote === store.state.host()
      && matchesFile(im, store.state.host(), cur.image);
  };

  let el;
  // (re-)register with the src window whenever the slot's image index changes;
  // re-measure too — the new image's aspect changes the slot size
  createEffect(() => {
    const i = idx();
    if (el) {
      el.setAttribute("data-idx", String(i));
      store.state.window.register(i)(el);
      props.virtualizer.measureElement(el);
    }
  });

  return (
    <div
      ref={(node) => {
        el = node;
        if (node) {
          // the index attrs must exist before the first measureElement call
          node.setAttribute("data-index", String(props.vi.index));
          node.setAttribute("data-idx", String(idx()));
          props.virtualizer.measureElement(node);
        }
      }}
      class={"card" + (isCurrent() ? " current" : "")}
      data-index={props.vi.index}
      data-idx={idx()}
      data-name={image()?.filename}
      data-vote={j().vote || undefined}
      data-favorite={j().favorite ? "1" : undefined}
    >
      <Card imgIdx={idx} />
    </div>
  );
}
