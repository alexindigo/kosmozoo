// client/js/diff.mjs — the /diff comparison view (v1, grows as we go).
//
// Two resolved sides (route.resolveSide) rendered side by side over black.
// The URL /diff#<srcL>#<fileL>:<srcR>#<fileR> is the view's state: pasted
// URLs boot it, onUrlChange re-opens it on back/forward, Esc closes it
// (history.back() when we pushed, replaceState to the feed URL otherwise).
//
// v1 scope: open, render, close. Stepping, blink, votes, zoom land later.

import { state, render, onRender } from "./state.mjs";
import { diffUrl, resolveSide } from "./route.mjs";

export function initDiff() {
  document.getElementById("diffClose").addEventListener("click", () => closeDiff());
  document.addEventListener("keydown", (e) => {
    if (!state.diff.open) return;
    if (state.keysPanelOpen || state.capturing) return; // panel outranks
    if (e.key === "Escape") { e.preventDefault(); closeDiff(); }
  });
}

export function openDiff(left, right, { push } = {}) {
  if (!resolveSide(left) || !resolveSide(right)) return false;
  state.diff = { open: true, left, right };
  const url = diffUrl(left, right);
  if (push) history.pushState({ kz: 1 }, "", url);
  else if (location.pathname + location.hash !== url) {
    history.replaceState(history.state, "", url);
  }
  render();
  return true;
}

export function closeDiff() {
  if (!state.diff.open) return;
  const left = state.diff.left;
  state.diff = { open: false, left: null, right: null };
  if (history.state?.kz) {
    history.back(); // popstate lands on the feed URL; onUrlChange applies it
  } else {
    const feed = left && state.hosts[left.source]
      ? `/#${encodeURIComponent(left.source)}#${encodeURIComponent(left.file)}`
      : `/#${encodeURIComponent(state.host)}`;
    history.replaceState(null, "", feed);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
  render();
}

onRender((s) => {
  if (typeof document === "undefined") return;
  const ov = document.getElementById("diff");
  if (!ov) return;
  ov.hidden = !s.diff.open;
  if (!s.diff.open) return;
  for (const [side, id] of [[s.diff.left, "diffL"], [s.diff.right, "diffR"]]) {
    const fig = document.getElementById(id);
    const r = resolveSide(side);
    const img = fig.querySelector("img");
    if (r && img.dataset.cur !== r.src) { img.src = r.src; img.dataset.cur = r.src; }
    fig.querySelector(".difflabel").textContent = side ? `${side.source}#${side.file}` : "";
  }
});
