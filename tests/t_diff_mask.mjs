// tests/t_diff_mask.mjs — the Difference view's pixel math: identical
// pixels pass the base through; changed pixels highlight orange by the
// absolute/proportional rules.

import { assert, assertEquals } from "jsr:@std/assert";
import { differenceMask, viewRect, HIGHLIGHT } from "../client-solid/features/diff/mask.mjs";

// --- viewRect: the crop-aware draw geometry ------------------------------------

Deno.test("viewRect: identity view is the contain-fit center-pad", () => {
  // 1024² into a 1400×900 stage: fit = 900/1024, centered
  const r = viewRect(1024, 1024, null, 1400, 900);
  const fw = 1024 * (900 / 1024);
  assertEquals(r.dw, fw);
  assertEquals(r.dh, fw);
  assertEquals(r.dx, (1400 - fw) / 2);
  assertEquals(r.dy, 0);
});

Deno.test("viewRect: a photo smaller than the stage is NEVER upscaled", () => {
  // the layout's rule (max-width/height + object-fit: contain): a 640×360
  // photo in a 1400×900 stage renders at natural size, centered — the mask
  // must draw it the same way or the buffers can never align
  const r = viewRect(640, 360, null, 1400, 900);
  assertEquals(r.dw, 640);
  assertEquals(r.dh, 360);
  assertEquals(r.dx, (1400 - 640) / 2);
  assertEquals(r.dy, (900 - 360) / 2);
});

Deno.test("viewRect: a translated view is NOT the native pad", () => {
  const id = viewRect(1024, 1024, null, 1400, 900);
  const moved = viewRect(1024, 1024, { s: 1, txf: 0.1, tyf: -0.05 }, 1400, 900);
  assert(moved.dx !== id.dx || moved.dy !== id.dy, "a crop moves the rect");
  assertEquals(moved.dx, id.dx + 0.1 * 1400);
  assertEquals(moved.dy, id.dy - 0.05 * 900);
});

Deno.test("viewRect: a zoomed view scales about the stage center", () => {
  const id = viewRect(1024, 1024, null, 1400, 900);
  const z = viewRect(1024, 1024, { s: 2, txf: 0, tyf: 0 }, 1400, 900);
  assertEquals(z.dw, id.dw * 2);
  assertEquals(z.dh, id.dh * 2);
  // center preserved: dx = stageW/2 - dw/2
  assertEquals(z.dx + z.dw / 2, 1400 / 2);
  assertEquals(z.dy + z.dh / 2, 900 / 2);
});

const px = (r, g, b) => [r, g, b, 255];
const img = (w, h, data) => new ImageData(new Uint8ClampedArray(data), w, h);

Deno.test("mask: identical pixels pass the base through (both base choices)", () => {
  const a = img(2, 1, [...px(10, 20, 30), ...px(40, 50, 60)]);
  const b = img(2, 1, [...px(10, 20, 30), ...px(40, 50, 60)]);
  const fromA = differenceMask(a, b, { absolute: true, opacity: 1, baseIsA: true });
  assertEquals([...fromA.data], [...a.data]);
  const fromB = differenceMask(a, b, { absolute: true, opacity: 1, baseIsA: false });
  assertEquals([...fromB.data], [...b.data]);
});

Deno.test("mask: a 1-channel delta is the full highlight when absolute", () => {
  const a = img(1, 1, px(100, 100, 100));
  const b = img(1, 1, px(100, 100, 110)); // blue delta = 10
  const m = differenceMask(a, b, { absolute: true, opacity: 1, baseIsA: true });
  assertEquals([...m.data], [...HIGHLIGHT, 255]);
});

Deno.test("mask: the same delta is a partial highlight when proportional", () => {
  const a = img(1, 1, px(100, 100, 100));
  const b = img(1, 1, px(100, 100, 110)); // delta = 10 → k = 10/255
  const m = differenceMask(a, b, { absolute: false, opacity: 1, baseIsA: true });
  const k = 10 / 255;
  assertEquals(Math.round(m.data[0]), Math.round(HIGHLIGHT[0] * k + 100 * (1 - k)));
  assertEquals(Math.round(m.data[1]), Math.round(HIGHLIGHT[1] * k + 100 * (1 - k)));
  assertEquals(Math.round(m.data[2]), Math.round(HIGHLIGHT[2] * k + 100 * (1 - k)));
  assert(m.data[0] > 100 && m.data[0] < HIGHLIGHT[0], "partial, not full");
});

Deno.test("mask: opacity scales the highlight mix", () => {
  const a = img(1, 1, px(0, 0, 0));
  const b = img(1, 1, px(200, 200, 200));
  const m = differenceMask(a, b, { absolute: true, opacity: 0.5, baseIsA: true });
  assertEquals(Math.round(m.data[0]), Math.round(HIGHLIGHT[0] * 0.5));
  assertEquals(Math.round(m.data[1]), Math.round(HIGHLIGHT[1] * 0.5));
});

Deno.test("mask: the base pixel stays under the highlight (the mask reads as a photo)", () => {
  const a = img(1, 1, px(200, 50, 90));
  const b = img(1, 1, px(10, 220, 130));
  const baseA = differenceMask(a, b, { absolute: true, opacity: 0.25, baseIsA: true });
  const baseB = differenceMask(a, b, { absolute: true, opacity: 0.25, baseIsA: false });
  // same highlight, different bases underneath → different mixes
  assert(baseA.data[0] !== baseB.data[0] || baseA.data[1] !== baseB.data[1]);
});

// --- baseOpacity: the active side's photo dims, the highlight still mixes over --

Deno.test("mask: baseOpacity dims identical regions by the base's share", () => {
  const a = img(1, 1, px(200, 100, 50));
  const b = img(1, 1, px(200, 100, 50));
  const full = differenceMask(a, b, { absolute: true, opacity: 1, baseIsA: true, baseOpacity: 0.5 });
  assertEquals([...full.data], [100, 50, 25, 255]);
});

Deno.test("mask: baseOpacity dims the base under the highlight too", () => {
  const a = img(1, 1, px(200, 200, 200));
  const b = img(1, 1, px(0, 0, 0));
  const m = differenceMask(a, b, { absolute: true, opacity: 0.5, baseIsA: true, baseOpacity: 0.5 });
  // highlight at k=0.5 over a half-dimmed base (200 × 0.5 = 100)
  assertEquals(Math.round(m.data[0]), Math.round(HIGHLIGHT[0] * 0.5 + 100 * 0.5));
  assertEquals(Math.round(m.data[1]), Math.round(HIGHLIGHT[1] * 0.5 + 100 * 0.5));
  assertEquals(Math.round(m.data[2]), Math.round(HIGHLIGHT[2] * 0.5 + 100 * 0.5));
});

// --- threshold: the noise floor shows the base, not the highlight -------------

Deno.test("mask: deltas at or below the threshold count as identical", () => {
  const a = img(3, 1, [...px(100, 100, 100), ...px(100, 100, 100), ...px(100, 100, 100)]);
  const b = img(3, 1, [...px(101, 100, 100), ...px(102, 100, 100), ...px(103, 100, 100)]);
  const m = differenceMask(a, b, { absolute: true, opacity: 1, baseIsA: true });
  // delta 1, 2 → base; delta 3 → highlight
  assertEquals([...m.data.slice(0, 4)], px(100, 100, 100));
  assertEquals([...m.data.slice(4, 8)], px(100, 100, 100));
  assertEquals([...m.data.slice(8, 12)], [...HIGHLIGHT, 255]);
});

Deno.test("mask: threshold 0 restores the strict any-delta rule", () => {
  const a = img(1, 1, px(100, 100, 100));
  const b = img(1, 1, px(101, 100, 100));
  const m = differenceMask(a, b, { absolute: true, opacity: 1, baseIsA: true, threshold: 0 });
  assertEquals([...m.data], [...HIGHLIGHT, 255]);
});
