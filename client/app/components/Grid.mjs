// client/app/components/Grid.mjs — the candidates feed as a virtualized window.
//
// @tanstack/virtual-core (vendored) owns the window math: which view indices
// render at the current scroll offset, measured-element corrections,
// top/bottom spacers, and scrollToIndex for deep jumps. The DOM only ever
// holds the window — restore/step costs O(window), not O(scroll position).
//
// The image-src window (visible ∪ workbench ± WINDOW_PAD) stays with
// useWindow — that's independent of the DOM window.
import { h, Fragment, Component } from "../../vendor/preact/vendor.mjs";
import { useEffect, useState } from "../../vendor/preact/vendor.mjs";
import { Virtualizer, elementScroll, observeElementRect, observeElementOffset, measureElement } from "../../vendor/tanstack/virtual-core.mjs";
import { state } from "../../js/state.mjs";
import { matchesFile } from "../../js/route.mjs";
import { subscribe } from "../services/notify.mjs";
import { useWindow, WINDOW_PAD } from "../hooks/useWindow.mjs";
import { Card } from "./Card.mjs";

// measured chrome under the image box (title row + notes + meta bar)
const CHROME_PX = 178;

class MemoCard extends Component {
  shouldComponentUpdate(n) {
    const p = this.props;
    return p.image !== n.image || p.imgIdx !== n.imgIdx || p.src !== n.src
      || p.meta !== n.meta || p.vote !== n.vote || p.fav !== n.fav
      || p.selected !== n.selected || p.fieldsVersion !== n.fieldsVersion;
  }
  render() { return h(Card, this.props); }
}

export function Grid({ view, onOpen, registerApi }) {
  // <Grid> is a root of its own (the feed engine renders it into #grid), so
  // it subscribes to the re-render signal itself instead of riding <App>.
  const [, setVersion] = useState(0);
  useEffect(() => subscribe(() => setVersion((v) => v + 1)), []);
  const win = useWindow();
  const scrollEl = document.getElementById("candidatesCol");
  const count = view.length;
  const [virtualizer] = useState(() => new Virtualizer({ count: 0, getScrollElement: () => scrollEl, estimateSize: () => 800 }));

  // framework-agnostic lifecycle mirrors the react wrapper: options sync on
  // every render; _willUpdate every render; _didMount once on mount.
  virtualizer.setOptions({
    count,
    getScrollElement: () => scrollEl,
    getItemKey: (i) => view[i] ?? i,
    estimateSize: (i) => {
      const img = state.images[view[i]];
      const ar = img?.meta?.width && img?.meta?.height ? img.meta.width / img.meta.height : 1.5;
      return Math.round((scrollEl?.clientWidth ?? 800) / ar + CHROME_PX);
    },
    scrollToFn: (offset, options, inst) => elementScroll(offset, options, inst),
    observeElementRect,
    observeElementOffset,
    measureElement: (el, entry, inst) => measureElement(el, entry, inst),
    overscan: WINDOW_PAD,
    onChange: () => setVersion((v) => v + 1),
  });
  virtualizer._willUpdate();

  useEffect(() => {
    const cleanup = virtualizer._didMount();
    return () => cleanup?.();
  }, [virtualizer]);

  useEffect(() => { registerApi?.({ win, virtualizer }); });

  const items = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const cur = state.current;
  const endIdx = items[items.length - 1]?.index ?? -1;
  const hasMore = count > 0 && endIdx < count - 1;

  const cardAt = (vi) => {
    const idx = view[vi.index];
    const image = state.images[idx];
    if (!image) return null;
    const j = image.judgment ?? {};
    const isCurrent = cur && cur.remote === state.host && matchesFile(image, state.host, cur.image);
    const fieldsVersion = JSON.stringify(state.fieldsCfg ?? {});
    return h("div", {
      key: image.id ?? idx,
      class: "card",
      "data-idx": idx,
      "data-name": image.filename,
      "data-vote": j.vote || undefined,
      "data-favorite": j.favorite ? "1" : undefined,
      ref: (el) => { win.register(idx)(el); if (el) virtualizer.measureElement(el); },
    }, h(MemoCard, {
      image,
      imgIdx: idx,
      src: win.getSrc(idx, image.id),
      meta: image.meta ?? null,
      vote: j.vote ?? null,
      fav: !!j.favorite,
      selected: state.selected.has(image.id),
      fieldsVersion,
      current: !!isCurrent,
      onOpen: () => onOpen?.(idx),
      onErrorClick: () => win.retry(idx),
      onImgPhase: (p) => {
        if (p === "loaded") win.markLoaded(idx);
        else if (p === "error") win.markError(idx);
      },
    }));
  };

  const padStart = items[0]?.start ?? 0;
  const padEnd = hasMore ? 0 : totalSize - (items[items.length - 1]?.end ?? 0);

  return h(Fragment, null,
    h("div", { style: `height:${padStart}px` }),
    items.map(cardAt),
    hasMore ? h("div", { class: "sentinel" }, "loading more…")
      : h("div", { style: `height:${padEnd}px` },
          h("div", { class: "endoflist" }, state.filter
            ? `— all ${view.length} matching “${state.filter}” —`
            : `— all ${state.images.length} images —`)),
  );
}
