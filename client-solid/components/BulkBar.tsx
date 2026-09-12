// client-solid/components/BulkBar.tsx — bulk actions on the selected images.
//
// Appears fixed under the header while at least one card is selected.
// Judgments are set-all (predictable for batches): thumbs-up makes every
// selected image up-voted. The selection survives vote/favorite/save so
// actions chain; only delete drops the affected images from it.

import { For, Show } from "solid-js";
import { iconSvg } from "/js/icons.mjs";
import { useAppStore } from "../store/app-store.js";
import { IconButton } from "./IconButton.js";

export function BulkBar() {
  const store = useAppStore();
  const n = () => Object.keys(store.state.selected).length;
  const deleteMode = () => store.state.hosts[store.state.host]?.deleteMode ?? "hide";

  return (
    <Show when={n() > 0}>
      <div id="bulkBar">
        <span id="bulkCount">{`${n()} selected`}</span>
        <For each={store.featureBulkActions()}>
          {(a) => <IconButton icon={a.icon} variant={a.variant} title={a.title} onAction={a.onAction} />}
        </For>
        <IconButton
          icon={iconSvg("thumb-down")} variant="down"
          title="thumbs-down all selected (hides, if down-vote hides is on)"
          onAction={() => store.actions.bulk.vote("down")}
        />
        <IconButton
          icon={iconSvg("thumb-up")} variant="up"
          title="thumbs-up all selected"
          onAction={() => store.actions.bulk.vote("up")}
        />
        <IconButton
          icon={iconSvg("star")} variant="favorite"
          title="favorite all selected"
          onAction={() => store.actions.bulk.favorite()}
        />
        <button
          class="savebtn" title="download all selected (the browser may ask to allow multiple)"
          onClick={() => store.actions.bulk.save()}
        >save</button>
        <IconButton
          icon={iconSvg(deleteMode() === "hide" ? "eye-off" : "trash", 16)} variant="delete"
          title={deleteMode() === "trash" ? "move all selected to trash on the host (recoverable)"
            : deleteMode() === "unlink" ? "delete all selected files from the host folder (permanent)"
              : "hide all selected from kosmozoo (this host can't delete files)"}
          onAction={() => store.actions.confirm.open({ images: store.actions.bulk.images() })}
        />
        <button id="bulkClear" title="clear selection" onClick={() => store.actions.bulk.clear()}>×</button>
      </div>
    </Show>
  );
}
