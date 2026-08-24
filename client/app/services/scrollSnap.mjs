// client/app/services/scrollSnap.mjs — feed scroll snap.
//
// After the feed stops scrolling, the nearest card's TOP edge snaps to the TOP
// edge of the feed column. Only the top edge (never bottom/center), and only
// once scrolling has settled — never mid-scroll. Programmatic scrolls (deep-link
// centering via restoreToIndex) suppress the snap briefly so it doesn't clobber
// the centered position.

import { state } from "../../js/state.mjs";

// how long after the last scroll event we consider scrolling "stopped"
const SETTLE_MS = 150;
// ignore scroll events caused by our own snap animation
const SNAP_QUIET_MS = 500;

let quietUntil = 0;

// Call after a programmatic scroll (e.g. restoreToIndex) so the snap doesn't
// immediately fight it.
export function suppressScrollSnap(ms = SNAP_QUIET_MS) {
  quietUntil = Math.max(quietUntil, Date.now() + ms);
}

export function initScrollSnap() {
  const col = document.getElementById("candidatesCol");
  if (!col) return;

  let settleTimer = null;

  const snap = () => {
    // don't fight an open overlay
    if (state.lightbox.open || state.diff.open) return;
    const colTop = col.getBoundingClientRect().top;
    let best = null;
    let bestDist = Infinity;
    for (const el of col.querySelectorAll(".card[data-idx]")) {
      const d = Math.abs(el.getBoundingClientRect().top - colTop);
      if (d < bestDist) { bestDist = d; best = el; }
    }
    if (!best) return;
    const delta = best.getBoundingClientRect().top - colTop;
    if (Math.abs(delta) < 1) return; // already snapped
    quietUntil = Date.now() + SNAP_QUIET_MS;
    col.scrollTo({ top: col.scrollTop + delta, behavior: "smooth" });
  };

  col.addEventListener("scroll", () => {
    if (Date.now() < quietUntil) return; // programmatic/own snap still animating
    clearTimeout(settleTimer);
    settleTimer = setTimeout(snap, SETTLE_MS);
  }, { passive: true });
}
