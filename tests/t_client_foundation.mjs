// tests/t_client_foundation.mjs — Phase 6 contract tests: geometry is
// box-fraction (unit-free), persistence is default-absent, state has one
// render path.

import { assert, assertEquals } from "jsr:@std/assert";
import { freshView, viewToPersisted, viewFromPersisted, transform, mapFrac, pivotScreen, panFrac } from "../client/js/geometry.mjs";
import { state } from "../client/js/state.mjs";
import { render, subscribe } from "../client/app/services/notify.mjs";

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

Deno.test("state: single render path — render() fans out to all subscribers", () => {
  let a = 0, b = 0;
  const unsubA = subscribe(() => a++);
  const unsubB = subscribe(() => b++);
  render();
  assertEquals(a, 1);
  assertEquals(b, 1); // every subscriber ran from the single render call
  unsubA();
  unsubB();
  render();
  assertEquals(a, 1); // unsubscribed listeners stay quiet
});

Deno.test("state: workbench closed by default, current-image pointer null", () => {
  assertEquals(state.diff.open, false);
  assertEquals(state.current, null);
});

Deno.test("state: ROI manual-first (null until set), guides a list", () => {
  assertEquals(state.roi, null);
  assert(Array.isArray(state.guides));
});

// --- diff URL grammar ------------------------------------------------------

import { parseDiffHash, diffUrl } from "../client/js/route.mjs";

Deno.test("diff: parseDiffHash round-trips host-vs-host sides", () => {
  const { left, right } = parseDiffHash("fake#flux-basic.png:another#flux-lora.png");
  assertEquals(left, { source: "fake", file: "flux-basic.png" });
  assertEquals(right, { source: "another", file: "flux-lora.png" });
});

Deno.test("diff: anchor source and hostile filenames round-trip", () => {
  const weird = "a b#c:d.png";
  const hash = diffUrl({ source: "fake", file: weird }, { source: "anchor", file: "ref one.png" }).slice("/diff#".length);
  const { left, right } = parseDiffHash(hash);
  assertEquals(left, { source: "fake", file: weird });
  assertEquals(right, { source: "anchor", file: "ref one.png" });
});

Deno.test("diff: malformed sides parse to null, not garbage", () => {
  assertEquals(parseDiffHash("nosource").left, null);
  assertEquals(parseDiffHash("fake#:anchor#x.png").left, null);
  assertEquals(parseDiffHash("").right, null);
});
