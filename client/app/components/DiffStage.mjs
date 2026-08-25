// client/app/components/DiffStage.mjs — the workbench surface.
//
// <DiffStage> renders the stage structure and owns the hidden flag from
// state.diff.open; the engine (js/diff.mjs) keeps the image work —
// generation-guarded loads, the five compositions, wheel/drag registration —
// and writes src/style/dataset/textContent directly. None of those attributes
// are declared here (or are declared once, as constants), so re-renders never
// clobber what the engine wrote.

import { h } from "../../vendor/preact/vendor.mjs";
import { state } from "../../js/state.mjs";
import { closeDiff, saveBoth, setBlend } from "../../js/diff.mjs";
import { toggleKeysPanel } from "../../js/keys-panel.mjs";

const CLOSE_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M18 6l-12 12" /><path d="M6 6l12 12" /></svg>';

const SAVE_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2" /><path d="M7 11l5 5l5 -5" /><path d="M12 4l0 12" /></svg>';

const KEYS_BTN_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M9 14h6"/></svg>';

export function DiffStage() {
  return h("div", { id: "diff", hidden: !state.diff.open },
    h("button", {
      id: "diffClose", title: "close (Esc)", onClick: () => closeDiff(),
      dangerouslySetInnerHTML: { __html: CLOSE_SVG },
    }),
    h("div", { id: "diffBar" },
      h("span", { id: "diffMode", title: "composition mode (c)" }),
      h("input", {
        id: "diffBlend", type: "range", min: "0", max: "1", step: "0.01", value: "0.5",
        title: "top-side opacity", hidden: true,
        onInput: (e) => setBlend(e.target.value),
      }),
      h("span", { id: "diffAlign", title: "zoom/pan linkage (a)" }),
      h("button", {
        id: "diffSave", title: "download both images", onClick: () => saveBoth(),
        dangerouslySetInnerHTML: { __html: SAVE_SVG + " save both" },
      }),
    ),
    h("div", { id: "diffStage", "data-mode": "flicker" },
      // right first in DOM: in overlay modes left paints on top (blend/
      // difference need one shared stacking context, so no z-index on the
      // figures); side mode reorders left-first via `order`
      h("figure", { id: "diffFR", class: "diffside" },
        h("img", { id: "diffR", alt: "" }),
        h("figcaption", { id: "diffLblR", class: "difflabel" }),
      ),
      h("figure", { id: "diffFL", class: "diffside" },
        h("img", { id: "diffL", alt: "" }),
        h("figcaption", { id: "diffLblL", class: "difflabel" }),
      ),
      h("div", { id: "diffSplitLine", hidden: true }),
    ),
    h("button", {
      id: "diffKeysBtn", title: "actions & keys (?)",
      onClick: (e) => { e.stopPropagation(); toggleKeysPanel(); },
      dangerouslySetInnerHTML: { __html: KEYS_BTN_SVG },
    }),
  );
}
