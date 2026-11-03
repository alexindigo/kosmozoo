import { For, Show } from "solid-js";
import { Select } from "./Select.js";
import { iconSvg } from "/js/icons.mjs";

// Controlled native selection only. Inventory, persistence and navigation are
// inputs/callbacks owned by the store, not work performed by this component.
export function FolderPicker(props) {
  const caption = (folder, leaf = false) => {
    const name = folder ? leaf ? folder.split("/").at(-1) : folder : props.supported === false ? "Output root only" : "Output root (all subfolders)";
    const status = folder && props.unavailable && folder === props.value ? " (empty/unavailable)" : "";
    return { name, status, text: name + status };
  };
  const title = () => caption(props.value).text +
    (props.reason ? ` — ${props.reason}` : props.loading ? " — inventory loading" : "");
  return (
    <Show when={props.supported === true}><div id="folderPicker" class="folder-picker">
      <Select size="sm" id="outputFolder" aria-label={`Output folder: ${title()}`} title={title()}
        chevron={!!props.value} face={<>
          <span class="select-icon-slot" innerHTML={iconSvg("folder")} />
          <Show when={props.value}>
            <span class="single-line-text folder-picker-value">{caption(props.value, true).name}</span>
            <Show when={caption(props.value).status}><span class="single-line-text folder-picker-status">{caption(props.value).status}</span></Show>
          </Show>
        </>}
        value={props.value}
        aria-busy={props.loading} onChange={(e) => props.onSelect(e.currentTarget.value)}>
        <For each={props.options}>
          {(folder) => <option value={folder} title={caption(folder).text}>{"\u00a0\u00a0".repeat(Math.max(0, folder.split("/").length - 1)) + caption(folder).text}</option>}
        </For>
      </Select>
    </div></Show>
  );
}
