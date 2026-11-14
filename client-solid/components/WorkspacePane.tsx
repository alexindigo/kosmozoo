// client-solid/components/WorkspacePane.tsx — the right-column workspace.
//
// Two spaces share the pane: the metadata details of the current image and
// the anchors feed. store.state.workspace picks which is shown — a <Switch>,
// so the hidden space is NOT mounted with its effects running . The
// divider drag resizes the split via the shared drag primitive (persisted
// via core.ui.anchorWidth); the pane width is owned by the store signal
// alone — the CSS carries no duplicate default .

import { createEffect, createMemo } from "solid-js";
import { Dynamic } from "solid-js/web";
import { useAppStore } from "../store/app-store.js";
import { useDrag } from "../lib/drag.js";

export function WorkspacePane() {
  const store = useAppStore();
  const space = createMemo(() => store.state.workspaceSpaces().find(space => space.id === store.state.workspace()));
  let asideEl;

  // the pane is anchored RIGHT of its own box (the wsBar sits after it, so
  // the container's edge is not the pane's edge): the fraction is measured
  // against the pane's rect from its right edge — the same anchor-edge
  // vocabulary as every divider
  const { dragging, ref: dividerRef } = useDrag({
    axis: () => "x-",
    onStart: () => ({ box: asideEl.getBoundingClientRect() }),
    onDrag: (ev, ctx) => {
      const w = Math.min(Math.max(ctx.frac * ctx.box.width, 220), window.innerWidth * 0.7);
      store.actions.anchors.setPaneWidth(Math.round(w));
    },
  });
  createEffect(() => store.actions.ui.setResizing(dragging()));

  return (
    <>
      <div id="divider" title="drag to resize the split" ref={dividerRef} />
      <aside id="workspace" ref={asideEl}
        classList={{ "workspace-details": space()?.chrome === "details" }}
        style={{ width: `${store.state.anchorPaneWidth()}px` }}>
        <div class="ws-space"><Dynamic component={space()?.component} ports={space()?.ports} /></div>
      </aside>
    </>
  );
}
