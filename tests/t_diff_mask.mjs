// tests/t_diff_mask.mjs — the Difference view's pixel math: identical
// pixels pass the base through; changed pixels highlight orange by the
// absolute/proportional rules.

import { assert, assertEquals } from "jsr:@std/assert";
import { differenceMask, HIGHLIGHT } from "../client-solid/features/diff/mask.mjs";

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
