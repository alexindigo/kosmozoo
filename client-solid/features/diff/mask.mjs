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
// out: contain-fitted and centered in the stage, then the side's own view
// applied ({s, txf, tyf} — scale about the stage center, then translate by
// the view fractions of the stage box). Pure: the canvas draw uses this.
export function viewRect(imgW, imgH, view, stageW, stageH) {
  const fit = Math.min(stageW / imgW, stageH / imgH);
  const fw = imgW * fit, fh = imgH * fit;
  const v = view ?? { s: 1, txf: 0, tyf: 0 };
  const cx = stageW / 2 + v.txf * stageW;
  const cy = stageH / 2 + v.tyf * stageH;
  return { dx: cx - (fw * v.s) / 2, dy: cy - (fh * v.s) / 2, dw: fw * v.s, dh: fh * v.s };
}

export function differenceMask(a, b, { absolute = true, opacity = 1, baseIsA = true } = {}) {
  const base = baseIsA ? a : b;
  const out = new ImageData(a.width, a.height);
  const bd = base.data, ad = a.data, dd = b.data, od = out.data;
  for (let i = 0; i < bd.length; i += 4) {
    const dr = Math.abs(ad[i] - dd[i]);
    const dg = Math.abs(ad[i + 1] - dd[i + 1]);
    const db = Math.abs(ad[i + 2] - dd[i + 2]);
    const delta = Math.max(dr, dg, db);
    if (delta === 0) {
      od[i] = bd[i]; od[i + 1] = bd[i + 1]; od[i + 2] = bd[i + 2]; od[i + 3] = 255;
    } else {
      const k = absolute ? opacity : (delta / 255) * opacity;
      od[i] = HIGHLIGHT[0] * k + bd[i] * (1 - k);
      od[i + 1] = HIGHLIGHT[1] * k + bd[i + 1] * (1 - k);
      od[i + 2] = HIGHLIGHT[2] * k + bd[i + 2] * (1 - k);
      od[i + 3] = 255;
    }
  }
  return out;
}
