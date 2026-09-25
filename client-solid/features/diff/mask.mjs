// client-solid/features/diff/mask.mjs — the Difference view's pixel math,
// pure. Two equal-size ImageData (already center-aligned onto equal
// canvases) → one mask ImageData: identical pixels show the BASE photo,
// changed pixels light up in the app's --attention orange. absolute: any
// nonzero max-channel delta → the highlight at full `opacity`. proportional:
// highlight strength = (max-channel-delta / 255) × opacity. The highlight
// mixes OVER the base pixel (the mask always reads as a photo, never a
// flat color field).

export const HIGHLIGHT = [255, 136, 0];

// The destination rect of one photo drawn the way the on-screen img is laid
// out. THE FIT RULE IS SHARED WITH THE LAYOUT (.dz-img): contain-fitted and
// centered, NEVER UPSCALED (fit caps at 1 — a small photo renders at
// natural size, with the stage showing margins around it). Then the side's
// own view ({s, txf, tyf} — scale about the stage center, then translate by
// the view fractions of the stage box). Pure: the canvas draw uses this.
export function viewRect(imgW, imgH, view, stageW, stageH) {
  const fit = Math.min(1, stageW / imgW, stageH / imgH);
  const fw = imgW * fit, fh = imgH * fit;
  const v = view ?? { s: 1, txf: 0, tyf: 0 };
  const cx = stageW / 2 + v.txf * stageW;
  const cy = stageH / 2 + v.tyf * stageH;
  return { dx: cx - (fw * v.s) / 2, dy: cy - (fh * v.s) / 2, dw: fw * v.s, dh: fh * v.s };
}

// Real photos carry a noise floor (JPEG recompression, AI re-synthesis):
// the absolute rule lights up most of any real pair. The threshold is the
// floor below which pixels count as MATCHING (measured on real variation
// siblings, the noise band sits at ≤8) — user-tunable in the mask controls.
// Proportional ramps FROM the threshold: the highlight fades in above it
// instead of from zero, so repaint noise shows nothing and genuine
// changes light up.
const DEFAULT_THRESHOLD = 8;

export function differenceMask(a, b, { absolute = true, opacity = 1, baseIsA = true, baseOpacity = 1, threshold = DEFAULT_THRESHOLD } = {}) {
  const base = baseIsA ? a : b;
  const out = new ImageData(a.width, a.height);
  const bd = base.data, ad = a.data, dd = b.data, od = out.data;
  for (let i = 0; i < bd.length; i += 4) {
    // the active side IS the base photo; its opacity scales every
    // contribution the base makes (identical regions AND under the highlight)
    const br = bd[i] * baseOpacity, bg = bd[i + 1] * baseOpacity, bb = bd[i + 2] * baseOpacity;
    const dr = Math.abs(ad[i] - dd[i]);
    const dg = Math.abs(ad[i + 1] - dd[i + 1]);
    const db = Math.abs(ad[i + 2] - dd[i + 2]);
    const delta = Math.max(dr, dg, db);
    if (delta <= threshold) {
      od[i] = br; od[i + 1] = bg; od[i + 2] = bb; od[i + 3] = 255;
    } else {
      const k = absolute
        ? opacity
        : Math.max(0, (delta - threshold) / (255 - threshold)) * opacity;
      od[i] = HIGHLIGHT[0] * k + br * (1 - k);
      od[i + 1] = HIGHLIGHT[1] * k + bg * (1 - k);
      od[i + 2] = HIGHLIGHT[2] * k + bb * (1 - k);
      od[i + 3] = 255;
    }
  }
  return out;
}
