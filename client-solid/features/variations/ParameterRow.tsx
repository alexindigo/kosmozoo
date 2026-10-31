import { createUniqueId, Show } from "solid-js";
import { SingleLineText } from "../../components/SingleLineText.js";
import { Checkbox } from "../../components/Checkbox.js";

// Presentation only: identity, current context, enable intent and editor slot.
// Catalogue IDs remain opaque; a readable name never becomes a token ID.
export const parameterName = row => `${row.title ?? row.type}.${row.input ?? row.key}`;

export function ParameterRow(props) {
  const id = `vz-param-${createUniqueId()}`;
  return <div class={`vz-parameter ${props.class ?? ""}${props.enabled() ? " on" : " vz-off"}`} {...props.attributes}>
    <div class="vz-parameter-heading vz-imgrow-head">
      <Checkbox id={id} checked={props.enabled()}
        aria-labelledby={`${id}-name`} aria-describedby={`${id}-identity`} onChange={checked => props.onEnable(checked)} />
      <button type="button" id={`${id}-name`} class="vz-parameter-name" onClick={() => props.onInsert(props.row().id)}>
        <SingleLineText class="vz-label vz-imgrow-label" value={parameterName(props.row())} hint={props.row().label} />
      </button>
      <span id={`${id}-identity`} hidden>{props.row().label}</span>
      <SingleLineText class="vz-parameter-current vz-imgrow-cur" value={props.enabled() ? props.summary : props.current ?? props.row().current}
        hint={props.row().label} />
    </div>
    <Show when={props.enabled()}>{props.children}</Show>
  </div>;
}
