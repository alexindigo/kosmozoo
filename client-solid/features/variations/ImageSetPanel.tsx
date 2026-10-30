import { createEffect, createSignal, createMemo, onCleanup, For, Show } from "solid-js";
import { IconButton } from "../../components/IconButton.js";
import { iconSvg } from "/js/icons.mjs";
import { UPLOAD_IMG_EXT } from "../../store/fields.js";
import { focusMemory } from "./draft.js";
import { imageIdentity, uploadImage } from "./image-set.js";
import { InputPicker } from "./InputPicker.js";
import { FolderImages } from "./FolderImages.js";
import { useImageDisplay } from "../../lib/img-measure.js";
import { SingleLineText } from "../../components/SingleLineText.js";

export function ImageSetPanel(props) {
  let fileInput;
  const row = () => props.row();
  const selected = name => row().items.some(item => item.kind === "input" && item.name === name);
  return <div class={"vz-imgrow vz-image-set" + (row().enabled ? " on" : "")} data-image-id={props.id}>
    <label class="vz-imgrow-head">
      <input type="checkbox" class="vz-cb" checked={row().enabled} onChange={e => props.onEnable(e.currentTarget.checked)} />
      <SingleLineText class="vz-imgrow-label" value={row().label} />
      <SingleLineText class="vz-imgrow-cur" value={row().current} />
    </label>
    <div class="vz-image-content">
      <Show when={row().items.length} fallback={<p class="vz-image-empty">No images added yet.</p>}>
        <div class="vz-image-grid">
          <For each={row().items.map(imageIdentity)}>{identity => {
            const item = () => row().images.find(item => imageIdentity(item) === identity);
            return <ImageTile item={item} thumbnail={props.thumbnail} pathThumbnail={props.pathThumbnail} registerThumbnail={props.registerThumbnail} onRemove={() => props.onRemove(item())} />;
          }}</For>
        </div>
        <SingleLineText class="vz-image-summary" value={`${row().items.length} images${row().images.some(item => item.sameCurrent) ? ` · ${row().images.filter(item => item.sameCurrent).length} same as current` : ""}`} />
      </Show>
      <div class="vz-image-add">
        <InputPicker files={row().files} current={row().fromOutput ? null : row().current} selected={selected} thumbnail={props.thumbnail} registerThumbnail={props.registerThumbnail}
          onToggle={name => selected(name) ? props.onRemove({ kind: "input", name }) : props.onAdd([{ kind: "input", name }])}
          registerPopup={props.registerPopup} registerEditor={props.registerEditor} rememberFocus={props.rememberFocus} />
        <input type="file" ref={fileInput} class="vz-imgfilespick" hidden multiple accept="image/*" onChange={e =>
          props.onAdd([...e.currentTarget.files].filter(file => UPLOAD_IMG_EXT.test(file.name)).map(uploadImage))} />
        <button type="button" class="vz-image-action" {...focusMemory(props.rememberFocus)} onClick={() => fileInput.click()}><SingleLineText value="Add files…" /></button>
        <FolderImages onAdd={props.onAddFolder} capability={props.folderCapability} onChoose={props.onChooseFolder}
          registerEditor={props.registerEditor} rememberFocus={props.rememberFocus} />
      </div>
    </div>
  </div>;
}

function ImageTile(props) {
  const [url, setUrl] = createSignal("");
  const file = createMemo(() => props.item()?.file), name = createMemo(() => props.item()?.name), path = createMemo(() => props.item()?.path);
  createEffect(() => {
    if (!name()) return;
    if (!file()) { setUrl(path() ? props.pathThumbnail(path()) : props.thumbnail(name())); return; }
    const src = URL.createObjectURL(file()); setUrl(src); onCleanup(() => URL.revokeObjectURL(src));
  });
  // Local File previews are object URLs; engine thumbnails are admitted
  // displays, registered only while the tile is near the viewport.
  let preview;
  const display = useImageDisplay(props.registerThumbnail, () => ({ id: file() || !url() ? null : url(), src: url() }),
    () => preview, { lazy: true });
  return <figure class="vz-image-tile" data-image-name={props.item()?.name}>
    <div class="vz-image-preview"><img ref={preview} src={display.read().src ?? undefined} alt="" onLoad={display.loaded} onError={display.loaded} /></div>
    <figcaption><SingleLineText class="vz-image-name" value={props.item()?.name} hint={props.item()?.path} />
      <IconButton chrome variant="neutral" icon={iconSvg("x", 12)} title={`Remove ${props.item()?.name}`} onAction={props.onRemove} />
    </figcaption>
    <Show when={props.item()?.sameCurrent}><SingleLineText class="vz-image-same" value="Same as current" /></Show>
    <Show when={props.item()?.pending}><SingleLineText class="vz-image-check" value="Checking image…" /></Show>
    <Show when={props.item()?.error}><span class="vz-image-error" role="status">{props.item().error}</span></Show>
  </figure>;
}
