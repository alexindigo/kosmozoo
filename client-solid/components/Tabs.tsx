import { For, onMount, onCleanup } from "solid-js";
import { SingleLineText } from "./SingleLineText.js";

// Controlled, single-row tabs. Key routing is an injected dispatcher capability;
// refs, roving focus and horizontal reveal belong to this component alone.
export function Tabs(props) {
  let strip;
  const buttons = new Map();
  const select = value => { props.onChange(value); buttons.get(value)?.scrollIntoView({ block: "nearest", inline: "nearest" }); };
  onMount(() => onCleanup(props.registerKeys({
    contains: target => strip.contains(target),
    move: ({ step }) => {
      const values = props.options.map(option => option.value), current = values.indexOf(props.value);
      const index = step === "first" ? 0 : step === "last" ? values.length - 1 : (current + step + values.length) % values.length;
      const value = values[index]; select(value); buttons.get(value)?.focus({ preventScroll: true });
    },
  })));
  return <div ref={strip} class={`tabs ${props.class ?? ""}`} role="tablist" aria-label={props.label}>
    <For each={props.options.map(option => option.value)}>{value => {
      const option = () => props.options.find(option => option.value === value);
      return <button ref={button => { buttons.set(value, button); onCleanup(() => buttons.delete(value)); }}
        type="button" role="tab" class="tabs-tab" classList={{ "is-active": props.value === value }}
        id={option()?.id} aria-controls={props.panelId} aria-selected={props.value === value}
        tabindex={props.value === value ? 0 : -1} data-value={value}
        onFocus={event => { const button = event.currentTarget; props.rememberFocus?.(() => button.focus({ preventScroll: true })); }}
        onClick={() => select(value)}><SingleLineText value={option()?.label} /></button>;
    }}</For>
  </div>;
}
