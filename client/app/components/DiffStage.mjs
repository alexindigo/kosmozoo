// client/app/components/DiffStage.mjs — the workbench surface.
//
// A single-image viewer of state.current. Renders the stage and owns the
// hidden flag from state.diff.open; the engine (js/diff.mjs) loads the image
// (writes #diffImg.src under a generation guard). The image fits the stage
// via object-fit. Stripped to the studs: just the image, the close button,
// and the keys button.

import { h } from "../../vendor/preact/vendor.mjs";
import { state } from "../../js/state.mjs";
import { closeDiff } from "../../js/diff.mjs";
import { toggleKeysPanel } from "../../js/keys-panel.mjs";

const CLOSE_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M18 6l-12 12" /><path d="M6 6l12 12" /></svg>';

const KEYS_BTN_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M9 14h6"/></svg>';

export function DiffStage() {
  return h("div", { id: "diff", hidden: !state.diff.open },
    h("button", {
      id: "diffClose", title: "close (Esc)", onClick: () => closeDiff(),
      dangerouslySetInnerHTML: { __html: CLOSE_SVG },
    }),
    h("div", { id: "diffStage" },
      // src is written by the engine (js/diff.mjs) under a generation guard;
      // it is not a declared prop, so re-renders never clobber it.
      h("img", { id: "diffImg", alt: "" }),
    ),
    h("button", {
      id: "diffKeysBtn", title: "actions & keys (?)",
      onClick: (e) => { e.stopPropagation(); toggleKeysPanel(); },
      dangerouslySetInnerHTML: { __html: KEYS_BTN_SVG },
    }),
  );
}
