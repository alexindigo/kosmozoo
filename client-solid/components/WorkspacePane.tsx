// client-solid/components/WorkspacePane.tsx — the right-column workspace.
//
// Two spaces share the pane: the metadata details of the current image and
// the anchors feed. store.state.workspace picks which is shown — a <Switch>,
// so the hidden space is NOT mounted with its effects running (G17). The
// divider drag resizes the split via the shared drag primitive (persisted
// via core.ui.anchorWidth); the pane width is owned by the store signal
// alone — the CSS carries no duplicate default (H7).

import { createEffect, Switch, Match } from "solid-js";
import { useAppStore } from "../store/app-store.js";
import { useDrag } from "../lib/drag.js";
import { DetailsBody } from "./DetailsBody.js";
import { AnchorSpace } from "./AnchorSpace.js";

export function WorkspacePane() {
  const store = useAppStore();
  let asideEl;

  // the pane's right edge is snapshotted at drag start — the width derives
  // from it, no hand-synced constant
  const { dragging, ref: dividerRef } = useDrag({
    onStart: () => ({ right: asideEl.getBoundingClientRect().right }),
    onDrag: (ev, ctx) => {
      const w = Math.min(Math.max(ctx.right - ev.clientX, 220), window.innerWidth * 0.7);
      store.actions.anchors.setPaneWidth(Math.round(w));
    },
  });
  createEffect(() => store.actions.ui.setResizing(dragging()));

  return (
    <>
      <div id="divider" title="drag to resize the split" ref={dividerRef} />
      <aside id="workspace" ref={asideEl} style={{ width: `${store.state.anchorPaneWidth()}px` }}>
        <Switch>
          <Match when={store.state.workspace() === "anchors"}>
            <div id="wsAnchors" class="ws-space">
              <AnchorSpace />
            </div>
          </Match>
          <Match when={true}>
            <div id="wsDetails" class="ws-space">
              <DetailsBody />
            </div>
          </Match>
        </Switch>
      </aside>
    </>
  );
}
