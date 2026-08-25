// client/app/services/workspaceState.mjs — the right-column space choice.
//
// Two spaces share the pane: the metadata details of the current image and the
// anchors feed. The choice persists. state.workspace is the source of truth;
// <WorkspaceBar> and <WorkspacePane> both read it.

import { state } from "../../js/state.mjs";
import { render } from "./notify.mjs";

const LS_SPACE = "kosmozoo.workspace.v1";

export function initWorkspaceSpace() {
  try {
    if (localStorage.getItem(LS_SPACE) === "anchors") state.workspace = "anchors";
  } catch { /* private mode: session-only */ }
}

export function setWorkspace(space) {
  if (state.workspace === space) return;
  state.workspace = space;
  try { localStorage.setItem(LS_SPACE, space); } catch { /* ignore */ }
  render();
}
