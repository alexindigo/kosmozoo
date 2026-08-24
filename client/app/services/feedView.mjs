// client/app/services/feedView.mjs — the feed's view derivation.
//
// Moved from main.mjs so the <Header> filter can rebuild the feed without
// importing the legacy entry (which would boot it). Pure over `state`: the
// filter + judgment visibility decide which image indices are on screen.

import { state } from "../../js/state.mjs";
import { isVisible } from "../../js/judgment.mjs";
import { renderFeed } from "../../js/feed.mjs";

export function rebuildFeed() {
  const q = state.filter.toLowerCase();
  const view = [];
  for (let i = 0; i < state.images.length; i++) {
    const img = state.images[i];
    if (q && !img.filename.toLowerCase().includes(q)) continue;
    if (!isVisible(img)) continue;
    view.push(i);
  }
  renderFeed(document.getElementById("grid"), view);
}

export function viewCount() {
  const q = state.filter.toLowerCase();
  return state.images.filter((i) =>
    (!q || i.filename.toLowerCase().includes(q)) && isVisible(i)).length;
}

export function statusSummary() {
  const hidden = state.images.filter((i) => i.judgment?.vote === "down").length;
  const base = state.filter
    ? `${viewCount()} of ${state.images.length} matching “${state.filter}” from ${state.host}`
    : `${state.images.length} images from ${state.host}`;
  return base + (hidden ? ` (${hidden} hidden)` : "");
}
