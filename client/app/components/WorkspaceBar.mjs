// client/app/components/WorkspaceBar.mjs — the narrow bar at the right edge:
// one button per workspace space (details on top, the default). The choice
// persists; the pane follows state.workspace.

import { h } from "../../vendor/preact/vendor.mjs";
import { state, render } from "../../js/state.mjs";
import { useVersion } from "../hooks/useVersion.mjs";
import { setWorkspace } from "../services/workspaceState.mjs";

const DETAILS_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0" /><path d="M12 9h.01" /><path d="M11 12h1v4h1" /></svg>';
const ANCHORS_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="3" /><line x1="12" y1="22" x2="12" y2="8" /><path d="M5 12H2a10 10 0 0 0 20 0h-3" /></svg>';

export function WorkspaceBar() {
  useVersion();
  const pick = (space) => (e) => {
    e.stopPropagation();
    if (state.workspace === space) return;
    setWorkspace(space);
  };
  return h("nav", { id: "wsBar" },
    h("button", {
      id: "wsBtnDetails", "data-space": "details", title: "image details",
      class: state.workspace === "details" ? "on" : "",
      onClick: pick("details"),
      dangerouslySetInnerHTML: { __html: DETAILS_SVG },
    }),
    h("button", {
      id: "wsBtnAnchors", "data-space": "anchors", title: "anchors",
      class: state.workspace === "anchors" ? "on" : "",
      onClick: pick("anchors"),
      dangerouslySetInnerHTML: { __html: ANCHORS_SVG },
    }),
  );
}
