import { For } from "solid-js";

// Controlled native selection only. Inventory, persistence and navigation are
// inputs/callbacks owned by the store, not work performed by this component.
export function FolderPicker(props) {
  const caption = (folder) => {
    if (!folder) return props.supported === false ? "Output root only" : "Output root (all subfolders)";
    const depth = folder.split("/").length - 1;
    return "\u00a0\u00a0".repeat(depth) + folder + (props.unavailable && folder === props.value ? " (empty/unavailable)" : "");
  };
  const title = () => (props.value || "Output root (including descendants)") +
    (props.reason ? ` — ${props.reason}` : props.loading ? " — inventory loading" : "");
  return (
    <div id="folderPicker" class="folder-picker">
      <select id="outputFolder" aria-label="Output folder" title={title()}
        value={props.value} disabled={props.supported === false || props.supported == null}
        aria-busy={props.loading} onChange={(e) => props.onSelect(e.currentTarget.value)}>
        <For each={props.options}>
          {(folder) => <option value={folder} title={folder || "Output root (including descendants)"}>{caption(folder)}</option>}
        </For>
      </select>
    </div>
  );
}
