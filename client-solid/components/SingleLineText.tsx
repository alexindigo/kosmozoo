import { splitProps } from "solid-js";

// One display-text contract: shrink and ellipsize, always retain the full
// value in the native tooltip. Presentation and interaction stay injected.
export function SingleLineText(props) {
  const [local, attributes] = splitProps(props, ["value", "class", "hint"]);
  const text = () => String(local.value ?? "");
  return <span {...attributes} class={"single-line-text" + (local.class ? " " + local.class : "")}
    title={text() + (local.hint ? "\n" + local.hint : "")}>{text()}</span>;
}
