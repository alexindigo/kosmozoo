import { createUniqueId } from "solid-js";
import { SingleLineText } from "../../components/SingleLineText.js";

// Presentation only: identity, current context, enable intent and editor slot.
// Catalogue IDs remain opaque; a readable name never becomes a token ID.
export const parameterName = row => row.kind === "text" && row.key === "text" ? "Prompt"
  : String(row.input ?? row.key).replace(/_/g, " ").replace(/^./, letter => letter.toUpperCase());

export function ParameterRow(props) {
  const id = `vz-param-${createUniqueId()}`;
  const context = () => `${props.row().title ?? props.row().type} #${props.row().nodeIds[0]}`;
  return <div class={`vz-parameter ${props.class ?? ""}${props.enabled() ? " on" : " vz-off"}`} {...props.attributes}>
    <div class="vz-parameter-heading vz-imgrow-head">
      <input id={id} type="checkbox" class="vz-cb" checked={props.enabled()}
        aria-describedby={`${id}-identity`} onChange={event => props.onEnable(event.currentTarget.checked)} />
      <label for={id} class="vz-parameter-name"><SingleLineText class="vz-label vz-imgrow-label"
        value={parameterName(props.row())} hint={props.row().label} /></label>
      <SingleLineText class="vz-parameter-identity" value={context()} hint={props.row().label} />
      <span id={`${id}-identity`} hidden>{props.row().label}</span>
      <SingleLineText class="vz-parameter-current vz-imgrow-cur" value={`Current ${props.current ?? props.row().current}`}
        hint={props.row().label} />
    </div>
    {props.children}
  </div>;
}
