// client-solid/components/BulkBar.tsx — bulk actions on the selected images.
//
// Appears fixed under the header while at least one card is selected.
// Judgments are set-all (predictable for batches): thumbs-up makes every
// selected image up-voted. The selection survives vote/favorite/save so
// actions chain; only delete drops the affected images from it.

import { Show } from "solid-js";
import { iconSvg } from "/js/icons.mjs";
import { useAppStore } from "../store/app-store.js";
import { IconButton } from "./IconButton.js";
import { EntryActions } from "./EntryActions.js";

export function BulkBar() {
  const store = useAppStore();
  const n = () => Object.keys(store.state.selected).length;
  // capabilities.delete from the CURRENT COLLECTION's record ( fixed by
  // construction — the old read indexed hosts with the host signal function)
  const del = () => store.state.currentCollection()?.capabilities?.delete ?? null;

  return (
    <Show when={n() > 0}>
      <div id="bulkBar">
        <IconButton icon={iconSvg("x")} variant="clear-selection" title="Clear selection"
          onAction={() => store.handles.invoke("selection.clear")} />
        <span id="bulkCount">{`${n()} selected`}</span>
        <EntryActions target={{ target: "selected" }} judgmentType="set" deleteCapability={del()} />
      </div>
    </Show>
  );
}
