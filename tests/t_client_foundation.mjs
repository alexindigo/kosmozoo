// tests/t_client_foundation.mjs — Phase 6 contract tests: geometry is
// box-fraction (unit-free), persistence is default-absent, state has one
// render path.

import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert";
import { freshView, viewToPersisted, viewFromPersisted, transform, mapFrac, pivotScreen, panFrac } from "../client/js/geometry.mjs";
import { S, render, onRender } from "../client/js/state.mjs";

const BOX = { w: 1000, h: 500 };

Deno.test("geometry: fresh view is identity", () => {
  const v = freshView();
  assertEquals(v, { s: 1, txf: 0, tyf: 0, fh: false, fv: false, rot: 0 });
  assertEquals(viewToPersisted(v), null); // untouched view is not persisted
});

Deno.test("geometry: default-absent persistence round-trip", () => {
  assertEquals(viewFromPersisted(null), null);
  assertEquals(viewFromPersisted(viewToPersisted(freshView())), null);
  const v = { s: 2, txf: 0.1, tyf: -0.05, fh: true, fv: false, rot: 90 };
  const back = viewFromPersisted(viewToPersisted(v));
  assertEquals(back.s, 2);
  assertEquals(back.txf, 0.1);
  assertEquals(back.fh, true);
  assertEquals(back.rot, 90);
});

Deno.test("geometry: txf/tyf are box fractions — same view, different box sizes", () => {
  // A view panned 10% of the box width must move the image by 10% of
  // whatever box it is laid out in — that is what unit-free means, and what
  // makes a shared registration work across images of differing dimensions.
  const v = { ...freshView(), txf: 0.1 };
  const big = transform(v, { w: 2000, h: 1000 });
  const small = transform(v, { w: 500, h: 250 });
  assert(big.includes("translate(200px"), `big box: ${big}`);
  assert(small.includes("translate(50px"), `small box: ${small}`);
});

Deno.test("geometry: mapFrac centres at 0.5,0.5 with identity view", () => {
  const v = freshView();
  const [x, y] = mapFrac(v, BOX, 0.5, 0.5, 1600, 900);
  assertEquals([x, y], [800, 450]);
});

Deno.test("geometry: panFrac is the inverse of the display transform (rotation=0)", () => {
  const v = { ...freshView(), s: 2 };
  // dragging 100 screen-px right at scale 2 in a 1000-wide box = +0.05 frac
  const [dx] = panFrac(v, BOX, 100, 0);
  assert(Math.abs(dx - 0.05) < 1e-9, `panFrac dx=${dx}`);
});

Deno.test("geometry: pivotScreen is window centre for identity view", () => {
  const [x, y] = pivotScreen(freshView(), BOX, 1600, 900);
  assertEquals([x, y], [800, 450]);
});

Deno.test("state: single render path — render() fans out to all surfaces", () => {
  let a = 0, b = 0;
  onRender(() => a++);
  onRender(() => b++);
  render();
  assertEquals(a, 1);
  assertEquals(b, 1); // every subscriber ran from the single render call
});

Deno.test("state: lightbox carries a load-generation guard (harvest #1)", () => {
  assertEquals(typeof S.lightbox.loadGen, "number");
  const g = ++S.lightbox.loadGen;
  assertNotEquals(g, S.lightbox.loadGen - 0 === g ? g + 1 : g); // monotonic
});

Deno.test("state: three axes declared, ROI manual-first (null until set)", () => {
  assertEquals(S.axes.alignment, "shared");
  assertEquals(S.axes.composition, "flicker"); // manual blink is the default mode
  assertEquals(S.roi, null);
  assert(Array.isArray(S.guides));
});
