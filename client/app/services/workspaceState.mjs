// client/app/services/workspaceState.mjs — the right-column space choice and
// the details pane's layout mode.
//
// Two spaces share the pane: the metadata details of the current image and the
// anchors feed. The choice persists. state.workspace is the source of truth;
// <WorkspaceBar> and <WorkspacePane> both read it.
//
// The details pane's layout mode (how discovered node images and the text
// fields are arranged) also persists: state.infoLayout — "split" (images
// left / text right, default), "rev" (text left / images right), "stacked"
// (images above text). <Header>'s layout switcher writes it.

import { state } from "../../js/state.mjs";
import { render } from "./notify.mjs";

const LS_SPACE = "kosmozoo.workspace.v1";
const LS_LAYOUT = "kosmozoo.infoLayout.v1";
const LAYOUTS = new Set(["split", "rev", "stacked"]);

export function initWorkspaceSpace() {
  try {
    if (localStorage.getItem(LS_SPACE) === "anchors") state.workspace = "anchors";
    const layout = localStorage.getItem(LS_LAYOUT);
    if (layout && LAYOUTS.has(layout)) state.infoLayout = layout;
  } catch { /* private mode: session-only */ }
}

export function setWorkspace(space) {
  if (state.workspace === space) return;
  state.workspace = space;
  try { localStorage.setItem(LS_SPACE, space); } catch { /* ignore */ }
  render();
}

export function setInfoLayout(mode) {
  if (!LAYOUTS.has(mode) || state.infoLayout === mode) return;
  state.infoLayout = mode;
  try { localStorage.setItem(LS_LAYOUT, mode); } catch { /* ignore */ }
  render();
}
