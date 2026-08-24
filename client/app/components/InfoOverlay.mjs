// client/app/components/InfoOverlay.mjs — the ⓘ overlay: every metadata field
// an anchor image carries, picker-exempt by design (the full-details view).
// Opened from an anchor card's ⓘ button; state.infoOverlay carries name+meta.

import { h, useEffect, useRef } from "../../vendor/preact/vendor.mjs";
import { state, render } from "../../js/state.mjs";
import { buildMetaBody } from "../../js/fields.mjs";
import { useVersion } from "../hooks/useVersion.mjs";
import { Modal } from "./Modal.mjs";

const CLOSE_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6l-12 12" /><path d="M6 6l12 12" /></svg>';

export function InfoOverlay() {
  useVersion();
  const { open, name, meta } = state.infoOverlay;
  const bodyRef = useRef(null);
  useEffect(() => {
    // buildMetaBody returns a built element tree; the body div is the only
    // imperative fill, re-run whenever the overlay opens or its meta changes.
    if (!open || !bodyRef.current) return;
    bodyRef.current.innerHTML = "";
    bodyRef.current.appendChild(buildMetaBody(meta));
  }, [open, meta]);
  const close = () => { state.infoOverlay.open = false; render(); };
  return h(Modal, { overlayId: "infoOverlay", panelId: "infoPanel", open, onClose: close },
    h("button", {
      id: "infoClose", title: "close (Esc)", onClick: close,
      dangerouslySetInnerHTML: { __html: CLOSE_SVG },
    }),
    h("div", { id: "infoTitle" }, name),
    h("div", { id: "infoBody", class: "metabody", ref: bodyRef }),
  );
}
