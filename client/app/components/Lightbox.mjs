// client/app/components/Lightbox.mjs — the comparison workbench surface.
//
// <Lightbox> owns the structure and the state-driven hidden; the engine
// (js/lightbox.mjs) keeps the async image work — generation-guarded loads,
// decode-and-swap, transforms, composition modes — and writes src/style/
// dataset on the imgs directly. None of those attributes are declared here,
// so Preact's diff never clobbers what the engine wrote.

import { h } from "../../vendor/preact/vendor.mjs";
import { state } from "../../js/state.mjs";
import { noteImgLoad } from "../../js/lightbox.mjs";
import { toggleKeysPanel } from "../../js/keys-panel.mjs";
import { useVersion } from "../hooks/useVersion.mjs";

const KEYS_BTN_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M9 14h6"/></svg>';

export function Lightbox() {
  useVersion();
  return h("div", { id: "lightbox", hidden: !state.lightbox.open },
    h("img", { id: "lbCandidate", alt: "", onLoad: (e) => noteImgLoad(e.target) }),
    h("img", { id: "lbAnchor", alt: "", onLoad: (e) => noteImgLoad(e.target) }),
    h("div", { id: "lbSplitLine", hidden: true }),
    h("div", { id: "lbGuides" }),
    h("div", { id: "lbRoi" }),
    h("div", { id: "lbChrome" },
      h("input", {
        id: "lbBlend", type: "range", min: "0", max: "1", step: "0.01", value: "0.5",
        title: "blend opacity (candidate over anchor)", hidden: true,
      }),
    ),
    h("button", {
      id: "lbKeysBtn", title: "actions & keys (?)",
      onClick: (e) => { e.stopPropagation(); toggleKeysPanel(); },
      dangerouslySetInnerHTML: { __html: KEYS_BTN_SVG },
    }),
  );
}
