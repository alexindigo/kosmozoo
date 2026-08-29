// client/app/components/WorkspacePane.mjs — the right-column workspace.
//
// Two spaces share the pane: the metadata details of the current image and the
// anchors feed. state.workspace picks which is shown. The details body reads
// state.current (the single current-image pointer) — hidden included.

import { h } from "../../vendor/preact/vendor.mjs";
import { useRef, useEffect } from "../../vendor/preact/vendor.mjs";
import { state } from "../../js/state.mjs";
import { buildMetaBody, nodeImages } from "../../js/fields.mjs";
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

    // discovered node images get their own column beside the text fields —
    // the layout (side-by-side / mirrored / stacked) follows state.infoLayout.
    // Anchors carry no host, so their refs can't resolve — single column.
    // The name/host header belongs to the text half of the split.
    const images = img.host ? nodeImages(img.meta ?? null, img.host) : [];
    if (images.length) {
      const cols = document.createElement("div");
      cols.className = "ws-cols " + (state.infoLayout === "rev" ? "rev"
        : state.infoLayout === "stacked" ? "stacked" : "split");
      const imgCol = document.createElement("div");
      imgCol.className = "ws-imgcol";
      for (const image of images) {
        const sec = document.createElement("div");
        sec.className = "infoimg";
        const lab = document.createElement("div");
        lab.className = "plabel";
        lab.textContent = image.label;
        const im = document.createElement("img");
        im.src = image.src;
        im.loading = "lazy";
        im.alt = image.file;
        sec.append(lab, im);
        imgCol.appendChild(sec);
      }
      const txtCol = document.createElement("div");
      txtCol.className = "ws-txtcol";
      txtCol.appendChild(head);
      txtCol.appendChild(buildMetaBody(img.meta ?? null, img.host, { skipImages: true }));
      cols.append(imgCol, txtCol);
      el.appendChild(cols);
    } else {
      el.appendChild(head);
      el.appendChild(buildMetaBody(img.meta ?? null, img.host));
    }
  }, [img, state.infoLayout]);
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
