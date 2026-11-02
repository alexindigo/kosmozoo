import { children, createEffect, splitProps } from "solid-js";
import { iconSvg } from "/js/icons.mjs";

// Shared trailing part: both native selects and popup triggers allocate the
// same control-height square. Pointer events stay with the native control.
export function Chevron() {
  return <span class="chevron-slot" aria-hidden="true" innerHTML={iconSvg("chevron-down")} />;
}

// Native keyboard, option and accessibility behavior remain with <select>.
export function Select(props) {
  const [local, native] = splitProps(props, ["size", "class", "children", "value"]);
  const options = children(() => local.children);
  let select;
  // A spread writes DOM properties before child insertion. Resolve the option
  // set once and project the controlled value after render, on either change.
  // This also preserves a selected synthetic option added during cold boot.
  createEffect(() => { options(); select.value = local.value; });
  return <span class={`select-control control-size-${local.size ?? "md"}`}>
    <select {...native} ref={select} class={`select-native ${local.class ?? ""}`}>{options()}</select>
    <Chevron />
  </span>;
}
