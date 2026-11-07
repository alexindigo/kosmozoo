import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert";
import { comparisonGeometry } from "../client-solid/features/diff/comparison-geometry.mjs";
import { faceEyes, registeredGeometry, faceAt } from "../client-solid/features/face-alignment/geometry.mjs";
import { face } from "./helpers/face-fixtures.mjs";
import { makeFaceCamera } from "../client-solid/features/face-alignment/camera.mjs";
import { resource } from "./helpers/face-fixtures.mjs";

Deno.test("registration: below-fit candidate, resize and common camera share one inverse geometry", () => {
  const eyesA = faceEyes(face(300, 240, 240)), eyesB = faceEyes(face(100, 80, 30));
  for (const [width, height] of [[1400, 800], [700, 800], [333, 200]]) {
    const a = comparisonGeometry({ w: 512, h: 512 }, width, height, null);
    const b = comparisonGeometry({ w: 512, h: 512 }, width, height, { version: 2, s: 2, cx: .35, cy: .6 });
    for (const camera of [{ s: 1, x: 0, y: 0 }, { s: 1.3, x: .17, y: -.08 }]) {
      const registered = registeredGeometry(a, b, eyesA, eyesB, camera);
      for (const name of ["left", "right", "midpoint"]) {
        const pa = registered.a.forward(eyesA[name]), pb = registered.b.forward(eyesB[name]);
        pa.forEach((v, i) => assertAlmostEquals(v, pb[i]));
        registered.a.inverse(pa).forEach((v, i) => assertAlmostEquals(v, eyesA[name][i]));
      }
      assert(registered.a.rect.dw < a.rect.dw, "candidate is allowed below fit");
      const record = { faces: [{ ...face(300, 240, 240), selected: true, id: "chosen" }] };
      assertEquals(faceAt(record, registered.a, registered.a.forward([300, 240])).id, "chosen");
      assertEquals(b.rect, comparisonGeometry(b.size, width, height, { version: 2, s: 2, cx: .35, cy: .6 }).rect, "read-only reference");
    }
  }
});

Deno.test("camera: accepted reference content owns the seed, not candidate or anchor changes", () => {
  const owner = makeFaceCamera(), eyes = faceEyes(face()), size = { w: 512, h: 512 };
  const ordinary = view => ({ a: { ...comparisonGeometry(size, 1000, 800, null), view: null },
    b: { ...comparisonGeometry(size, 1000, 800, view), view } });
  const b = hash => ({ resource: resource("b.png"), image: { hash } });
  const first = { session: 1, reference: b("a".repeat(64)), eyesA: eyes, eyesB: eyes };
  let current = owner.resolve(ordinary(null), first), ticket = "same-frame";
  owner.gesture(current.a, () => ticket, () => {}).pan(40, 20);
  current = owner.resolve(ordinary({ version: 2, s: 3, cx: .2, cy: .3 }), first);
  assertAlmostEquals(current.b.rect.dx, (1000-512)/2+40);
  const retained = { ...current.b.rect };
  const differentAnchor = faceEyes(face(200, 180, 30));
  current = owner.resolve(ordinary(null), { ...first, eyesA: differentAnchor, eyesB: differentAnchor });
  assertEquals(current.b.rect, retained, "landmark/candidate changes do not reset camera or seed");
  const crop = { version: 2, s: 2.5, cx: .3, cy: .6 };
  const raw = ordinary(crop), replacement = { ...first, reference: b("b".repeat(64)) };
  current = owner.resolve(raw, replacement);
  assertEquals(current.b.rect, raw.b.rect, "new accepted B starts from B's own ordinary view, without the old common camera");
  assertEquals(raw.b.view, crop, "derivation never writes its seed");
});

Deno.test("camera: stale mode/allocation tickets cannot use captured widths; fresh gestures still work", () => {
  const owner = makeFaceCamera(), eyes = faceEyes(face()), size = { w: 512, h: 512 };
  const context = { session: 1, reference: { resource: resource("b.png"), image: { hash: "a".repeat(64) } }, eyesA: eyes, eyesB: eyes };
  const scene = width => ({ a: { ...comparisonGeometry(size, width, 800, null), view: null }, b: { ...comparisonGeometry(size, width, 800, null), view: null } });
  let frame = "one-up:1000x800";
  const before = owner.resolve(scene(1000), context);
  const old = owner.gesture(before.a, () => frame, () => {});
  frame = "two-up:500x800";
  const resized = owner.resolve(scene(500), context);
  old.pan(40, 20); old.zoom(100, 100, 2);
  assertEquals(owner.resolve(scene(500), context).b.rect, resized.b.rect, "retired gesture produces no stale jump");
  owner.gesture(resized.a, () => frame, () => {}).pan(40, 20);
  const moved = owner.resolve(scene(500), context);
  assertAlmostEquals(moved.b.rect.dx-resized.b.rect.dx, 40);
  assertAlmostEquals(moved.b.rect.dy-resized.b.rect.dy, 20);
});
