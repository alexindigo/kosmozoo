// client-solid/components/WorkspaceBar.tsx — the narrow bar at the right
// edge: one button per workspace space (details on top, the default). The
// choice persists; the pane follows store.state.workspace.

import { iconSvg } from "/js/icons.mjs";
import { useAppStore } from "../store/app-store.js";

export function WorkspaceBar() {
  const store = useAppStore();
  return (
    <nav id="wsBar">
      <button
        id="wsBtnDetails" data-space="details" title="image details"
        class={store.state.workspace() === "details" ? "on" : ""}
        onClick={() => store.actions.ui.setWorkspace("details")}
        innerHTML={iconSvg("info-circle", 16)}
      />
      <button
        id="wsBtnAnchors" data-space="anchors" title="anchors"
        class={store.state.workspace() === "anchors" ? "on" : ""}
        onClick={() => store.actions.ui.setWorkspace("anchors")}
        innerHTML={iconSvg("anchor", 16)}
      />
    </nav>
  );
}
