// tests/t_diff_hit.mjs — the comparator's gesture hit-testing: the layer
// VISIBLE at the pointer is the target, in every mode.

import { assertEquals } from "jsr:@std/assert";
import { hitLayer } from "../client-solid/features/diff/hit.mjs";

const STAGE = { left: 0, width: 1400 };

// --- Two-Up: the cell under the pointer ----------------------------------------

Deno.test("hit: two-up targets the cell under the pointer", () => {
  assertEquals(hitLayer({ mode: "two-up", col: "feed", x: 350, stageRect: STAGE }), "a");
  assertEquals(hitLayer({ mode: "two-up", col: "feed", x: 1050, stageRect: STAGE }), "b");
  assertEquals(hitLayer({ mode: "two-up", col: "right", x: 350, stageRect: STAGE }), "a");
});

// --- Split: fixed placement, independent of the active subject ----------------

Deno.test("hit: split with A active — left is A, right is B", () => {
  const args = { mode: "split", col: "feed", splitT: 0.5, stageRect: STAGE };
  assertEquals(hitLayer({ ...args, x: 1050 }), "b");
  assertEquals(hitLayer({ ...args, x: 350 }), "a");
});

Deno.test("hit: split with B active — right is B, left is A", () => {
  const args = { mode: "split", col: "right", splitT: 0.5, stageRect: STAGE };
  assertEquals(hitLayer({ ...args, x: 1050 }), "b");
  assertEquals(hitLayer({ ...args, x: 350 }), "a");
});

Deno.test("hit: split — the wipe position moves with splitT", () => {
  const args = { mode: "split", col: "feed", splitT: 0.8, stageRect: STAGE };
  assertEquals(hitLayer({ ...args, x: 1050 }), "a"); // wipe at 80% → x=1050 is LEFT of it
  assertEquals(hitLayer({ ...args, x: 1300 }), "b");
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
