// client-solid/components/WorkspacePane.tsx — the right-column workspace.
//
// Two spaces share the pane: the metadata details of the current image and
// the anchors feed (phase 6). store.state.workspace picks which is shown.

import { useAppStore } from "../store/app-store.js";
import { DetailsBody } from "./DetailsBody.js";

export function WorkspacePane() {
  const store = useAppStore();
  return (
    <aside id="workspace">
      <div id="wsDetails" class="ws-space" hidden={store.state.workspace() !== "details"}>
        <DetailsBody />
      </div>
      <div id="wsAnchors" class="ws-space" hidden={store.state.workspace() !== "anchors"}>
        {/* AnchorSpace lands in phase 6 */}
      </div>
    </aside>
  );
}
