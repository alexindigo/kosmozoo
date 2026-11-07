import { resolvedRectangle } from "../diff/comparison-geometry.mjs";

export function faceEyes(face) {
  if (face.kps.length !== 28) return null;
  const centroid = start => [0, 1].map(axis => face.kps.slice(start, start + 6).reduce((sum, kp) => sum + kp[axis], 0) / 6);
  const left = centroid(11), right = centroid(17);
  const distance = Math.hypot(right[0] - left[0], right[1] - left[1]);
  return distance > 1e-6 && Number.isFinite(distance) ? {
    left, right, distance, midpoint: left.map((n, i) => (n + right[i]) / 2),
  } : null;
}

// Use B's ordinary rectangle as a read-only seed. Both allocations have the
// same comparison-frame origin; Two-Up differs only in its cell's screen origin.
export function registeredGeometry(a, b, eyesA, eyesB, camera = { s: 1, x: 0, y: 0 }) {
  if (!a || !b || !eyesA || !eyesB) return null;
  const midpoint = b.forward(eyesB.midpoint), qa = b.q * eyesB.distance / eyesA.distance;
  const baseA = { dx: midpoint[0] - qa * eyesA.midpoint[0], dy: midpoint[1] - qa * eyesA.midpoint[1], dw: qa * a.size.w, dh: qa * a.size.h };
  const apply = (mapping, rect) => {
    const { width, height } = mapping.geometry;
    return resolvedRectangle(mapping.size, mapping.geometry, {
      dx: width / 2 + (rect.dx - width / 2) * camera.s + camera.x * width,
      dy: height / 2 + (rect.dy - height / 2) * camera.s + camera.y * height,
      dw: rect.dw * camera.s, dh: rect.dh * camera.s,
    });
  };
  return { a: apply(a, baseA), b: apply(b, b.rect) };
}

export function faceAt(record, mapping, point) {
  if (!record || !mapping) return null;
  const [x, y] = mapping.inverse(point);
  return record.faces.find(face => face.selected && x >= face.bbox[0] && x <= face.bbox[2] && y >= face.bbox[1] && y <= face.bbox[3]) ?? null;
}
