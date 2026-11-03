// Tune these thresholds from real touchpad traces, not synthetic wheel timing.
export const WHEEL_REST_MS = 250;
export const WHEEL_HOLD_MS = 120;
export const WHEEL_RELEASE_PX = 48;

// Pure feed-owned state machine: callers supply monotonic time and own timers,
// DOM cancellation and the single scroll writer. A release is consumed once.
export function makeWheelArbiter(now = 0) {
  let scrollAt = now, wheelAt = now, released = false, held = null;
  const release = () => {
    const delta = held && { dx: held.dx, dy: held.dy };
    held = null; released = true;
    return delta;
  };
  return {
    reset(now) { scrollAt = wheelAt = now; released = false; held = null; },
    scrolled(now) { scrollAt = now; },
    tick(now) { return held && now >= held.deadline ? release() : null; },
    wheel({ now, media, ctrl = false, dx = 0, dy = 0 }) {
      if (ctrl && media) {
        held = null; released = true; wheelAt = now;
        return { prevent: false, pinch: true };
      }
      if (!media || ctrl) return { prevent: false };
      if (released && now - Math.max(scrollAt, wheelAt) >= WHEEL_REST_MS) released = false;
      wheelAt = now;
      if (released || (!held && now - scrollAt < WHEEL_REST_MS)) return { prevent: false };
      held ??= { dx: 0, dy: 0, deadline: now + WHEEL_HOLD_MS };
      held.dx += dx; held.dy += dy;
      if (Math.abs(held.dy) >= WHEEL_RELEASE_PX || now >= held.deadline) return { prevent: true, release: release() };
      return { prevent: true, deadline: held.deadline };
    },
  };
}
