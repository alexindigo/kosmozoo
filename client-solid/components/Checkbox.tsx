import { splitProps } from "solid-js";

// One native checkbox: consumers own its label, value and change intent.
export function Checkbox(props) {
  const [local, input] = splitProps(props, ["checked", "onChange", "disabled", "size", "title"]);
  return <input {...input} type="checkbox" class={`checkbox checkbox-${local.size ?? "row"}`}
    checked={local.checked} disabled={local.disabled} title={local.title}
    onChange={event => local.onChange(event.currentTarget.checked)} />;
}
