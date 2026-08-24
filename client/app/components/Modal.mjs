// client/app/components/Modal.mjs — one modal shell for every overlay.
//
// Renders the fixed backdrop + centered panel. Clicking the backdrop (the
// overlay element itself, not its contents) closes it. The caller supplies the
// panel's id and children; the close affordance is a child too, so each panel
// keeps its own layout.

import { h } from "../../vendor/preact/vendor.mjs";

export function Modal({ overlayId, panelId, open, onClose, children }) {
  return h("div", {
    id: overlayId,
    hidden: !open,
    onClick: (e) => { if (e.target.id === overlayId) onClose(); },
  },
    h("div", { id: panelId }, children),
  );
}
