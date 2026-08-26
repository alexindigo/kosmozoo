// client/app/services/scrollSnap.mjs — feed scroll snap with intent.
//
// Two parallel streams are tracked:
//   FINGERS  — wheel events (platform momentum events excluded when the
//              browser labels them: WheelEvent.momentum, W3C Pointer Events)
//              plus touchmove; the stream runs while the user is physically
//              scrolling.
//   MOVEMENT — scroll events; the stream runs while the feed is moving,
//              from any cause.
//
// The gap between the two decides. When the feed keeps moving after the
// fingers stopped, that tail is inertia — a flick or long spin — and the
// feed aligns on settle (nearest card top to the column top), in either
// direction. When the streams stop together, the user was positioning: the
// feed settles exactly where they left it, at any distance, never snapped.
// Nothing happens until scrolling has been quiet for SETTLE_MS — the tail
// must fully drain first.
//
// Fallback: when no measurable tail exists (scroll applies instantly — e.g.
// headless browsers), peak windowed velocity carries the intent instead
// (fast + far = inertia). Programmatic scrolls (deep-link centering, the
// back-to-top button) suppress the snap AND zero both streams.

import { state } from "../../js/state.mjs";

// scrolling must be quiet this long before anything fires
const SETTLE_MS = 150;
// ignore scroll events caused by our own snap animation
const SNAP_QUIET_MS = 500;
// feed coasted this long after the fingers stopped → inertia
const GAP_THRESHOLD_MS = 300;
// below this, a "tail" is event jitter, not a coast
const TAIL_FLOOR_MS = 40;
// a coast that barely moved is still an adjustment
const MIN_DIST = 200;
// no-tail fallback: peak windowed velocity (px/ms) and its sample window
const VEL_THRESHOLD = 0.8;
const WINDOW_MS = 100;

let quietUntil = 0;
// current gesture; gestureStart === null means idle
let gestureStart = null;  // scrollTop at the gesture's origin
let gestureStartT = 0;    // time of the gesture's first scroll event
let samples = [];         // [time, scrollTop] trailing window for velocity
let peakV = 0;            // peak windowed velocity this gesture, px/ms
let lastInputT = 0;       // FINGERS: last non-momentum wheel / touchmove
let lastScrollT = 0;      // MOVEMENT: last scroll event

// Call after a programmatic scroll (e.g. restoreToIndex) so the snap doesn't
// immediately fight it — and so the programmatic movement doesn't count as
// the start of the user's next gesture.
export function suppressScrollSnap(ms = SNAP_QUIET_MS) {
  quietUntil = Math.max(quietUntil, Date.now() + ms);
  gestureStart = null;
  samples = [];
  peakV = 0;
  lastInputT = 0;
  lastScrollT = 0;
}

export function initScrollSnap() {
  const col = document.getElementById("candidatesCol");
  if (!col) return;

  let settleTimer = null;

  const snap = () => {
    // don't fight an open overlay
    if (state.diff.open) return;
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

  const track = (now, top) => {
    samples.push([now, top]);
    while (samples.length > 2 && now - samples[1][0] > WINDOW_MS) samples.shift();
    const [t0, top0] = samples[0];
    const dt = now - t0;
    if (dt >= WINDOW_MS * 0.8) {
      const v = Math.abs(top - top0) / dt;
      if (v > peakV) peakV = v;
    }
  };

  // FINGERS — wheel events that are not platform-synthesized momentum
  // (WheelEvent.momentum, where the browser exposes it), plus touch moves.
  const finger = () => { lastInputT = performance.now(); };
  col.addEventListener("wheel", (e) => { if (!e.momentum) finger(); }, { passive: true });
  col.addEventListener("touchmove", finger, { passive: true });

  // MOVEMENT — scroll events from any cause.
  col.addEventListener("scroll", () => {
    if (Date.now() < quietUntil) return; // programmatic/own snap still animating
    const now = performance.now();
    const top = col.scrollTop;
    lastScrollT = now;
    if (gestureStart === null) { gestureStart = top; gestureStartT = now; } // gesture begins
    track(now, top);
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      const net = Math.abs(col.scrollTop - gestureStart);
      // tail = how long the feed outlived the fingers (−1: no finger events
      // inside this gesture — keyboard/unknown source)
      const tail = lastInputT >= gestureStartT ? lastScrollT - lastInputT : -1;
      let inertia;
      if (tail > TAIL_FLOOR_MS) {
        // a real coast: the gap decides
        inertia = tail > GAP_THRESHOLD_MS && net > MIN_DIST;
      } else {
        // no measurable tail (instant scroll application): velocity decides
        inertia = peakV > VEL_THRESHOLD && net > MIN_DIST;
      }
      gestureStart = null;
      samples = [];
      peakV = 0;
      lastInputT = 0;
      if (inertia) snap();
    }, SETTLE_MS);
  }, { passive: true });
}
