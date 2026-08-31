// client-solid/store/scroll-snap.tsx — feed scroll snap with intent.
//
// Intent is read from the WHEEL STREAM's own rate (px/ms of deltas in a
// trailing window). Measured on real Brave/Linux input: a careful scroll
// runs 0.16–0.99 px/ms, a flick 28–37 — the bar sits far from both.
//
// A proximity gate bounds the snap itself: it only tidies a NEARBY boundary
// (within SNAP_WINDOW_FRAC of the smaller of the column or the card). Deep
// inside a long image the nearest card top is far away, so a flick that
// lands there keeps the exact position instead of yanking the view up to
// half the card's height.
//
// Nothing happens until scrolling has been quiet for SETTLE_MS.

// scrolling must be quiet this long before anything fires
const SETTLE_MS = 150;
// ignore scroll events caused by our own snap animation
const SNAP_QUIET_MS = 500;
// a coast that barely moved is still an adjustment
const MIN_DIST = 200;
// input-rate gate: px/ms of the wheel delta stream in a trailing window.
// Real Brave/Linux input measures: careful scroll 0.16–0.99, flick 28–37.
const RATE_THRESHOLD = 2.5;
// the trailing window for the input-rate samples — long enough that a
// 2-notch burst averages out instead of spiking over the bar
const WINDOW_MS = 200;
// wheel events after a gap this long start a fresh rate measurement —
// catching a coasting feed must not inherit the flick's rate
const INPUT_STALE_MS = 250;
// proximity gate: the snap only tidies a NEARBY boundary. If the nearest
// card top is farther than this fraction of the smaller of the column or
// the card, we're deep inside content (a long image) — keep the position.
const SNAP_WINDOW_FRAC = 0.35;

let quietUntil = 0;
// current gesture; gestureStart === null means idle
let gestureStart = null;  // scrollTop at the gesture's origin
let wheelSamples = [];    // [time, |deltaY|] of non-momentum wheel events
let peakRate = 0;         // peak wheel-stream rate this gesture, px/ms
let wheelCount = 0;       // wheel events seen in this gesture
let lastWheelT = 0;       // last non-momentum wheel event (persists across gestures)

// Call after a programmatic scroll (e.g. restoreToIndex) so the snap doesn't
// immediately fight it — and so the programmatic movement doesn't count as
// the start of the user's next gesture.
export function suppressScrollSnap(ms = SNAP_QUIET_MS) {
  quietUntil = Math.max(quietUntil, Date.now() + ms);
  gestureStart = null;
  wheelSamples = [];
  peakRate = 0;
  wheelCount = 0;
}

// True while a programmatic scroll is in flight — the feed's safety net
// checks this so it doesn't pin a smooth scroll that passes through the
// near-bottom zone.
export function snapQuiet() {
  return Date.now() < quietUntil;
}

// isDiffOpen: the snap never fights an open workbench
export function initScrollSnap(col, { isDiffOpen }) {
  if (!col) return () => {};

  let settleTimer = null;

  const snap = () => {
    if (isDiffOpen()) return;
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
    // proximity gate: only tidy a nearby boundary. Deep inside a long card
    // the nearest top is far away — the user's position stays untouched.
    const cardH = best.getBoundingClientRect().height;
    const window = Math.min(col.clientHeight, cardH) * SNAP_WINDOW_FRAC;
    if (Math.abs(delta) > window) return;
    quietUntil = Date.now() + SNAP_QUIET_MS;
    col.scrollTo({ top: col.scrollTop + delta, behavior: "smooth" });
  };

  // track the wheel stream's rate (px/ms of deltas in the trailing window).
  // dt floors at ~60ms: a real flick's wheel stream is short (a few notches
  // in ~100ms), and requiring the full window would miss it entirely.
  const trackWheel = (now, dy) => {
    wheelSamples.push([now, Math.abs(dy)]);
    while (wheelSamples.length > 2 && now - wheelSamples[1][0] > WINDOW_MS) wheelSamples.shift();
    const dt = now - wheelSamples[0][0];
    if (dt >= 60) {
      const rate = wheelSamples.reduce((s, [, d]) => s + d, 0) / dt;
      if (rate > peakRate) peakRate = rate;
    }
  };

  // FINGERS — wheel events that are not platform-synthesized momentum
  // (WheelEvent.momentum, where the browser exposes it). Wheel events after
  // a gap start a fresh rate measurement: catching a coasting feed is new
  // input, and its rate must not inherit the flick that started the coast.
  const onWheel = (e) => {
    if (e.momentum) return;
    const now = performance.now();
    if (now - lastWheelT > INPUT_STALE_MS) {
      wheelSamples = [];
      peakRate = 0;
      wheelCount = 0;
    }
    lastWheelT = now;
    wheelCount += 1;
    trackWheel(now, e.deltaY);
  };
  col.addEventListener("wheel", onWheel, { passive: true });

  // MOVEMENT — scroll events from any cause.
  const onScroll = () => {
    if (Date.now() < quietUntil) return; // programmatic/own snap still animating
    if (gestureStart === null) gestureStart = col.scrollTop; // gesture begins
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      const net = Math.abs(col.scrollTop - gestureStart);
      const inertia = peakRate > RATE_THRESHOLD && net > MIN_DIST;
      if (inertia) snap();
      gestureStart = null;
      wheelSamples = [];
      peakRate = 0;
      wheelCount = 0;
    }, SETTLE_MS);
  };
  col.addEventListener("scroll", onScroll, { passive: true });

  return () => {
    col.removeEventListener("wheel", onWheel);
    col.removeEventListener("scroll", onScroll);
    clearTimeout(settleTimer);
  };
}
