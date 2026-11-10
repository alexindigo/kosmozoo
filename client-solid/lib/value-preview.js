import { popoverPlacement } from "./popover-placement.js";

export const PREVIEW_GRACE = 180;
export function valuePreviewPlacement(trigger, viewport, size) {
  const placed = popoverPlacement(trigger, viewport, size, 8);
  if (!placed) return null;
  const notch = 8, radius = 6;
  const anchor = Math.max(radius + notch, Math.min(placed.width - radius - notch,
    (trigger.left + trigger.right) / 2 - placed.left));
  const w = placed.width, h = placed.height, top = placed.side === "below" ? notch : 0,
    bottom = placed.side === "above" ? h - notch : h;
  const upper = placed.side === "below" ? `L${anchor-notch},${top} L${anchor},0 L${anchor+notch},${top}` : "";
  const lower = placed.side === "above" ? `L${anchor+notch},${bottom} L${anchor},${h} L${anchor-notch},${bottom}` : "";
  return { ...placed, anchor, notch, path: `M${radius},${top} ${upper} L${w-radius},${top} Q${w},${top} ${w},${top+radius} L${w},${bottom-radius} Q${w},${bottom} ${w-radius},${bottom} ${lower} L${radius},${bottom} Q0,${bottom} 0,${bottom-radius} L0,${top+radius} Q0,${top} ${radius},${top} Z` };
}

// One presentation lifetime. Selection and native drag hold an existing popup;
// only entering/focusing a surface can open one. Suspension never reopens it.
export function makeValuePreview({ show, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const holds = new Set(); let open = false, timer = null, alive = true;
  const cancel = () => { if (timer !== null) clearTimer(timer); timer = null; };
  const dismiss = () => { cancel(); holds.clear(); if (open) { open = false; show(false); } };
  return {
    hold(key, value, admit = false) {
      if (!alive) return;
      if (value) { holds.add(key); cancel(); if (admit && !open) { open = true; show(true); } }
      else { holds.delete(key); if (open && !holds.size) { cancel(); timer = setTimer(dismiss, PREVIEW_GRACE); } }
    },
    dismiss,
    dispose() { dismiss(); alive = false; },
  };
}
