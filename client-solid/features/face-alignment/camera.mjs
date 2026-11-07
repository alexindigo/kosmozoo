import { comparisonGeometry } from "../diff/comparison-geometry.mjs";
import { registeredGeometry } from "./geometry.mjs";
import { faceContent } from "./identity.mjs";

// One camera lifetime per accepted reference content/session, independent of
// candidate replacement, face choice and allocation-derived geometry.
export function makeFaceCamera() {
  let referenceKey = null, referenceView = null, camera = { s: 1, x: 0, y: 0 };
  return {
    reset() { referenceKey = null; },
    resolve(ordinary, { session, reference, eyesA, eyesB }) {
      if (!ordinary.a || !ordinary.b || !reference || !eyesA || !eyesB) return ordinary;
      const key = JSON.stringify([session, faceContent(reference.resource, reference.image.hash)]);
      if (referenceKey !== key) {
        referenceKey = key; referenceView = { ...ordinary.b.view }; camera = { s: 1, x: 0, y: 0 };
      }
      const g = ordinary.b.geometry;
      const seed = comparisonGeometry(ordinary.b.size, g.width, g.height, referenceView);
      return registeredGeometry(ordinary.a, seed, eyesA, eyesB, camera) ?? ordinary;
    },
    gesture(mapping, ticket, changed) {
      const captured = ticket(), reference = referenceKey;
      const current = () => ticket() === captured && referenceKey === reference;
      return {
        pan(dx, dy) {
          if (!current()) return;
          camera = { ...camera, x: camera.x + dx / mapping.geometry.width, y: camera.y + dy / mapping.geometry.height }; changed();
        },
        zoom(x, y, factor) {
          if (!current()) return;
          const s = Math.max(.05, Math.min(12, camera.s * factor)), ratio = s / camera.s;
          const px = x / mapping.geometry.width - .5, py = y / mapping.geometry.height - .5;
          camera = { s, x: px + (camera.x - px) * ratio, y: py + (camera.y - py) * ratio }; changed();
        },
      };
    },
  };
}
