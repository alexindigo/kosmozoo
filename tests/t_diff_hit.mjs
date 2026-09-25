// tests/t_diff_hit.mjs — the comparator's gesture hit-testing: the layer
// VISIBLE at the pointer is the target, in every mode.

import { assertEquals } from "jsr:@std/assert";
import { hitLayer } from "../client-solid/features/diff/hit.mjs";

const STAGE = { left: 0, width: 1400 };
const CELL_B = { left: 700, right: 1400 };

// --- Two-Up: the cell under the pointer ----------------------------------------

Deno.test("hit: two-up targets the cell under the pointer", () => {
  assertEquals(hitLayer({ mode: "two-up", col: "feed", x: 350, cellBRect: CELL_B, stageRect: STAGE }), "a");
  assertEquals(hitLayer({ mode: "two-up", col: "feed", x: 1050, cellBRect: CELL_B, stageRect: STAGE }), "b");
  // row-reverse (col=right): B's cell is the left one — the rect decides, not the side
  assertEquals(hitLayer({ mode: "two-up", col: "right", x: 350, cellBRect: { left: 0, right: 700 }, stageRect: STAGE }), "b");
});

// --- Split: left of the wipe is the bottom layer, right is the top --------------

Deno.test("hit: split with A on top — right of the wipe is A, left is B", () => {
  const args = { mode: "split", col: "feed", splitT: 0.5, cellBRect: null, stageRect: STAGE };
  assertEquals(hitLayer({ ...args, x: 1050 }), "a"); // right of the wipe: the top (active) layer
  assertEquals(hitLayer({ ...args, x: 350 }), "b");  // left of the wipe: the bottom (inactive) layer
});

Deno.test("hit: split with B on top — right of the wipe is B, left is A", () => {
  const args = { mode: "split", col: "right", splitT: 0.5, cellBRect: null, stageRect: STAGE };
  assertEquals(hitLayer({ ...args, x: 1050 }), "b");
  assertEquals(hitLayer({ ...args, x: 350 }), "a");
});

Deno.test("hit: split — the wipe position moves with splitT", () => {
  const args = { mode: "split", col: "feed", splitT: 0.8, cellBRect: null, stageRect: STAGE };
  assertEquals(hitLayer({ ...args, x: 1050 }), "b"); // wipe at 80% → x=1050 is LEFT of it (bottom layer)
  assertEquals(hitLayer({ ...args, x: 1300 }), "a"); // x=1300 is right of it (top layer)
});

// --- One-Up / Difference: the active column ------------------------------------

Deno.test("hit: one-up targets the visible (active) layer", () => {
  assertEquals(hitLayer({ mode: "one-up", col: "feed", x: 700, stageRect: STAGE }), "a");
  assertEquals(hitLayer({ mode: "one-up", col: "right", x: 700, stageRect: STAGE }), "b");
});

Deno.test("hit: difference targets the active column (merged canvas)", () => {
  assertEquals(hitLayer({ mode: "difference", col: "feed", x: 700, stageRect: STAGE }), "a");
  assertEquals(hitLayer({ mode: "difference", col: "right", x: 700, stageRect: STAGE }), "b");
});
