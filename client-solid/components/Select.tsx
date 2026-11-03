import { children, createEffect, Show, splitProps } from "solid-js";
import { iconSvg } from "/js/icons.mjs";

// Shared trailing part: both native selects and popup triggers allocate the
// same control-height square. Pointer events stay with the native control.
export function Chevron() {
  return <span class="chevron-slot" aria-hidden="true" innerHTML={iconSvg("chevron-down")} />;
}

// Native keyboard, option and accessibility behavior remain with <select>.
export function Select(props) {
  const [local, native] = splitProps(props, ["size", "class", "children", "value", "face", "chevron"]);
  const options = children(() => local.children);
  let select;
  // A spread writes DOM properties before child insertion. Resolve the option
  // set once and project the controlled value after render, on either change.
  // This also preserves a selected synthetic option added during cold boot.
  createEffect(() => { options(); select.value = local.value; });
  return <span class={`select-control control-size-${local.size ?? "md"}`} classList={{ "select-with-face": local.face != null, "select-without-chevron": local.chevron === false }}>
    <select {...native} ref={select} class={`select-native ${local.class ?? ""}`}>{options()}</select>
    <Show when={local.face != null}><span class="select-face select-trigger" aria-hidden="true"><span class="select-face-content">{local.face}</span></span></Show>
    <Show when={local.chevron !== false}><Chevron /></Show>
  </span>;
}
