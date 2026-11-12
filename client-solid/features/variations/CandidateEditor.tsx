import { For, Index, Show } from "solid-js";
import { ParameterRow } from "./ParameterRow.js";
import { Checkbox } from "../../components/Checkbox.js";
import { TextField } from "../../components/TextField.js";
import { Select } from "../../components/Select.js";
import { SingleLineText } from "../../components/SingleLineText.js";
import { focusMemory } from "./draft.js";
import { IconButton } from "../../components/IconButton.js";
import { iconSvg } from "/js/icons.mjs";

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
      <Index each={row().candidateViews}>{(candidate, index) => {
        const node = () => props.nodes?.find(node => node.id === candidate().node);
        return <div class="vz-candidate-entry">
        <div class="vz-candidate-controls">
          <Show when={row().candidateKind === "json"} fallback={
            <Show when={row().candidateKind === "connection"} fallback={<SingleLineText class="vz-candidate-value" value={candidate().label} />}>
              <div class="vz-connection-fields">
                <label class="vz-connection-control"><span>Node</span><Select aria-label={`${row().label} candidate ${index + 1} node`} value={candidate().node} {...focus}
                  onChange={event => props.onConnection(index, event.currentTarget.value, candidate().slot)}>
                  <option value="">Choose node</option>
                  <For each={props.nodes}>{node => <option value={node.id}>{node.label}</option>}</For>
                </Select></label>
                <Show when={node()?.outputs !== null && node() !== undefined} fallback={
                  <label class="vz-connection-control"><span>Slot</span><TextField type="text" inputMode="numeric" aria-label={`${row().label} candidate ${index + 1} slot`}
                    title="Output ports are unknown. Enter a nonnegative slot; the backend checks compatibility."
                    aria-invalid={!!candidate().error} value={candidate().slot} {...focus} onInput={event => props.onConnection(index, candidate().node, event.currentTarget.value)} /></label>
                }>
                  <label class="vz-connection-control"><span>Output</span><Select aria-label={`${row().label} candidate ${index + 1} output`} value={candidate().slot} {...focus}
                    onChange={event => props.onConnection(index, candidate().node, event.currentTarget.value)}>
                    <option value="">Choose output</option>
                    <For each={node()?.outputs}>{port => <option value={port.slot}>{port.label}</option>}</For>
                  </Select></label>
                </Show>
              </div>
            </Show>
          }>
            <TextField multiline rows="2" class="vz-json-candidate" aria-label={`${row().label} candidate ${index + 1}`}
              aria-invalid={!!candidate().error} value={candidate().raw} {...focus} onInput={event => props.onCandidate(index, event.currentTarget.value)} />
          </Show>
          <div class="vz-candidate-actions">
            <Show when={index > 0}><IconButton chrome size="sm" variant="plain" title={`Move candidate ${index + 1} up`} onAction={() => props.onMove(index, index - 1)} icon={iconSvg("arrow-up")} /></Show>
            <Show when={index < row().candidateViews.length - 1}><IconButton chrome size="sm" variant="plain vz-candidate-down" title={`Move candidate ${index + 1} down`} onAction={() => props.onMove(index, index + 1)} icon={iconSvg("chevron-down")} /></Show>
            <IconButton chrome size="sm" variant="plain" title={`Remove candidate ${index + 1}`} onAction={() => props.onRemove(index)} icon={iconSvg("x")} />
          </div>
        </div>
        <Show when={candidate().error}><p class="vz-readiness-error" role="status">{candidate().error}</p></Show>
      </div>; }}</Index>
      <Show when={row().candidateKind === "json" || row().candidateKind === "connection"}>
        <IconButton chrome size="sm" variant="plain vz-candidate-add" title="Add value" onAction={props.onAdd} icon={iconSvg("plus")} />
      </Show>
      <Show when={row().candidateKind === "connection" && row().candidateViews.some(candidate => props.nodes.find(node => node.id === candidate.node)?.outputs === null)}><p class="vz-field-help">Enter the output slot for nodes with unknown ports.</p></Show>
      <span class="vz-contract-context" hidden>{row().contract?.knowledge !== "known" ? "Input declaration unavailable; custom validation is backend-owned." : "Custom validation is backend-owned."}</span>
    </div>
  </ParameterRow>;
}
