// A crop is an image-space centre and a scale relative to fit. Allocation is
// only an input to rendering/gestures, never part of a persisted version2 crop.
export const IDENTITY_VIEW = Object.freeze({ version: 2, s: 1, cx: .5, cy: .5, fh: false, fv: false, rot: 0 });
const finite = (n, fallback = 0) => Number.isFinite(n) ? n : fallback;
export const readyViewGeometry = g => !!g && [g.width, g.height, g.mediaWidth, g.mediaHeight].every(n => Number.isFinite(n) && n > 0);

export function readZoomView(view, geometry) {
  if (!view) return { ...IDENTITY_VIEW };
  const s = Math.min(12, Math.max(1, finite(view.s, 1)));
  if (view.version === 2) return { ...IDENTITY_VIEW, s, cx: finite(view.cx, .5), cy: finite(view.cy, .5) };
  // The old format omitted its reference frame. Interpret it ONCE in the
  // first authoritative fit supplied to the view owner, never a zero box.
  if (!readyViewGeometry(geometry)) return null;
  return { ...IDENTITY_VIEW, s,
    cx: .5 - finite(view.txf) * geometry.width / (s * geometry.mediaWidth),
    cy: .5 - finite(view.tyf) * geometry.height / (s * geometry.mediaHeight) };
}

export function zoomViewPixels(view, geometry) {
  if (!readyViewGeometry(geometry)) return null;
  const v = readZoomView(view, geometry);
  // Pure legacy callers can render their original frame exactly, without a
  // subtract/divide/multiply round-trip. Owning ports still replace it once.
  if (view && view.version !== 2) return { s: v.s,
    tx: finite(view.txf) * geometry.width, ty: finite(view.tyf) * geometry.height };
  return { s: v.s, tx: (.5 - v.cx) * v.s * geometry.mediaWidth,
    ty: (.5 - v.cy) * v.s * geometry.mediaHeight };
}

export function zoomViewTransform(view, geometry) {
  const p = zoomViewPixels(view, geometry);
  return !p || (p.s === 1 && !p.tx && !p.ty) ? ""
    : `translate(${p.tx}px, ${p.ty}px) scale(${p.s})`;
}

export const isIdentityView = v => v.s === 1 && v.cx === .5 && v.cy === .5;
