// client-solid/components/WorkspacePane.tsx — the right-column workspace.
//
// Two spaces share the pane: the metadata details of the current image and
// the anchors feed. store.state.workspace picks which is shown. The divider
// drag resizes the split (persisted via core.ui.anchorWidth).

import { onMount, onCleanup } from "solid-js";
import { useAppStore } from "../store/app-store.js";
import { DetailsBody } from "./DetailsBody.js";
import { AnchorSpace } from "./AnchorSpace.js";

export function WorkspacePane() {
  const store = useAppStore();
  let asideEl;
  let dividerEl;

  onMount(() => {
    // divider drag resizes the split between the feeds (persisted)
    const divider = dividerEl;
    if (!divider) return;
    // the pane's right edge is fixed by the workspace bar during a drag —
    // the width derives from it, no hand-synced constant
    let dragRight = 0;
    const move = (ev) => {
      const w = Math.min(Math.max(dragRight - ev.clientX, 220), window.innerWidth * 0.7);
      store.actions.anchors.setPaneWidth(Math.round(w));
    };
    const up = () => {
      document.body.classList.remove("resizing");
      divider.classList.remove("dragging");
      divider.removeEventListener("pointermove", move);
      divider.removeEventListener("pointerup", up);
    };
    const down = (e) => {
      e.preventDefault();
      divider.setPointerCapture(e.pointerId);
      document.body.classList.add("resizing");
      divider.classList.add("dragging");
      dragRight = asideEl.getBoundingClientRect().right;
      divider.addEventListener("pointermove", move);
      divider.addEventListener("pointerup", up);
    };
    divider.addEventListener("pointerdown", down);
    onCleanup(() => divider.removeEventListener("pointerdown", down));
  });

  return (
    <>
      <div id="divider" title="drag to resize the split" ref={(el) => { dividerEl = el; }} />
      <aside id="workspace" ref={asideEl} style={{ width: `${store.state.anchorPaneWidth()}px` }}>
        <div id="wsDetails" class="ws-space" hidden={store.state.workspace() !== "details"}>
          <DetailsBody />
        </div>
        <div id="wsAnchors" class="ws-space" hidden={store.state.workspace() !== "anchors"}>
          <AnchorSpace />
        </div>
      </aside>
    </>
  );
}
