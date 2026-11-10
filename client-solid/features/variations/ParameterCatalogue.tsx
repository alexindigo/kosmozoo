import { For, Show, onMount, onCleanup, createSignal } from "solid-js";
import { parameterInputName, parameterNodeTitle, parameterContext } from "./field-filter.js";
import { IconButton } from "../../components/IconButton.js";
import { iconSvg } from "/js/icons.mjs";
import { SingleLineText } from "../../components/SingleLineText.js";
import { isFileDrag, droppedFiles } from "./image-drop.js";
import { Thumbnail } from "./Thumbnail.js";

export function ParameterCatalogue(props) {
  return <div class="vz-catalogue-list">
    <For each={props.sections}>{section => <>
      <For each={section.nodes}>{node => <>
        <For each={node.ids}>{id => <CatalogueRow row={() => props.row(id)} matches={props.matches}
          thumbnail={props.thumbnail} registerThumbnail={props.registerThumbnail}
          onAdd={() => props.onAdd(id)} onFiles={resources => props.onFiles(id, resources)} registerFocus={focus => props.registerFocus(id, focus)} />}</For>
      </>}</For>
    </>}</For>
    <Show when={props.ready && !props.anyMatch}><SingleLineText class="vz-loading vz-filter-empty" value="No unadded fields match" /></Show>
  </div>;
}

function CatalogueRow(props) {
  let add;
  const [dropping, setDropping] = createSignal(false);
  onMount(() => { const dispose = props.registerFocus(() => add.focus()); onCleanup(dispose); });
  const row = () => props.row();
  return <div class="vz-catalogue-row" classList={{ "vz-catalogue-hidden": row().enabled || !props.matches(row()), "vz-image-dropping": dropping() }} data-catalogue-id={row().id}
    onDragEnter={event => { if (row().domain === "images" && isFileDrag(event.dataTransfer)) { event.preventDefault(); setDropping(true); } }}
    onDragOver={event => { if (row().domain === "images" && isFileDrag(event.dataTransfer)) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setDropping(true); } }}
    onDragLeave={() => setDropping(false)} onDrop={event => { if (row().domain !== "images" || !isFileDrag(event.dataTransfer)) return; event.preventDefault(); setDropping(false); props.onFiles(droppedFiles(event.dataTransfer)); }}>
    <div class="vz-catalogue-context">
      <SingleLineText class="vz-catalogue-node-name" value={parameterNodeTitle(row())} hint={row().label} />
      <SingleLineText class="vz-catalogue-name" value={parameterInputName(row())} hint={row().label} />
      <Show when={row().domain === "images"} fallback={<SingleLineText class="vz-catalogue-current" value={parameterContext(row())} />}>
        <div class="vz-catalogue-picture" title={parameterContext(row())}>
          <Thumbnail src={props.thumbnail(row())} name={parameterContext(row())} lazy register={props.registerThumbnail}
            surface={picture => <div class="vz-thumbnail-surface" role="img" aria-label={parameterContext(row())}>{picture}</div>} />
        </div>
      </Show>
    </div>
    <IconButton buttonRef={element => add = element} chrome size="sm" variant="plain vz-catalogue-add" title={`Add ${row().label}`}
      onAction={props.onAdd} icon={iconSvg("plus")} />
  </div>;
}
