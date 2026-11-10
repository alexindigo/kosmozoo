import { For, Show, onMount, onCleanup, createSignal } from "solid-js";
import { parameterInputName, parameterContext } from "./field-filter.js";
import { IconButton } from "../../components/IconButton.js";
import { iconSvg } from "/js/icons.mjs";
import { SingleLineText } from "../../components/SingleLineText.js";
import { isFileDrag, droppedFiles } from "./image-drop.js";

export function ParameterCatalogue(props) {
  return <div class="vz-catalogue-list">
    <For each={props.sections}>{section => <section class="vz-catalogue-section" classList={{ "vz-catalogue-hidden": !section.nodes.some(node => node.ids.some(id => !props.row(id).enabled && props.matches(props.row(id)))) }}>
      <SingleLineText class="vz-catalogue-section-name" value={section.name} />
      <For each={section.nodes}>{node => <div class="vz-catalogue-node" classList={{ "vz-catalogue-hidden": !node.ids.some(id => !props.row(id).enabled && props.matches(props.row(id))) }}>
        <SingleLineText class="vz-catalogue-node-name" value={node.label} />
        <For each={node.ids}>{id => <CatalogueRow row={() => props.row(id)} matches={props.matches}
          onAdd={() => props.onAdd(id)} onFiles={resources => props.onFiles(id, resources)} registerFocus={focus => props.registerFocus(id, focus)} />}</For>
      </div>}</For>
    </section>}</For>
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
      <SingleLineText class="vz-catalogue-name" value={parameterInputName(row())} hint={row().label} />
      <SingleLineText class="vz-catalogue-current" value={parameterContext(row())} hint={`${row().label}: ${parameterContext(row())}`} />
    </div>
    <IconButton buttonRef={element => add = element} chrome size="sm" variant="plain vz-catalogue-add" title={`Add ${row().label}`}
      onAction={props.onAdd} icon={iconSvg("plus")} />
  </div>;
}
