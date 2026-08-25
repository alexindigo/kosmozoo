// client/app/components/WorkspacePane.mjs — the right-column workspace.
//
// Two spaces share the pane: the metadata details of the current image and the
// anchors feed. state.workspace picks which is shown. The details body reads
// the current image (lightbox image while open, else the URL's file).

import { h } from "../../vendor/preact/vendor.mjs";
import { useRef, useEffect } from "../../vendor/preact/vendor.mjs";
import { state } from "../../js/state.mjs";
import { buildMetaBody } from "../../js/fields.mjs";
import { parseUrl, findByFile } from "../../js/route.mjs";
import { AnchorSpace } from "./AnchorSpace.mjs";

// lightbox image while open, else the URL's file — hidden included
function detailsImage() {
  if (state.lightbox.open) {
    if (state.lightbox.col === "candidate") return state.images[state.lightbox.index] ?? null;
    return state.anchors[state.lightbox.anchorIndex ?? 0] ?? null;
  }
  const idx = findByFile(parseUrl().file);
  return idx >= 0 ? state.images[idx] : null;
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
    el.appendChild(buildMetaBody(img.meta ?? null));
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
