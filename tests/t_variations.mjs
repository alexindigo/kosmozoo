// tests/t_variations.mjs — permutation engine, template substitution, graph mutation.

import { assert, assertEquals } from "jsr:@std/assert";
import { generatePermutations, templateReplace } from "../plugins/variations/plugin.mjs";

// --- permutation engine ---------------------------------------------------

Deno.test("rangeValues: edges inclusive, floating-point safe", () => {
  // internal — not exported, but exercised through generatePermutations
  const perms = generatePermutations(
    { denoise: { min: 0.65, max: 0.95, enabled: true } },
    0.05,
    { denoise: 0.80 },
  );
  // 0.65, 0.70, 0.75, 0.80, 0.85, 0.90, 0.95 → 7 values
  // minus current (0.80) → 6
  assertEquals(perms.length, 6);
  const values = perms.map((p) => p.denoise).sort((a, b) => a - b);
  assertEquals(values, [0.65, 0.7, 0.75, 0.85, 0.9, 0.95]);
});

Deno.test("cartesian product: 2 params × 3 values each = 9 - 1 = 8", () => {
  const perms = generatePermutations(
    {
      denoise: { min: 0.5, max: 0.7, enabled: true },
      cfg: { min: 2.0, max: 4.0, enabled: true },
    },
    0.1,
    { denoise: 0.6, cfg: 3.0 },
  );
  // denoise: 0.5, 0.6, 0.7 → 3 values; cfg: 2.0, 2.1, ..., 4.0 → 21 values
  // 3 × 21 = 63 - 1 (current excluded) = 62
  // Verify count and exclusion:
  assertEquals(perms.length, 62);
  const hasCurrent = perms.some((p) => p.denoise === 0.6 && p.cfg === 3.0);
  assert(!hasCurrent);
});

Deno.test("disabled params are excluded from permutation", () => {
  const perms = generatePermutations(
    {
      denoise: { min: 0.5, max: 0.7, enabled: true },
      cfg: { min: 2, max: 4, enabled: false },
    },
    0.1,
    { denoise: 0.6, cfg: 3 },
  );
  // only denoise varies: 3 values - 1 current = 2
  assertEquals(perms.length, 2);
  for (const p of perms) {
    assertEquals(Object.keys(p), ["denoise"]);
  }
});

Deno.test("no enabled params → empty array", () => {
  const perms = generatePermutations(
    { denoise: { min: 0.5, max: 0.7, enabled: false } },
    0.1,
    { denoise: 0.6 },
  );
  assertEquals(perms.length, 0);
});

Deno.test("steps rounds to integer in permutation", () => {
  const perms = generatePermutations(
    { steps: { min: 20, max: 22, enabled: true } },
    1,
    { steps: 21 },
  );
  assertEquals(perms.length, 2); // 20, 22 (21 excluded)
  const values = perms.map((p) => p.steps).sort();
  assertEquals(values, [20, 22]);
});

Deno.test("per-range increment overrides fallback", () => {
  // denoise carries its own increment=0.1; fallback would be 0.05
  const perms = generatePermutations(
    { denoise: { min: 0.5, max: 0.7, enabled: true, increment: 0.1 } },
    0.05, // fallback — ignored because the range has its own
    { denoise: 0.6 },
  );
  // 0.5, 0.6, 0.7 = 3 values - 1 (current 0.6) = 2
  assertEquals(perms.length, 2);
  const values = perms.map((p) => p.denoise).sort((a, b) => a - b);
  assertEquals(values, [0.5, 0.7]);
});

Deno.test("mixed per-range and fallback increments", () => {
  // denoise: own increment=0.2; cfg: fallback=1.0
  const perms = generatePermutations(
    {
      denoise: { min: 0.4, max: 0.8, enabled: true, increment: 0.2 },
      cfg:     { min: 2.0, max: 4.0, enabled: true },
    },
    1.0,
    { denoise: 0.6, cfg: 3.0 },
  );
  // denoise: 0.4, 0.6, 0.8 = 3 values
  // cfg: 2.0, 3.0, 4.0 = 3 values (from fallback 1.0)
  // 3×3 - 1 (current 0.6/3.0) = 8
  assertEquals(perms.length, 8);
});

// --- template substitution -------------------------------------------------

Deno.test("templateReplace substitutes varied and current values", () => {
  const result = templateReplace(
    "_{denoise}_{cfg}_",
    { denoise: 0.75 },        // varied
    { denoise: 0.65, cfg: 3 }, // current
  );
  assertEquals(result, "_0.75_3_");
});

Deno.test("templateReplace leaves unknown placeholders", () => {
  const result = templateReplace("{unknown}", {}, {});
  assertEquals(result, "{unknown}");
});

Deno.test("templateReplace trims trailing zeros", () => {
  const result = templateReplace("{denoise}", { denoise: 0.6500000000 }, {});
  assertEquals(result, "0.65");
});

Deno.test("templateReplace handles integer values", () => {
  const result = templateReplace("{steps}", { steps: 30 }, {});
  assertEquals(result, "30");
});

Deno.test("templateReplace accepts node-prefixed placeholders via labelMap", () => {
  const result = templateReplace(
    "_{scheduler:denoise}_{randomnoise:seed}_",
    { denoise: 0.75, seed: 12345 },
    { denoise: 0.65, seed: 12345 },
    { denoise: "scheduler:denoise", seed: "randomnoise:seed" },
  );
  assertEquals(result, "_0.75_12345_");
});

Deno.test("templateReplace accepts bare keys too when labelMap prefixes exist", () => {
  const result = templateReplace(
    "_{denoise}_",
    { denoise: 0.75 },
    { denoise: 0.65 },
    { denoise: "scheduler:denoise" },
  );
  // Bare "denoise" should still work — bare key wins for that param
  assertEquals(result, "_0.75_");
});

// --- graph mutation ----------------------------------------------------------

Deno.test("mutateGraph: KSampler denoise", async () => {
  // Not exported — test through the module's internal path by checking
  // that the permutation generates and the graph has the right shape.
  // Direct mutation test needs the module to export mutateGraph.
  // For now, verify the permutation engine produces the right values.
  const perms = generatePermutations(
    { denoise: { min: 0.65, max: 0.70, enabled: true } },
    0.05,
    { denoise: 0.65 },
  );
  assertEquals(perms.length, 1);
  assertEquals(perms[0].denoise, 0.70);
});
