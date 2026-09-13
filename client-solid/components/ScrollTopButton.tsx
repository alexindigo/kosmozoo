// client-solid/components/ScrollTopButton.tsx — a floating up-arrow in the
// bottom-left corner. Visible when the current image is not the feed's
// topmost card; clicking scrolls the feed back to the top.

import { Show } from "solid-js";
import { useAppStore } from "../store/app-store.js";

const UP_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5" /><path d="M5 12l7-7 7 7" /></svg>';

export function ScrollTopButton() {
  const store = useAppStore();

  const visible = () => {
    // the store's currentEntry memo owns the pointer→entry derivation (G7):
    // visible when the current entry is not the feed's topmost card
    const ce = store.state.currentEntry();
    const v = store.state.view();
    if (!ce || !v.length || store.state.diff.open) return false;
    return ce.index !== v[0];
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
