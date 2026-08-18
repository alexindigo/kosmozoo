// tests/t_plugin_detector.mjs — Phase 13 contract: the detector plugin
// proves the external-dependency shape — absent when unconfigured, eye
// anchors derived from 28 keypoints, never detection-dependent.

import { assert, assertEquals } from "jsr:@std/assert";
import { eyeAnchors } from "../plugins/detector/client.js";

// A synthetic 28-keypoint detection: eyes at known positions.
function detection28() {
  const kps = Array.from({ length: 28 }, () => [0, 0, 0]);
  // left eye group 11-16 centroid at (100, 100); right eye 17-22 at (200, 100)
  for (const i of [11, 12, 13, 14, 15, 16]) kps[i] = [100, 100, 0.9];
  for (const i of [17, 18, 19, 20, 21, 22]) kps[i] = [200, 100, 0.9];
  return { w: 400, h: 300, faces: [{ bbox: [50, 40, 200, 220], score: 0.95, kps }] };
}

Deno.test("detector: eyeAnchors derives midpoint + inter-eye distance (box-fractions)", () => {
  const a = eyeAnchors(detection28());
  assert(a, "anchors derived");
  // midpoint of (100,100) and (200,100) in a 400x300 image = (0.375, 1/3)
  assert(Math.abs(a.midpoint[0] - 0.375) < 1e-9);
  assert(Math.abs(a.midpoint[1] - 100 / 300) < 1e-9);
  // inter-eye distance 100 px in a 400-wide image = 0.25
  assert(Math.abs(a.interEyeDistance - 0.25) < 1e-9);
  assertEquals(a.box, [50, 40, 200, 220]);
});

Deno.test("detector: no face -> null (absent, not broken)", () => {
  assertEquals(eyeAnchors({ w: 1, h: 1, faces: [] }), null);
  assertEquals(eyeAnchors(null), null);
});

Deno.test("detector: low-confidence keypoints are excluded from the centroid", () => {
  const d = detection28();
  d.faces[0].kps[11] = [999, 999, 0.1]; // below the 0.3 score floor
  const a = eyeAnchors(d);
  assert(a, "still derivable from the remaining keypoints");
  assert(Math.abs(a.midpoint[0] - 0.375) < 0.01, "outlier did not skew the centroid");
});

Deno.test("detector: the plugin declares its config need and failure states", async () => {
  // register() must announce the face-anchored alignment with a declared
  // config need whose unmet reason names the setting.
  const caps = [];
  const kz = {
    settings: { get: (k, fb) => fb, set: async () => {}, ns: () => ({}) },
    alignment: (id, def) => caps.push({ kind: "alignment", id, ...def }),
    route: () => {},
  };
  const mod = await import("../plugins/detector/plugin.mjs");
  mod.register(kz);
  const align = caps.find((c) => c.id === "face-anchored");
  assert(align, "face-anchored alignment contributed");
  // unconfigured (no serviceUrl) -> the config need is unmet, with a reason
  const need = align.needs.find((n) => n.kind === "config");
  assertEquals(need.ok, false);
  assert(need.reason.includes("serviceUrl"));
  assertEquals(align.derives, ["eyeMidpoint", "interEyeDistance"]);
});
