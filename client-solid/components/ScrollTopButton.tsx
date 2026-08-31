// client-solid/components/ScrollTopButton.tsx — a floating up-arrow in the
// bottom-left corner. Visible when the current image is not the feed's
// topmost card; clicking scrolls the feed back to the top.

import { Show } from "solid-js";
import { matchesFile } from "/js/route-parse.mjs";
import { useAppStore } from "../store/app-store.js";

const UP_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5" /><path d="M5 12l7-7 7 7" /></svg>';

export function ScrollTopButton() {
  const store = useAppStore();

  const visible = () => {
    const cur = store.state.current();
    const v = store.state.view();
    const topImage = v.length ? store.state.images[v[0]] : null;
    if (!cur || !topImage || store.state.diff.open) return false;
    const isTop = cur.remote === store.state.host()
      && matchesFile(topImage, store.state.host(), cur.image);
    return !isTop;
  };

  return (
    <Show when={visible()}>
      <button
        id="scrollTopBtn"
        title="back to top"
        onClick={() => store.actions.feed.scrollTop()}
        innerHTML={UP_SVG}
      />
    </Show>
  );
}
