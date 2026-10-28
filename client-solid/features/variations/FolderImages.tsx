import { createSignal, onCleanup, Show } from "solid-js";
import { focusMemory } from "./draft.js";

// Presentation-only acquisition form; the private editor owns listing acceptance
// and selection. Unadded path text never becomes a second image-set field.
export function FolderImages(props) {
  const [path, setPath] = createSignal(""), [busy, setBusy] = createSignal(false), [message, setMessage] = createSignal("");
  let alive = true;
  onCleanup(() => { alive = false; });
  const add = async () => {
    if (busy() || !path()) return;
    setBusy(true); setMessage("");
    try {
      const result = await props.onAdd(path());
      if (alive) setMessage(result.count ? "" : "No images found in this folder.");
    } catch (error) { if (alive) setMessage(error.message); }
    finally { if (alive) setBusy(false); }
  };
  return <div class="vz-folder">
    <div class="vz-folder-controls">
      <input class="vz-folder-path" type="text" aria-label="Folder on this computer" placeholder="/path/to/folder" value={path()}
        {...focusMemory(props.rememberFocus)} onInput={e => setPath(e.currentTarget.value)}
        onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
      <button type="button" class="vz-image-action vz-folder-add" disabled={busy() || !path()} onClick={add}>{busy() ? "Reading…" : "Add"}</button>
    </div>
    <span class="vz-folder-help">Folder on the engine host, including subfolders. Up to 500 images.</span>
    <Show when={message()}><span class="vz-image-error" role="status">{message()}</span></Show>
  </div>;
}
