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
// A proximity gate bounds the snap itself: it only tidies a NEARBY boundary
// (within SNAP_WINDOW_FRAC of the smaller of the column or the card). Deep
// inside a long image the nearest card top is far away, so a flick that
// lands there keeps the exact position instead of yanking the view up to
// half the card's height.
//
// Intent is read from the INPUT stream's own rate (px/ms of wheel deltas in
// a trailing window), not the feed's velocity — a careful drag and a flick
// differ hugely in input rate on every platform that emits wheel events,
// while the feed's velocity is flat wherever scroll applies instantly. The
// coast tail is a secondary signal for platforms with real momentum
// (macOS/Windows, WheelEvent.momentum); on instant-application platforms it
// is absent and the input rate carries the whole decision.
//
// Fallback: when no measurable tail exists (scroll applies instantly — e.g.
// headless browsers), peak windowed velocity carries the intent instead
// (fast + far = inertia). Programmatic scrolls (deep-link centering, the
// back-to-top button) suppress the snap AND zero both streams.

import { state } from "../../js/state.mjs";

// nothing happens until scrolling has been quiet this long
const SETTLE_MS = 150;
// ignore scroll events caused by our own snap animation
const SNAP_QUIET_MS = 500;
// feed coasted this long after the fingers stopped → inertia
const GAP_THRESHOLD_MS = 300;
// below this, a "tail" is event jitter, not a coast
const TAIL_FLOOR_MS = 40;
// a coast that barely moved is still an adjustment
const MIN_DIST = 200;
// input-rate gate: px/ms of the wheel delta stream in a trailing window —
// the primary signal on instant-application platforms (Linux Chromium,
// headless), where no coast tail exists. A deliberate mouse-wheel scroll
// runs ~1–1.5 (100px notches at ~140ms, jitter included); a flick sustains
// 2.5+ over the window. The bar sits above deliberate scrolling.
const RATE_THRESHOLD = 2.5;
// the trailing window for the input-rate samples — long enough that a
// 2-notch burst averages out instead of spiking over the bar
const WINDOW_MS = 200;
// proximity gate: the snap only tidies a NEARBY boundary. If the nearest
// card top is farther than this fraction of the smaller of the column or
// the card, we're deep inside content (a long image) — keep the position.
const SNAP_WINDOW_FRAC = 0.35;

let quietUntil = 0;
// current gesture; gestureStart === null means idle
let gestureStart = null;  // scrollTop at the gesture's origin
let gestureStartT = 0;    // time of the gesture's first scroll event
let wheelSamples = [];    // [time, |deltaY|] of non-momentum wheel events
let peakRate = 0;         // peak wheel-stream rate this gesture, px/ms
let wheelCount = 0;       // wheel events seen in this gesture
let lastInputT = 0;       // FINGERS: last non-momentum wheel / touchmove
let lastScrollT = 0;      // MOVEMENT: last scroll event

// Opt-in debug: localStorage.snapdebug = "1" (or load with ?snapdebug) logs
// one line per settled gesture — the gate's inputs and the verdict — so the
// thresholds can be calibrated against the real browser's input stream.
const DEBUG_SNAP = (() => {
  try {
    if (new URLSearchParams(location.search).has("snapdebug")) {
      localStorage.setItem("snapdebug", "1");
      return true;
    }
    return localStorage.getItem("snapdebug") === "1";
  } catch {
    return false;
  }
})();

function dbgGesture(net, tail, rate, wheels, verdict) {
  if (!DEBUG_SNAP) return;
  console.log(
    `[snap] ${verdict}: net=${Math.round(net)} tail=${Math.round(tail)} ` +
    `rate=${rate.toFixed(2)} wheels=${wheels}`
  );
}

if (DEBUG_SNAP) console.log("[snap] debug enabled (localStorage.snapdebug)");

// Call after a programmatic scroll (e.g. restoreToIndex) so the snap doesn't
// immediately fight it — and so the programmatic movement doesn't count as
// the start of the user's next gesture.
export function suppressScrollSnap(ms = SNAP_QUIET_MS) {
  quietUntil = Math.max(quietUntil, Date.now() + ms);
  gestureStart = null;
  wheelSamples = [];
  peakRate = 0;
  wheelCount = 0;
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
  // (WheelEvent.momentum, where the browser exposes it), plus touch moves.
  const finger = (dy) => {
    lastInputT = performance.now();
    if (dy != null) { wheelCount += 1; trackWheel(lastInputT, dy); }
  };
  col.addEventListener("wheel", (e) => { if (!e.momentum) finger(e.deltaY); }, { passive: true });
  col.addEventListener("touchmove", () => finger(), { passive: true });

  // MOVEMENT — scroll events from any cause.
  col.addEventListener("scroll", () => {
    if (Date.now() < quietUntil) return; // programmatic/own snap still animating
    const now = performance.now();
    lastScrollT = now;
    if (gestureStart === null) { gestureStart = col.scrollTop; gestureStartT = now; } // gesture begins
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      const net = Math.abs(col.scrollTop - gestureStart);
      // tail = how long the feed outlived the fingers (−1: no finger events
      // inside this gesture — keyboard/unknown source)
      const tail = lastInputT >= gestureStartT ? lastScrollT - lastInputT : -1;
      let inertia, gate;
      if (tail > TAIL_FLOOR_MS) {
        gate = "tail";
        inertia = tail > GAP_THRESHOLD_MS && net > MIN_DIST;
      } else {
        gate = "rate";
        inertia = peakRate > RATE_THRESHOLD && net > MIN_DIST;
      }
      let verdict = "skip";
      if (inertia) {
        const before = col.scrollTop;
        snap();
        verdict = col.scrollTop !== before ? "snap" : "blocked";
      }
      dbgGesture(net, tail, peakRate, wheelCount, `${verdict} gate=${gate}`);
      gestureStart = null;
      wheelSamples = [];
      peakRate = 0;
      wheelCount = 0;
      lastInputT = 0;
    }, SETTLE_MS);
  }, { passive: true });
}
