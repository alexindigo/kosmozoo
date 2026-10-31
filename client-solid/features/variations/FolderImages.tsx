import { createSignal, createUniqueId, onCleanup, Show } from "solid-js";
import { focusMemory } from "./draft.js";
import { IconButton } from "../../components/IconButton.js";
import { iconSvg } from "/js/icons.mjs";
import { SingleLineText } from "../../components/SingleLineText.js";

// Presentation-only acquisition form; the private editor owns listing acceptance
// and selection. Unadded path text never becomes a second image-set field.
export function FolderImages(props) {
  const id = `vz-folder-${createUniqueId()}`;
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
    <label for={id}>Folder on the engine computer</label>
    <div class="vz-folder-controls">
      <input id={id} class="vz-folder-path" type="text" aria-describedby={message() ? `${id}-message` : undefined} placeholder="/path/to/folder" value={path()} title="Includes subfolders. Maximum 500 images per folder import."
        {...focusMemory(props.rememberFocus)} onInput={e => { revision++; setPath(e.currentTarget.value); }}
        onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
      <span class="vz-folder-chooser" title={props.capability()?.available ? "Choose folder…" : "Folder chooser needs the desktop app"}>
        <IconButton chrome size="md" variant="neutral" icon={iconSvg("folder")}
          title={!props.capability()?.available ? "Folder chooser needs the desktop app" : choosing() ? "Choosing folder…" : "Choose folder…"}
          disabled={!props.capability()?.available || busy() || choosing()} onAction={choose} />
      </span>
      <button type="button" class="vz-image-action vz-folder-add" disabled={busy() || choosing() || !path()} onClick={add}><SingleLineText value={busy() ? "Reading…" : "Add folder"} /></button>
    </div>
    <Show when={message()}><span class="vz-image-error" id={`${id}-message`} role="status">{message()}</span></Show>
  </div>;
}
