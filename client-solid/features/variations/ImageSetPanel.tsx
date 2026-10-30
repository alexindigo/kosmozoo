import { createEffect, createSignal, createMemo, onCleanup, For, Show } from "solid-js";
import { IconButton } from "../../components/IconButton.js";
import { iconSvg } from "/js/icons.mjs";
import { UPLOAD_IMG_EXT } from "../../store/fields.js";
import { focusMemory } from "./draft.js";
import { imageIdentity, uploadImage } from "./image-set.js";
import { InputPicker } from "./InputPicker.js";
import { FolderImages } from "./FolderImages.js";
import { Thumbnail } from "./Thumbnail.js";
import { SingleLineText } from "../../components/SingleLineText.js";
import { ParameterRow } from "./ParameterRow.js";

export function ImageSetPanel(props) {
  let fileInput;
  const row = () => props.row();
  const selected = name => row().items.some(item => item.kind === "input" && item.name === name);
  return <ParameterRow class="vz-imgrow vz-image-set" row={row} enabled={() => row().enabled}
    attributes={{ "data-image-id": props.id }} onEnable={props.onEnable}>
    <div class="vz-image-content">
      <Show when={row().items.length} fallback={<p class="vz-image-empty">Add images to vary this input.</p>}>
        <div class="vz-image-grid">
          <For each={row().items.map(imageIdentity)}>{identity => {
            const item = () => row().images.find(item => imageIdentity(item) === identity);
            return <ImageTile item={item} thumbnail={props.thumbnail} pathThumbnail={props.pathThumbnail} registerThumbnail={props.registerThumbnail} rememberFocus={props.rememberFocus} onRemove={() => props.onRemove(item())} />;
          }}</For>
        </div>
        <SingleLineText class="vz-image-summary" value={`${row().items.length} ${row().items.length === 1 ? "image" : "images"}${row().images.some(item => item.sameCurrent) ? ` · ${row().images.filter(item => item.sameCurrent).length} same as current` : ""}`} />
      </Show>
      <div class="vz-image-add">
        <InputPicker files={row().files} current={row().fromOutput ? null : row().current} selected={selected} positionRevision={row().images} thumbnail={props.thumbnail} registerThumbnail={props.registerThumbnail}
          onToggle={name => selected(name) ? props.onRemove({ kind: "input", name }) : props.onAdd([{ kind: "input", name }])}
          registerPopup={props.registerPopup} registerEditor={props.registerEditor} rememberFocus={props.rememberFocus} />
        <input type="file" ref={fileInput} class="vz-imgfilespick" hidden multiple accept="image/*" onChange={e =>
          props.onAdd([...e.currentTarget.files].filter(file => UPLOAD_IMG_EXT.test(file.name)).map(uploadImage))} />
        <button type="button" class="vz-image-action" title="Files from this browser" {...focusMemory(props.rememberFocus)} onClick={() => fileInput.click()}><SingleLineText value="Add files…" /></button>
        <FolderImages onAdd={props.onAddFolder} capability={props.folderCapability} onChoose={props.onChooseFolder}
          registerEditor={props.registerEditor} rememberFocus={props.rememberFocus} />
      </div>
    </div>
  </ParameterRow>;
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
  return <figure class="vz-image-tile" data-image-name={props.item()?.name}>
    <div class="vz-image-preview"><Thumbnail src={url()} name={name()} local={!!file()} lazy register={props.registerThumbnail} rememberFocus={props.rememberFocus} /></div>
    <figcaption><SingleLineText class="vz-image-name" value={props.item()?.name} hint={props.item()?.path} />
      <IconButton chrome variant="neutral" icon={iconSvg("x", 12)} title={`Remove ${props.item()?.name}`} onAction={props.onRemove} />
    </figcaption>
    <div class="vz-image-status">
      <SingleLineText role="status"
        class={props.item()?.error ? "vz-image-error" : props.item()?.pending ? "vz-image-check" : props.item()?.sameCurrent ? "vz-image-same" : ""}
        value={props.item()?.error || (props.item()?.pending ? "Checking image…" : props.item()?.sameCurrent ? "Same as current" : "")} />
    </div>
  </figure>;
}
