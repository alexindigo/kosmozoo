import { For, Show } from "solid-js";
import { IconButton } from "./IconButton.js";
import { SingleLineText } from "./SingleLineText.js";

// One exclusive-mode group, for text labels and icons alike. Its caller
// supplies choices and intent; the group owns active state and allocation.
export function ModeSwitch(props) {
  return <div id={props.id} class={`viewer-group mode-switch ${props.class ?? ""}`} role="group" aria-label={props.label}>
    {/* Choice identity survives presentation/availability object replacement. */}
    <For each={props.options.map(option => option.value)}>{value => {
      const option = () => props.options.find(option => option.value === value);
      return <Show when={option()?.icon} fallback={
      <button type="button" class={"viewer-btn mode-label" + (props.value === value ? " on" : "")}
        title={option()?.title ?? option()?.label} aria-pressed={props.value === value}
        onClick={event => { event.stopPropagation(); props.onChange(value); }}><SingleLineText value={option()?.label} /></button>
    }>
      <IconButton viewer variant={option()?.variant} icon={option()?.icon} title={option()?.title ?? option()?.label}
        aria-label={option()?.label} data-view={option()?.view}
        active={props.value === value} onAction={() => props.onChange(value)} />
    </Show>;
    }}</For>
  </div>;
}
