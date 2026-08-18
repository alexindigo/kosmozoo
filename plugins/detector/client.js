// plugins/detector/client.js — the detector plugin's client half: derives
// eye midpoint + inter-eye distance from the service's 28 keypoints and
// contributes the face-anchored alignment value. Absent cleanly when the
// plugin is unconfigured — detection-assisted, never detection-dependent.

// Eyes are keypoint groups 11–16 (left) and 17–22 (right) in the
// anime-face-detector 28-point model.
const LEFT_EYE = [11, 12, 13, 14, 15, 16];
const RIGHT_EYE = [17, 18, 19, 20, 21, 22];

function centroid(kps, idxs) {
  let x = 0, y = 0, n = 0;
  for (const i of idxs) {
    const kp = kps[i];
    if (kp && kp[2] > 0.3) { x += kp[0]; y += kp[1]; n++; }
  }
  return n ? [x / n, y / n] : null;
}

// The two numbers the alignment transform consumes.
export function eyeAnchors(detection) {
  const face = detection?.faces?.[0];
  if (!face) return null;
  const l = centroid(face.kps, LEFT_EYE);
  const r = centroid(face.kps, RIGHT_EYE);
  if (!l || !r) return null;
  const w = detection.w, h = detection.h;
  const midpoint = [(l[0] + r[0]) / 2 / w, (l[1] + r[1]) / 2 / h];
  const dist = Math.hypot(r[0] - l[0], r[1] - l[1]) / w;
  return { midpoint, interEyeDistance: dist, box: face.bbox };
}

export function register(client) {
  client.alignment?.("face-anchored", {
    label: "Face-anchored",
    async detect(imageBytesUrl) {
      const blob = await (await fetch(imageBytesUrl)).blob();
      const r = await fetch("/api/plugins/detector/detect", { method: "POST", body: blob });
      if (!r.ok) return null; // absent, not broken — never cache a null (#7)
      return eyeAnchors(await r.json());
    },
  });
}
