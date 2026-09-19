// client-solid/components/ScrollTopButton.tsx — a floating up-arrow in the
// bottom-left corner. Visible when the current image is not the feed's
// topmost card; clicking scrolls the feed back to the top.

import { Show } from "solid-js";
import { iconSvg } from "/js/icons.mjs";
import { useAppStore } from "../store/app-store.js";

export function ScrollTopButton() {
  const store = useAppStore();

  const visible = () => {
    // the store's currentEntry memo owns the pointer→entry derivation :
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
        innerHTML={iconSvg("arrow-up", 18)}
      />
    </Show>
  );
}
