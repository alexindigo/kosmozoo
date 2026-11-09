import { For, Show, onMount, onCleanup, createSignal } from "solid-js";
import { parameterName } from "./field-filter.js";
import { formatValue } from "/shared/features/variations/shared.mjs";
import { SingleLineText } from "../../components/SingleLineText.js";
import { parameterCurrent } from "/shared/parameters.mjs";
import { isFileDrag, droppedFiles } from "./image-drop.js";

export function ParameterCatalogue(props) {
  return <div class="vz-catalogue-list">
    <For each={props.ids}>{id => <CatalogueRow row={() => props.row(id)} matches={props.matches}
      onAdd={() => props.onAdd(id)} onFiles={resources => props.onFiles(id, resources)} registerFocus={focus => props.registerFocus(id, focus)} />}</For>
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
      <SingleLineText class="vz-catalogue-name" value={parameterName(row())} hint={row().label} />
      <SingleLineText class="vz-catalogue-current" value={formatValue(parameterCurrent(row()))} hint={`${row().label}: ${formatValue(parameterCurrent(row()))}`} />
    </div>
    <button ref={add} type="button" class="vz-catalogue-add" aria-label={`Add ${row().label}`} title={`Add ${row().label}`}
      onClick={props.onAdd}>
      <span aria-hidden="true">-&gt;</span>
    </button>
  </div>;
}
