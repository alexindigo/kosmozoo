import { zoomViewPixels } from "/js/zoom-view.mjs";

// The single media layout model. Allocations are inputs, never inferred from
// aspect-ratio CSS. Native dimensions remain absolute so small media never grow.
export const AUDIO_SIZE = Object.freeze({ w: 1024, h: 160, kind: "audio" });
export const FAILURE_SIZE = Object.freeze({ w: 1024, h: 1024 });
const positive = n => Number.isFinite(n) && n > 0;
export function mediaGeometry({ width, height, size, surface = "card" }) {
  const w = positive(width) ? width : 0;
  const known = positive(size?.w) && positive(size?.h);
  const natural = known ? size : { w: w || 16, h: (w || 16) * 9 / 16 };
  const viewer = surface === "viewer";
  const fit = Math.min(1, w / natural.w, viewer && positive(height) ? height / natural.h : 1);
  const mediaWidth = natural.w * fit, mediaHeight = natural.h * fit;
  const boxHeight = viewer ? Math.max(0, height || 0)
    : size?.kind === "audio" ? w * AUDIO_SIZE.h / AUDIO_SIZE.w
    : size?.failed ? w : Math.max(mediaHeight, w * 9 / 16);
  return { width: w, height: boxHeight, mediaWidth, mediaHeight,
    x: (w - mediaWidth) / 2, y: (boxHeight - mediaHeight) / 2 };
}

// Difference renders the same fitted rectangle and image-relative crop.
export function mediaViewRect(size, view, width, height) {
  const g = mediaGeometry({ width, height, size, surface: "viewer" });
  const p = zoomViewPixels(view, g) ?? { s: 1, tx: 0, ty: 0 };
  return { dx: width / 2 + p.tx - g.mediaWidth * p.s / 2,
    dy: height / 2 + p.ty - g.mediaHeight * p.s / 2,
    dw: g.mediaWidth * p.s, dh: g.mediaHeight * p.s };
}
