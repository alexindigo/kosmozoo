import { assert, assertEquals } from "jsr:@std/assert";
import { popoverPlacement } from "../client-solid/lib/popover-placement.js";

const viewport = { width: 780, height: 441 };
const size = { width: 334, height: 231, minHeight: 150 };
Deno.test("popover placement: prefers the roomier side and preserves an intrinsic preferred size", () => {
  const below = popoverPlacement({ left: 62, top: 40, bottom: 70 }, viewport, size);
  assertEquals(below.side, "below"); assertEquals(below.left, 62); assertEquals(below.top, 74);
  assertEquals(below.height, 231); assertEquals(below.maxHeight, 363);
  const above = popoverPlacement({ left: 62, top: 330, bottom: 360 }, viewport, size);
  assertEquals(above.side, "above"); assertEquals(above.top + above.height, 326);
});
Deno.test("popover placement: actual scrolled-trigger coordinates give a visible tile-sized viewport", () => {
  const placed = popoverPlacement({ left: 62, top: 227.328125, bottom: 256.125 }, viewport, size);
  assertEquals(placed.side, "above"); assertEquals(placed.top, 4);
  assert(placed.height >= 150 && placed.height <= placed.maxHeight);
  assert(placed.top + placed.height < 227.328125);
});
Deno.test("popover placement: clamps inline size/position and never forces a minimum outside a short viewport", () => {
  const placed = popoverPlacement({ left: 700, top: 40, bottom: 70 }, { width: 240, height: 140 }, size);
  assertEquals(placed.width, 232); assertEquals(placed.left, 4);
  assert(placed.height < size.minHeight); assert(placed.top >= 4);
  assert(placed.top + placed.height <= 136);
});
Deno.test("popover placement: remains bounded for offscreen anchors and rejects unavailable geometry", () => {
  for (const rect of [{ left: -100, top: -200, bottom: -170 }, { left: 900, top: 700, bottom: 730 }]) {
    const placed = popoverPlacement(rect, viewport, size);
    assert(placed.left >= 4 && placed.left + placed.width <= viewport.width - 4);
    assert(placed.top >= 4 && placed.top + placed.height <= viewport.height - 4);
  }
  assertEquals(popoverPlacement({ left: 0, top: 0, bottom: 10 }, { width: 0, height: 0 }, size), null);
  assertEquals(popoverPlacement({ left: NaN, top: 0, bottom: 10 }, viewport, size), null);
  assertEquals(popoverPlacement({ left: 0, top: -10, bottom: 500 }, viewport, size), null);
});
