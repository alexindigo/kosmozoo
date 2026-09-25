// client-solid/features/diff/hit.mjs — gesture hit-testing for the
// comparator, pure. Which layer is VISIBLE at the pointer? That layer is
// the gesture's target, in every mode.
//
// The rule derives from the same layout state the renderer uses (mode, col,
// splitT) — never from a separate routing table — so a layer can never
// become unreachable: what you see is what you zoom. Lock stays a separate
// concern (the delta then also writes the peer key).

export function hitLayer({ mode, col, splitT, x, cellBRect, stageRect }) {
  // Two-Up: the cell under the pointer
  if (mode === "two-up") {
    return cellBRect && x >= cellBRect.left && x <= cellBRect.right ? "b" : "a";
  }
  // Split: the active (top, clipped) layer shows right of the wipe; the
  // inactive (bottom) layer shows left of it
  if (mode === "split") {
    const wipeX = stageRect.left + (splitT ?? 0.5) * stageRect.width;
    const rightOfWipe = x > wipeX;
    const activeIsB = col === "right";
    return rightOfWipe === activeIsB ? "b" : "a";
  }
  // One-Up (only the active layer is visible) and Difference (a merged
  // canvas — no per-side hit region): the active column
  return col === "right" ? "b" : "a";
}
