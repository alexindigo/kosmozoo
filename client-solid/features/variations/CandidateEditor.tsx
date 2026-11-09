import { For, Index, Show } from "solid-js";
import { ParameterRow } from "./ParameterRow.js";
import { Checkbox } from "../../components/Checkbox.js";
import { TextField } from "../../components/TextField.js";
import { Select } from "../../components/Select.js";
import { SingleLineText } from "../../components/SingleLineText.js";
import { focusMemory } from "./draft.js";

// Raw candidate text, typed choices, ordering and graph facts are injected by the
// private editor. This component presents them and forwards semantic intents.
export function CandidateEditor(props) {
  const row = () => props.row(), focus = focusMemory(props.rememberFocus);
  return <ParameterRow class="vz-candidate-row" row={row} enabled={() => row().enabled}
    attributes={{ "data-candidate-id": row().id }} onEnable={props.onEnable} onInsert={props.onInsert}
    registerFocus={props.registerFocus} summary={props.summary}>
    <div class="vz-candidate-body">
      <Show when={row().candidateKind === "boolean" || row().candidateKind === "options"}>
        <div class="vz-enum-list vz-typed-options">
          <For each={row().choices.map(choice => choice.text)}>{text => {
            const choice = () => row().choices.find(choice => choice.text === text);
            return <label class="vz-enum-opt"><Checkbox {...focus} size="option" checked={choice().on}
              onChange={on => props.onPick(text, on)} /><SingleLineText value={choice().label} /></label>;
          }}</For>
        </div>
      </Show>
      <Index each={row().candidateViews}>{(candidate, index) => <div class="vz-candidate-entry">
        <div class="vz-candidate-controls">
          <Show when={row().candidateKind === "json"} fallback={
            <Show when={row().candidateKind === "connection"} fallback={<SingleLineText class="vz-candidate-value" value={candidate().label} />}>
              <div class="vz-connection-fields">
                <Select aria-label={`${row().label} candidate ${index + 1} node`} value={candidate().node} {...focus}
                  onChange={event => props.onConnection(index, event.currentTarget.value, candidate().slot)}>
                  <For each={props.nodes}>{node => <option value={node.id}>{node.label}</option>}</For>
                </Select>
                <TextField type="text" inputMode="numeric" aria-label={`${row().label} candidate ${index + 1} slot`}
                  value={candidate().slot} {...focus} onInput={event => props.onConnection(index, candidate().node, event.currentTarget.value)} />
              </div>
            </Show>
          }>
            <TextField multiline rows="2" class="vz-json-candidate" aria-label={`${row().label} candidate ${index + 1}`}
              aria-invalid={!!candidate().error} value={candidate().raw} {...focus} onInput={event => props.onCandidate(index, event.currentTarget.value)} />
          </Show>
          <div class="vz-candidate-actions">
            <Show when={index > 0}><button type="button" aria-label={`Move candidate ${index + 1} up`} onClick={() => props.onMove(index, index - 1)}>Up</button></Show>
            <Show when={index < row().candidateViews.length - 1}><button type="button" aria-label={`Move candidate ${index + 1} down`} onClick={() => props.onMove(index, index + 1)}>Down</button></Show>
            <button type="button" aria-label={`Remove candidate ${index + 1}`} onClick={() => props.onRemove(index)}>Remove</button>
          </div>
        </div>
        <Show when={candidate().error}><p class="vz-readiness-error" role="status">{candidate().error}</p></Show>
      </div>}</Index>
      <Show when={row().candidateKind === "json" || row().candidateKind === "connection"}>
        <button type="button" class="vz-candidate-add" onClick={props.onAdd}>Add value</button>
      </Show>
      <Show when={row().candidateKind === "connection"}><p class="vz-field-help">{props.connectionHelp}</p></Show>
      <Show when={row().schema?.status !== "known"}><p class="vz-field-help">Input schema unavailable. Backend custom validation is unknown.</p></Show>
    </div>
  </ParameterRow>;
}
