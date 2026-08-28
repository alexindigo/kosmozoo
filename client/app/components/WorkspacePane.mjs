// client/app/components/WorkspacePane.mjs — the right-column workspace.
//
// Two spaces share the pane: the metadata details of the current image and the
// anchors feed. state.workspace picks which is shown. The details body reads
// state.current (the single current-image pointer) — hidden included.

import { h } from "../../vendor/preact/vendor.mjs";
import { useRef, useEffect } from "../../vendor/preact/vendor.mjs";
import { state } from "../../js/state.mjs";
import { buildMetaBody } from "../../js/fields.mjs";
import { AnchorSpace } from "./AnchorSpace.mjs";

// the current image (host/folder image or anchor)
function detailsImage() {
  const c = state.current;
  if (!c) return null;
  if (c.remote === "anchor") {
    return state.anchors.find((a) => a.name === c.image) ?? null;
  }
  return state.images.find((i) => i.host === c.remote &&
    (i.filename === c.image || i.filename === c.remote + "#" + c.image)) ?? null;
}

function DetailsBody() {
  const ref = useRef(null);
  const img = detailsImage();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = "";
    if (!img) {
      const p = document.createElement("div");
      p.className = "info-none";
      p.textContent = "No image selected.";
      el.appendChild(p);
      return;
    }
    const head = document.createElement("div");
    head.className = "ws-head";
    const name = document.createElement("div");
    name.className = "ws-name";
    name.textContent = img.filename ?? img.name ?? "";
    name.title = img.filename ?? img.name ?? "";
    const sub = document.createElement("div");
    sub.className = "ws-sub";
    sub.textContent = img.host ? `host ${img.host}` : "local anchor";
    head.append(name, sub);
    el.appendChild(head);
    el.appendChild(buildMetaBody(img.meta ?? null, img.host));
  }, [img]);
  return h("div", { id: "wsDetailsBody", class: "metabody", ref });
}

export function WorkspacePane() {
  return h("aside", { id: "workspace" },
    h("div", { id: "wsDetails", class: "ws-space", hidden: state.workspace !== "details" },
      h(DetailsBody, null),
    ),
    h("div", { id: "wsAnchors", class: "ws-space", hidden: state.workspace !== "anchors" },
      h(AnchorSpace, null),
    ),
  );
}
