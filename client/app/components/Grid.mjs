// client/app/components/Grid.mjs — the candidates feed, declared.
//
// Renders the view's rendered prefix as <Card>s and owns the image window via
// useWindow (visibility -> src). The chunk sentinel sits WINDOW_PAD cards
// before the rendered end (the outgoing feed's buffer) and asks the engine for
// the next chunk when it is seen; at the end of the list the end-of-list
// marker takes its place.

import { h, Fragment, Component } from "../../vendor/preact/vendor.mjs";
import { useEffect, useRef, useState } from "../../vendor/preact/vendor.mjs";
import { state } from "../../js/state.mjs";
import { matchesFile, parseUrl } from "../../js/route.mjs";
import { subscribe } from "../services/notify.mjs";
import { useWindow, WINDOW_PAD } from "../hooks/useWindow.mjs";
import { Card } from "./Card.mjs";

// A feed can hold thousands of cards; a window/judgment change must re-render
// only the cards it touches, not the whole list. The memo gate compares the
// card's real inputs (image, position, src, meta, vote, favorite) and skips
// the rest. Callbacks are intentionally not compared — they are stable in
// behavior (they capture the card's index).
class MemoCard extends Component {
  shouldComponentUpdate(n) {
    const p = this.props;
    return p.image !== n.image || p.imgIdx !== n.imgIdx || p.src !== n.src
      || p.meta !== n.meta || p.vote !== n.vote || p.fav !== n.fav;
  }
  render() { return h(Card, this.props); }
}

export function Grid({ view, count, onOpen, onSentinel, registerApi }) {
  // <Grid> is a root of its own (the feed engine renders it into #grid), so
  // it subscribes to the re-render signal itself instead of riding <App>.
  const [, setVersion] = useState(0);
  useEffect(() => subscribe(() => setVersion((v) => v + 1)), []);
  const win = useWindow();
  const sentinelRef = useRef(null);

  // the feed engine reaches the window through this (applyWindow / retryImage)
  useEffect(() => { registerApi?.(win); });

  // sentinel -> next chunk
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) onSentinel?.();
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, [count, onSentinel]);

  const urlFile = parseUrl().file;
  const hasMore = count < view.length;
  const trigger = hasMore ? Math.max(0, count - WINDOW_PAD) : -1;

  const cardAt = (i) => {
    const idx = view[i];
    const image = state.images[idx];
    if (!image) return null;
    const j = image.judgment ?? {};
    const isCurrent = urlFile && matchesFile(image, state.host, urlFile);
    return h("div", {
      key: image.id ?? idx,
      class: "card" + (isCurrent ? " current" : ""),
      "data-idx": idx,
      "data-name": image.filename,
      "data-vote": j.vote || undefined,
      "data-favorite": j.favorite ? "1" : undefined,
      ref: win.register(idx),
    }, h(MemoCard, {
      image,
      imgIdx: idx,
      src: win.getSrc(idx, image.id),
      meta: image.meta ?? null,
      vote: j.vote ?? null,
      fav: !!j.favorite,
      onOpen: () => onOpen?.(idx),
      onErrorClick: () => win.retry(idx),
      onImgPhase: (p) => {
        if (p === "loaded") win.markLoaded(idx);
        else if (p === "error") win.markError(idx);
      },
    }));
  };

  const children = [];
  for (let i = 0; i < count; i++) {
    if (i === trigger) children.push(h("div", { key: "__sentinel", class: "sentinel", ref: sentinelRef }, "loading more…"));
    children.push(cardAt(i));
  }
  if (hasMore) {
    if (trigger >= count) children.push(h("div", { key: "__sentinel", class: "sentinel", ref: sentinelRef }, "loading more…"));
  } else {
    children.push(h("div", {
      key: "__end",
      class: "endoflist",
    }, state.filter
      ? `— all ${view.length} matching “${state.filter}” —`
      : `— all ${state.images.length} images —`));
  }

  return h(Fragment, null, children);
}
