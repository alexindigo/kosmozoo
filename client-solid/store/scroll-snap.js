// client-solid/store/scroll-snap.js — feed scroll snap, settle-time only.
//
// Architecture: while a scroll gesture is active, nothing repositions — the
// feed renders and the rail tracks. The snap lives entirely on the other
// side of the settle line: when the store's settle pipeline fires, a tidy
// may pull the feed a short distance to a card boundary — in the direction
// the gesture was already traveling, and never more than SNAP_TIDY_PX. No
// wheel-rate classification, no device tuning: the model is direction +
// proximity, which works the same on every input device.
//
// Nothing fires while a programmatic scroll is in flight (quiet window).

// a tidy, never a yank: beyond this distance the user's landing stands
const SNAP_TIDY_PX = 120;
// below this net travel it was a wiggle, not a gesture — no snap
const TRAVEL_FLOOR_PX = 24;
// ignore scroll events caused by our own snap animation
const SNAP_QUIET_MS = 500;

let quietUntil = 0;

// Call after a programmatic scroll (e.g. restoreToIndex) so the snap doesn't
// immediately fight it.
export function suppressScrollSnap(ms = SNAP_QUIET_MS) {
  quietUntil = Math.max(quietUntil, Date.now() + ms);
}

// True while a programmatic scroll is in flight — the feed's bottom guard
// checks this so it doesn't pin a smooth scroll passing the near-bottom zone.
export function snapQuiet() {
  return Date.now() < quietUntil;
}

// Settle-time tidy. direction: sign of net travel (1 down, -1 up); net: px of
// travel this gesture. Targets the card boundary the gesture was heading
// toward (down: the next card top ahead; up: the nearest top behind),
// within SNAP_TIDY_PX — a small smooth ease, never a backward pull.
export function snapTidy(col, virtualizer, { isDiffOpen, direction, net }) {
  if (!col || !virtualizer || snapQuiet() || isDiffOpen()) return;
  if (!direction || Math.abs(net) < TRAVEL_FLOOR_PX) return;
  const items = virtualizer.getVirtualItems();
  if (!items.length) return;
  const top = col.scrollTop;
  let target = null;
  if (direction > 0) {
    for (const it of items) {
      if (it.start > top && (target === null || it.start < target)) target = it.start;
    }
  } else {
    for (const it of items) {
      if (it.start <= top && (target === null || it.start > target)) target = it.start;
    }
  }
  if (target === null) return;
  const delta = target - top;
  if (Math.abs(delta) < 1 || Math.abs(delta) > SNAP_TIDY_PX) return;
  quietUntil = Date.now() + SNAP_QUIET_MS;
  col.scrollTo({ top: target, behavior: "smooth" });
}
