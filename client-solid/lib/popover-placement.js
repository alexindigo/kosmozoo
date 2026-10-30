// One environment-pure placement calculation for viewport-bound popovers.
// Trigger and preferred content geometry are data supplied by their DOM owners.
export function popoverPlacement(trigger, viewport, size, margin = 4) {
  if (![trigger?.left, trigger?.top, trigger?.bottom, viewport?.width, viewport?.height,
    size?.width, size?.height, size?.minHeight ?? 0, margin].every(Number.isFinite) ||
    trigger.bottom < trigger.top || size.width <= 0 || size.height < 0 || margin < 0 ||
    viewport.width <= margin * 2 || viewport.height <= margin * 2) return null;
  const clamp = (value, low, high) => Math.max(low, Math.min(value, high));
  const start = clamp(trigger.top, margin, viewport.height - margin);
  const end = clamp(trigger.bottom, margin, viewport.height - margin);
  const above = Math.max(0, start - margin * 2);
  const below = Math.max(0, viewport.height - end - margin * 2);
  const side = below >= above ? "below" : "above";
  const maxHeight = side === "below" ? below : above;
  if (!maxHeight) return null;
  const minHeight = Math.min(Math.max(0, size.minHeight ?? 0), maxHeight);
  const height = Math.min(Math.max(size.height, minHeight), maxHeight);
  const width = Math.min(size.width, viewport.width - margin * 2);
  return Object.freeze({ side, width, height, minHeight, maxHeight,
    left: clamp(trigger.left, margin, viewport.width - margin - width),
    top: side === "below" ? end + margin : start - margin - height });
}
