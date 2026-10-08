// client-solid/components/BulkBar.tsx — bulk actions on the selected images.
//
// Appears fixed under the header while at least one card is selected.
// Judgments are set-all (predictable for batches): thumbs-up makes every
// selected image up-voted. The selection survives vote/favorite/save so
// actions chain; only delete drops the affected images from it.

import { For, Show } from "solid-js";
import { iconSvg } from "/js/icons.mjs";
import { useAppStore } from "../store/app-store.js";
import { deleteCopy } from "../lib/delete-copy.js";
import { IconButton } from "./IconButton.js";

export function BulkBar() {
  const store = useAppStore();
  const n = () => Object.keys(store.state.selected).length;
  // capabilities.delete from the CURRENT COLLECTION's record ( fixed by
  // construction — the old read indexed hosts with the host signal function)
  const del = () => store.state.currentCollection()?.capabilities?.delete ?? "hide";
  const copy = () => deleteCopy(del());

  return (
    <Show when={n() > 0}>
      <div id="bulkBar">
        <span id="bulkCount">{`${n()} selected`}</span>
        <For each={store.state.featureBulkActions()}>
          {(a) => <IconButton icon={a.icon} variant={a.variant} title={a.title} onAction={() => store.handles.invoke(a.command, a.args)} />}
        </For>
        <IconButton
          icon={iconSvg("thumb-down")} variant="down"
          title="thumbs-down all selected (hides, if down-vote hides is on)"
          onAction={() => store.handles.invoke("judgment.apply", { target: "selected", intent: { type: "set", patch: { vote: "down" } } })}
        />
        <IconButton
          icon={iconSvg("thumb-up")} variant="up"
          title="thumbs-up all selected"
          onAction={() => store.handles.invoke("judgment.apply", { target: "selected", intent: { type: "set", patch: { vote: "up" } } })}
        />
        <IconButton
          icon={iconSvg("star")} variant="favorite"
          title="favorite all selected"
          onAction={() => store.handles.invoke("judgment.apply", { target: "selected", intent: { type: "set", patch: { favorite: true } } })}
        />
        <button
          class="savebtn" title="download all selected (the browser may ask to allow multiple)"
          onClick={() => store.handles.invoke("image.download", { target: "selected" })}
        >save</button>
        <IconButton
          icon={iconSvg(copy().icon, 16)} variant="delete"
          title={copy().bulkTitle}
          onAction={() => store.handles.invoke("image.delete.request", { target: "selected" })}
        />
        <button id="bulkClear" title="clear selection" onClick={() => store.handles.invoke("selection.clear")}>×</button>
      </div>
    </Show>
  );
}
