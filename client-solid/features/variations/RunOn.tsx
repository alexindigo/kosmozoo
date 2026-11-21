import { For, Show } from "solid-js";
import { Select } from "../../components/Select.js";
import { SingleLineText } from "../../components/SingleLineText.js";
import { problemText } from "/shared/features/variations/problems.mjs";

// The Run destination: a native select over the ComfyUI sources, its face
// reads "Run on <host>". While a Run owns the editor it is shown, not offered.
export function RunOn(props) {
  const face = () => <SingleLineText value={props.problem ? "No Run destination" : `Run on ${props.value}`} hint={props.problem ? problemText(props.problem) : `Jobs are sent to ${props.value}`} />;
  return <div class="vz-run-on">
    <Show when={!props.fixed} fallback={<span class="select-control control-size-md vz-run-on-fixed">{face()}</span>}>
      <Select class="vz-run-on-select" aria-label="Run on" value={props.value} face={face()} {...props.focus}
        onChange={event => props.onChoose(event.currentTarget.value)}>
        <For each={props.destinations}>{origin =>
          <option value={origin.source}>{origin.source}{props.offline(origin.source) ? " (offline)" : ""}</option>}</For>
      </Select>
     </Show>
  </div>;
}
