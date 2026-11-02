// client-solid/features/diff/hit.mjs — gesture hit-testing for the
// comparator, pure. Which layer is VISIBLE at the pointer? That layer is
// the gesture's target, in every mode.
//
// The rule derives from the same layout state the renderer uses (mode, col,
// splitT) — never from a separate routing table — so a layer can never
// become unreachable: what you see is what you zoom. Lock stays a separate
// concern (the delta then also writes the peer key).

import { sideForColumn, workbenchLayout } from "./views.mjs";

export function hitLayer({ mode, col, splitT, x, paired = true, stageRect }) {
  const layout = workbenchLayout({ mode, subject: sideForColumn(col), splitT, paired });
  if (!paired) return layout.active;
  if (mode === "two-up" || mode === "split") {
    return x <= stageRect.left + layout.divider * stageRect.width ? layout.left : layout.right;
  }
  // Full/One-Up display the subject; Difference is a merged canvas.
  return layout.active;
}
