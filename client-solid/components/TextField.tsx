import { splitProps } from "solid-js";

// Appearance and optional trailing allocation only. The native element retains
// its ref, events, value ownership and keyboard/IME behavior at every location.
export function TextField(props) {
  const [local, native] = splitProps(props, ["multiline", "tone", "size", "class", "trailing", "controlClass"]);
  const classes = () => `text-field control-size-${local.size ?? "md"}${local.multiline ? " text-field-multiline" : ""}${local.tone ? ` text-field-${local.tone}` : ""} ${local.class ?? ""}`;
  if (local.multiline) return <textarea {...native} class={classes()} />;
  if ("trailing" in props) return <div class={`search-control text-field-control control-size-${local.size ?? "md"} ${local.controlClass ?? ""}`}>
    <input {...native} class={classes()} />
    {local.trailing}
  </div>;
  return <input {...native} class={classes()} />;
}
