import { For, Show } from "solid-js";
import { Select } from "./Select.js";
import { iconSvg } from "/js/icons.mjs";

// Controlled native selection only. Inventory, persistence and navigation are
// inputs/callbacks owned by the store, not work performed by this component.
export function FolderPicker(props) {
  const caption = (folder) => {
    if (!folder) return props.supported === false ? "Output root only" : "Output root (all subfolders)";
    const depth = folder.split("/").length - 1;
    return "\u00a0\u00a0".repeat(depth) + folder + (props.unavailable && folder === props.value ? " (empty/unavailable)" : "");
  };
  const title = () => (props.value || "Output root (all subfolders)") +
    (props.reason ? ` — ${props.reason}` : props.loading ? " — inventory loading" : "");
  return (
    <Show when={props.supported === true}><div id="folderPicker" class="folder-picker">
      <Select size="sm" id="outputFolder" aria-label={title()} title={title()}
        chevron={!!props.value} face={<>
          <span class="select-icon-slot" innerHTML={iconSvg("folder")} />
          <Show when={props.value}><span class="single-line-text folder-picker-value">{props.value.split("/").at(-1)}</span></Show>
        </>}
        value={props.value}
        aria-busy={props.loading} onChange={(e) => props.onSelect(e.currentTarget.value)}>
        <For each={props.options}>
          {(folder) => <option value={folder} title={folder || "Output root (including descendants)"}>{caption(folder)}</option>}
        </For>
      </Select>
    </div></Show>
  );
}
