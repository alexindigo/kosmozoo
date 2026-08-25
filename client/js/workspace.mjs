// client/js/workspace.mjs — scrolling IS browsing.
//
// The top card becomes the current image: the scroll handler sets
// state.current (the single current-image pointer) and mirrors it to the URL;
// <Grid>'s current ring and the details pane both read state.current, so they
// follow. The workspace bar and the pane itself are components
// (<WorkspaceBar>, <WorkspacePane>).

import { state } from "./state.mjs";
import { render } from "../app/services/notify.mjs";
import { setCurrent } from "./route.mjs";

export function initWorkspace() {
  const col = document.getElementById("candidatesCol");
  let raf = 0;
  col.addEventListener("scroll", () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (state.diff.open) return;
      const file = topCardFile(col);
      if (!file || file === state.current?.image) return;
      setCurrent(state.host, file);
      render(); // the ring + details pane follow state.current
    });
  });
}

// the last card whose top crossed the feed's vertical midpoint (raw filename)
function topCardFile(col) {
  const mid = col.getBoundingClientRect().top + col.clientHeight / 2;
  let file = null;
  for (const el of col.querySelectorAll(".card[data-idx]")) {
    if (el.getBoundingClientRect().top > mid) break;
    const img = state.images[Number(el.dataset.idx)];
    if (img) file = img.filename;
  }
  return file;
}
