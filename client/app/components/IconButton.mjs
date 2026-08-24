// client/app/components/IconButton.mjs — ONE icon button, fixed everywhere.
//
// Carries the votebtn class contract verbatim: "votebtn <variant>" plus ".on"
// when active; the variant class owns the accent via CSS (--btn-c), so no
// inline color. The click stops propagation and executes onAction — the
// button renders, the callback executes.

import { h } from "../../vendor/preact/vendor.mjs";

export function IconButton({ icon, variant, active = false, title, onAction }) {
  return h("button", {
    class: "votebtn " + variant + (active ? " on" : ""),
    title,
    onClick: (e) => { e.stopPropagation(); onAction(e); },
    dangerouslySetInnerHTML: { __html: icon },
  });
}
