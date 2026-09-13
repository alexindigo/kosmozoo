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
// This module is one pure function + its constants. The quiet window (a
// programmatic scroll in flight) is a STORE signal — programmaticScrollUntil
// — set and read by the settle pipeline; no module globals (B6).

// a tidy, never a yank: beyond this distance the user's landing stands
export const SNAP_TIDY_PX = 120;
// below this net travel it was a wiggle, not a gesture — no snap
export const TRAVEL_FLOOR_PX = 24;
// how long a programmatic scroll stays in flight (the quiet window)
export const SNAP_QUIET_MS = 500;

// Settle-time tidy — pure: no state, no timers, no module globals.
// items: the virtualizer's current items; direction: sign of net travel
// (1 down, -1 up); net: px of travel this gesture. Targets the card boundary
// the gesture was heading toward (down: the next card top ahead; up: the
// nearest top behind), within SNAP_TIDY_PX — a small smooth ease, never a
// backward pull. Returns true when a tidy scroll started (the caller opens
// the quiet window).
export function snapTidy(col, items, { direction, net }) {
  if (!col || !items?.length) return false;
  if (!direction || Math.abs(net) < TRAVEL_FLOOR_PX) return false;
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
  if (target === null) return false;
  const delta = target - top;
  if (Math.abs(delta) < 1 || Math.abs(delta) > SNAP_TIDY_PX) return false;
  col.scrollTo({ top: target, behavior: "smooth" });
  return true;
}
