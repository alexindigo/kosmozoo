import { createSignal, onCleanup, Show } from "solid-js";
import { focusMemory } from "./draft.js";
import { IconButton } from "../../components/IconButton.js";
import { iconSvg } from "/js/icons.mjs";

// Presentation-only acquisition form; the private editor owns listing acceptance
// and selection. Unadded path text never becomes a second image-set field.
export function FolderImages(props) {
  const [path, setPath] = createSignal(""), [busy, setBusy] = createSignal(false), [message, setMessage] = createSignal("");
  const [choosing, setChoosing] = createSignal(false);
  let alive = true, suspended = false, chooser, revision = 0;
  const cancel = () => { chooser?.abort(); chooser = null; setChoosing(false); };
  onCleanup(() => { alive = false; cancel(); });
  onCleanup(props.registerEditor({ suspend() { suspended = true; cancel(); }, resume() { suspended = false; } }));
  const choose = async () => {
    if (busy() || choosing() || suspended || !props.capability()?.available) return;
    const controller = new AbortController(), captured = revision;
    chooser = controller; setChoosing(true); setMessage("");
    try {
      const result = await props.onChoose(path(), controller.signal);
      if (alive && !suspended && !controller.signal.aborted && revision === captured && result.path !== null) {
        setPath(result.path); revision++;
      }
    } catch (error) { if (alive && !controller.signal.aborted) setMessage(error.message); }
    finally { if (alive && chooser === controller) { chooser = null; setChoosing(false); } }
  };
  const add = async () => {
    if (busy() || choosing() || suspended || !path()) return;
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
        {...focusMemory(props.rememberFocus)} onInput={e => { revision++; setPath(e.currentTarget.value); }}
        onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
      <span class="vz-folder-chooser" title={props.capability()?.available ? "Choose folder…" : "Folder chooser needs the desktop app"}>
        <IconButton chrome variant="neutral" icon={iconSvg("folder", 16)}
          title={!props.capability()?.available ? "Folder chooser needs the desktop app" : choosing() ? "Choosing folder…" : "Choose folder…"}
          disabled={!props.capability()?.available || busy() || choosing()} onAction={choose} />
      </span>
      <button type="button" class="vz-image-action vz-folder-add" disabled={busy() || choosing() || !path()} onClick={add}>{busy() ? "Reading…" : "Add"}</button>
    </div>
    <span class="vz-folder-help">Folder on the engine host, including subfolders. Up to 500 images.</span>
    <Show when={!props.capability()?.available}><span class="vz-folder-help">Folder chooser needs the desktop app</span></Show>
    <Show when={message()}><span class="vz-image-error" role="status">{message()}</span></Show>
  </div>;
}
