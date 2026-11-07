// Framework-free service result boundary. Geometry stays in decoded pixels;
// validation never clamps, sorts, chooses or drops faces/landmarks.
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const finite = value => typeof value === "number" && Number.isFinite(value);
const tuple = (value, length) => Array.isArray(value) && value.length === length &&
  Array.from(value).every(finite);
const fail = reason => { throw new TypeError(`invalid detector result: ${reason}`); };

export function decodeDetectionResult(value) {
  if (!record(value)) fail("expected an object");
  if (Object.hasOwn(value, "error")) fail(String(value.reason ?? value.error));
  if (!finite(value.w) || value.w <= 0 || !finite(value.h) || value.h <= 0) fail("positive finite dimensions required");
  if (!Array.isArray(value.faces)) fail("faces array required");
  const faces = Array.from(value.faces, (face, i) => {
    if (!record(face) || !tuple(face.bbox, 4) ||
        face.bbox[2] <= face.bbox[0] || face.bbox[3] <= face.bbox[1]) fail(`face ${i} needs an ordered finite box`);
    if (face.score !== null && !finite(face.score)) fail(`face ${i} needs a nullable finite score`);
    if (!Array.isArray(face.kps) || !Array.from(face.kps).every(kp => tuple(kp, 3))) fail(`face ${i} needs finite landmark triples`);
    return { bbox: [...face.bbox], score: face.score, kps: face.kps.map(kp => [...kp]) };
  });
  if (Object.hasOwn(value, "id") && !Number.isSafeInteger(value.id)) fail("invalid request id");
  return { ...(Object.hasOwn(value, "id") ? { id: value.id } : {}), w: value.w, h: value.h, faces };
}
