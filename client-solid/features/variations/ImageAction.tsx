import { splitProps } from "solid-js";

// All image acquisition actions share their native button and default chrome.
export function ImageAction(props) {
  const [local, attributes] = splitProps(props, ["class", "children"]);
  return <button type="button" class={local.class ?? "vz-image-action"} {...attributes}>{local.children}</button>;
}
