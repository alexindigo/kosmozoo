import { popoverPlacement } from "./popover-placement.js";

export const VALUE_PREVIEW_GAP = 8;
export function valuePreviewPlacement(trigger, viewport, size) {
  const placed = popoverPlacement(trigger, viewport, size, VALUE_PREVIEW_GAP);
  if (!placed) return null;
  const notch = 8, radius = 6;
  const anchor = Math.max(radius + notch, Math.min(placed.width - radius - notch,
    (trigger.left + trigger.right) / 2 - placed.left));
  const w = placed.width, h = placed.height, top = placed.side === "below" ? notch : 0,
    bottom = placed.side === "above" ? h - notch : h;
  const upper = placed.side === "below" ? `L${anchor-notch},${top} L${anchor},0 L${anchor+notch},${top}` : "";
  const lower = placed.side === "above" ? `L${anchor+notch},${bottom} L${anchor},${h} L${anchor-notch},${bottom}` : "";
  return { ...placed, anchor, notch, gap: VALUE_PREVIEW_GAP, path: `M${radius},${top} ${upper} L${w-radius},${top} Q${w},${top} ${w},${top+radius} L${w},${bottom-radius} Q${w},${bottom} ${w-radius},${bottom} ${lower} L${radius},${bottom} Q0,${bottom} 0,${bottom-radius} L0,${top+radius} Q0,${top} ${radius},${top} Z` };
}
