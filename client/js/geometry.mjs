// client/js/geometry.mjs — unit-free box-fraction view state.
//
// The one thing worth carrying from the outgoing design because it was
// right: view state is { s, txf, tyf, fh, fv, rot } in *box fractions* —
// px conversion exists in exactly one place (here). This is what makes
// shared registration and box-fraction ROIs work across images of differing
// dimensions.

export function freshView() {
  return { s: 1, txf: 0, tyf: 0, fh: false, fv: false, rot: 0 };
}

// Default-absent persistence: an untouched view is null, not a default obj.
export function viewToPersisted(v) {
  if (v.s <= 1 && !v.txf && !v.tyf && !v.fh && !v.fv && !v.rot) return null;
  return { s: v.s, txf: v.txf || 0, tyf: v.tyf || 0, fh: !!v.fh, fv: !!v.fv, rot: v.rot || 0 };
}

export function viewFromPersisted(z) {
  if (!z) return null;
  if (z.s <= 1 && !z.txf && !z.tyf && !z.fh && !z.fv && !z.rot) return null;
  return { s: z.s, txf: z.txf || 0, tyf: z.tyf || 0, fh: !!z.fh, fv: !!z.fv, rot: z.rot || 0 };
}

// view transform for an image laid out at the given box {w, h}
export function transform(v, box) {
  const sx = v.fh ? -1 : 1, sy = v.fv ? -1 : 1;
  return `translate(-50%,-50%) rotate(${v.rot}deg) ` +
    `scale(${v.s * sx}, ${v.s * sy}) ` +
    `translate(${v.txf * box.w}px, ${v.tyf * box.h}px)`;
}

// image fraction -> screen px under view+box (evaluated at rotation=0;
// overlays take the rotation themselves). winW/winH passed in for testability.
export function mapFrac(v, box, fx, fy, winW, winH) {
  const sx = v.fh ? -1 : 1, sy = v.fv ? -1 : 1;
  return [
    winW / 2 + v.s * sx * ((fx - 0.5 + v.txf) * box.w),
    winH / 2 + v.s * sy * ((fy - 0.5 + v.tyf) * box.h),
  ];
}

// image center on screen = rotation pivot (V + R·S·t)
export function pivotScreen(v, box, winW, winH) {
  const sx = v.fh ? -1 : 1, sy = v.fv ? -1 : 1;
  const rad = v.rot * Math.PI / 180;
  const tx = v.s * sx * v.txf * box.w, ty = v.s * sy * v.tyf * box.h;
  return [
    winW / 2 + Math.cos(rad) * tx - Math.sin(rad) * ty,
    winH / 2 + Math.sin(rad) * tx + Math.cos(rad) * ty,
  ];
}

// screen-px drag delta -> view fraction delta (inverse of the display
// transform), so pans stay pointer-true under rotation/flips
export function panFrac(v, box, dx, dy) {
  const rad = -v.rot * Math.PI / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  const rx = dx * c - dy * s, ry = dx * s + dy * c;
  const sx = v.fh ? -1 : 1, sy = v.fv ? -1 : 1;
  return [rx / (v.s * sx * box.w), ry / (v.s * sy * box.h)];
}
