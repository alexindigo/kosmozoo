// client/app/components/AnchorSpace.mjs — the anchors feed.
//
// Anchor cards share the candidate card's anatomy minus judgment: same
// aspect-true <Zoomable> image box, name, metadata summary strip, ⓘ full-params
// overlay, × remove — the buttons are the shared <IconButton>. Click opens that
// anchor in the lightbox. Reorder by drag; drop files to add.

import { h, Fragment } from "../../vendor/preact/vendor.mjs";
import { useState, useRef } from "../../vendor/preact/vendor.mjs";
import { state, render } from "../../js/state.mjs";
import { iconSvg } from "../../js/icons.mjs";
import { aspectFromMeta } from "../../js/imageCard.mjs";
import { addAnchorFiles, removeAnchor, showAnchorInfo, persistAnchors } from "../../js/anchors.mjs";
import { openAnchor } from "../../js/lightbox.mjs";
import { useVersion } from "../hooks/useVersion.mjs";
import { Zoomable } from "./Zoomable.mjs";
import { IconButton } from "./IconButton.mjs";

function anchorSummary(meta) {
  if (!meta) return "";
  const bits = [];
  if (meta.seed != null) bits.push(`seed ${meta.seed}`);
  if (meta.steps != null) bits.push(`${meta.steps} steps`);
  if (meta.guidance != null) bits.push(`g ${meta.guidance}`);
  if (meta.model) bits.push(meta.model);
  return bits.join(" · ");
}

// name of the anchor currently being drag-reordered (module-level: it survives
// the re-renders the reorder itself triggers)
let dragged = null;

function reorder(overName, before) {
  if (!dragged || dragged === overName) return;
  const arr = state.anchors;
  const from = arr.findIndex((a) => a.name === dragged);
  if (from < 0 || arr.findIndex((a) => a.name === overName) < 0) return;
  const [item] = arr.splice(from, 1);
  const to = arr.findIndex((a) => a.name === overName);
  arr.splice(before ? to : to + 1, 0, item);
  render();
}

function AnchorCard({ anchor, idx }) {
  useVersion();
  const [zoomed, setZoomed] = useState(false);
  return h("div", {
    class: "card anchor",
    "data-name": anchor.name,
    draggable: !zoomed,
    onDragStart: (e) => {
      dragged = anchor.name;
      e.dataTransfer.setData("text/x-anchor", "");
      e.dataTransfer.effectAllowed = "move";
    },
    onDragEnd: () => { dragged = null; persistAnchors(); },
    onDragOver: (e) => {
      if (!dragged || dragged === anchor.name) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const rect = e.currentTarget.getBoundingClientRect();
      reorder(anchor.name, (e.clientY - rect.top) < rect.height / 2);
    },
  },
    h(Zoomable, {
      src: anchor.src,
      alt: anchor.name,
      ar: aspectFromMeta(anchor.meta),
      stripText: anchorSummary(anchor.meta),
      zoomKey: `anchor:${anchor.name}`,
      onZoomChange: setZoomed,
      onOpen: () => openAnchor(idx),
    }),
    h("div", { class: "ctitle" },
      h("span", { class: "aname", title: anchor.name }, anchor.name),
      h("span", { class: "btnwrap" },
        h(IconButton, {
          icon: iconSvg("info-circle", 14), variant: "ainfo", title: "embedded parameters",
          onAction: () => showAnchorInfo(anchor.name, anchor.meta),
        }),
        h(IconButton, {
          icon: iconSvg("trash", 13), variant: "rm", title: "remove anchor",
          onAction: () => removeAnchor(anchor.name),
        }),
      ),
    ),
  );
}

export function AnchorSpace() {
  useVersion();
  const fileRef = useRef(null);
  return h(Fragment, null,
    h("div", { id: "anchorList" },
      state.anchors.map((a, idx) => h(AnchorCard, { key: a.name, anchor: a, idx })),
    ),
    h("div", {
      id: "dropzone",
      onClick: () => fileRef.current?.click(),
      onDragOver: (e) => { e.preventDefault(); e.currentTarget.classList.add("over"); },
      onDragLeave: (e) => e.currentTarget.classList.remove("over"),
      onDrop: async (e) => {
        e.preventDefault();
        e.currentTarget.classList.remove("over");
        if (dragged) { dragged = null; return; } // was a reorder, not files
        if (e.dataTransfer?.files?.length) await addAnchorFiles([...e.dataTransfer.files]);
      },
    }, "Drop images here", h("br", null), "(or click to browse)"),
    h("input", {
      type: "file", id: "fileInput", ref: fileRef, accept: "image/*", multiple: true, hidden: true,
      onChange: async (e) => {
        if (e.target.files.length) await addAnchorFiles([...e.target.files]);
        e.target.value = "";
      },
    }),
  );
}
