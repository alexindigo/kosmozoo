import { mediaGeometry, mediaViewRect } from "../../store/media-geometry.js";

// One final decoded-pixel -> allocation mapping, shared by native rendering,
// canvas sampling, feedback and inverse gestures. Derived scales are not crops.
export function resolvedRectangle(size, geometry, rect) {
  const q = rect.dw / size.w;
  if (!(q > 0) || ![rect.dx, rect.dy, rect.dw, rect.dh].every(Number.isFinite)) return null;
  const scale = rect.dw / geometry.mediaWidth;
  const tx = rect.dx + rect.dw / 2 - geometry.width / 2;
  const ty = rect.dy + rect.dh / 2 - geometry.height / 2;
  return Object.freeze({ size, geometry, rect: Object.freeze({ ...rect }), q,
    transform: scale === 1 && tx === 0 && ty === 0 ? "" : `translate(${tx}px, ${ty}px) scale(${scale})`,
    forward: ([x, y]) => [rect.dx + x * q, rect.dy + y * q],
    inverse: ([x, y]) => [(x - rect.dx) / q, (y - rect.dy) / q],
  });
}

export function comparisonGeometry(size, width, height, view) {
  if (!size || !(width > 0 && height > 0)) return null;
  const geometry = mediaGeometry({ size, width, height, surface: "viewer" });
  return resolvedRectangle(size, geometry, mediaViewRect(size, view, width, height));
}
