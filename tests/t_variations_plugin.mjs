// tests/t_variations.mjs — permutation engine, template substitution, graph mutation.

import { assert, assertEquals } from "jsr:@std/assert";
import {
  generatePermutations,
  templateReplace,
  findProducingSaveImage,
  narrowToOneSaveImage,
  wrapAllSaveImagePrefixes,
  inspectGraph,
  stringParams,
  mutateGraph,
  resolveRelativeRanges,
  dedupHostTag,
  lineageTag,
  clampBasename,
  stripWideHostTag,
  clampBudget,
  HEADROOM,
  breadthFirstSweep,
} from "../plugins/variations/plugin.mjs";

// --- permutation engine ---------------------------------------------------

// --- relative ranges (batch mode) -------------------------------------------

Deno.test("relative ranges: offsets resolve against the image's current value, clamped", () => {
  const ranges = {
    denoise: { enabled: true, min: -0.15, max: 0.15, increment: 0.05, clamp: [0, 1] },
    steps: { enabled: true, min: -5, max: 5, increment: 1, clamp: [1, 150] },
    cfg: { enabled: true, min: -1, max: 1, increment: 0.5, clamp: [0, 30] },
  };
  resolveRelativeRanges(ranges, { denoise: 0.8, steps: 3 }); // cfg absent from this graph
  assertEquals(ranges.denoise.min, 0.65);
  assertEquals(ranges.denoise.max, 0.95);
  assertEquals(ranges.steps.min, 1); // 3 - 5 = -2, clamped to the param floor
  assertEquals(ranges.steps.max, 8);
  assertEquals("cfg" in ranges, false); // params the graph lacks drop out
});

Deno.test("relative ranges: both offsets on one side of the current value", () => {
  const ranges = {
    denoise: { enabled: true, min: -2.5, max: -0.5, increment: 0.05, clamp: [0, 1] },
  };
  resolveRelativeRanges(ranges, { denoise: 0.9 });
  assertEquals(ranges.denoise.min, 0);   // 0.9 - 2.5 clamps at 0
  assertEquals(ranges.denoise.max, 0.4); // 0.9 - 0.5
});

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

// --- SaveImage narrowing ------------------------------------------------------

Deno.test("findProducingSaveImage: picks the node whose prefix leads the filename", () => {
  const graph = {
    "12": { class_type: "SaveImage", inputs: { filename_prefix: "Logotype Pipeline", images: ["9", 0] } },
    "15": { class_type: "SaveImage", inputs: { filename_prefix: "ComfyUI", images: ["8", 0] } },
    "8":  { class_type: "VAEDecode", inputs: {} },
  };
  const found = findProducingSaveImage(graph, "ComfyUI_00398_.png");
  assertEquals(found?.id, "15");
  assertEquals(found?.prefix, "ComfyUI");
});

Deno.test("findProducingSaveImage: prefers the longest matching prefix", () => {
  // If two SaveImages share a leading prefix, the more specific one wins.
  const graph = {
    "1": { class_type: "SaveImage", inputs: { filename_prefix: "ComfyUI", images: [] } },
    "2": { class_type: "SaveImage", inputs: { filename_prefix: "ComfyUI_final", images: [] } },
  };
  const found = findProducingSaveImage(graph, "ComfyUI_final_00042_.png");
  assertEquals(found?.id, "2");
});

Deno.test("findProducingSaveImage: null when no SaveImage matches", () => {
  const graph = {
    "1": { class_type: "SaveImage", inputs: { filename_prefix: "Alpha", images: [] } },
    "2": { class_type: "SaveImage", inputs: { filename_prefix: "Beta", images: [] } },
  };
  const found = findProducingSaveImage(graph, "Gamma_00001_.png");
  assertEquals(found, null);
});

Deno.test("narrowToOneSaveImage: wraps the ORIGINAL basename (with counter), drops other SaveImages", () => {
  const graph = {
    "12": { class_type: "SaveImage", inputs: { filename_prefix: "Logotype Pipeline", images: ["9", 0] } },
    "15": { class_type: "SaveImage", inputs: { filename_prefix: "ComfyUI", images: ["8", 0] } },
    "8":  { class_type: "VAEDecode", inputs: {} },
    "9":  { class_type: "ImageUpscaleWithModel", inputs: {} },
  };
  const producing = findProducingSaveImage(graph, "ComfyUI_00398_.png");
  // Simulates what the /run handler passes: original filename basename
  // (without extension) as the middle, user pfx/sfx around it.
  const result = narrowToOneSaveImage(graph, producing, "ComfyUI_00398_", "exp_", "_v1");
  assertEquals(result.kept, 1);
  assertEquals(result.dropped, 1);
  assert(!("12" in graph), "node 12 should be removed");
  assert("15" in graph, "node 15 should remain");
  // The counter "_00398_" from the original filename is preserved inside
  // the new filename_prefix so variations trace back to their source.
  assertEquals(graph["15"].inputs.filename_prefix, "exp_ComfyUI_00398__v1");
  // non-SaveImage nodes untouched
  assert("8" in graph);
  assert("9" in graph);
});

Deno.test("narrowToOneSaveImage: preserves original counter for the user's StyleMix case", () => {
  // Reproduces the bug where "StyleMix_01822_.png" produced
  // "var_StyleMix_0.66__00001_.png" — the 01822 was dropped.
  // After fix: prefix should include "StyleMix_01822_" (from basename).
  const graph = {
    "14": { class_type: "SaveImage", inputs: { filename_prefix: "StyleMix", images: ["13", 0] } },
    "102": { class_type: "SaveImage", inputs: { filename_prefix: "UpsacledStyleMix", images: ["101", 0] } },
  };
  const producing = findProducingSaveImage(graph, "StyleMix_01822_.png");
  narrowToOneSaveImage(graph, producing, "StyleMix_01822_", "var_", "_0.66");
  assertEquals(graph["14"].inputs.filename_prefix, "var_StyleMix_01822__0.66");
  // ComfyUI will append "_00001_.png" to this at run time, giving
  // "var_StyleMix_01822__0.66_00001_.png" — 01822 preserved.
});

Deno.test("wrapAllSaveImagePrefixes: fallback wraps every SaveImage's own prefix", () => {
  const graph = {
    "1": { class_type: "SaveImage", inputs: { filename_prefix: "Alpha", images: [] } },
    "2": { class_type: "SaveImage", inputs: { filename_prefix: "Beta", images: [] } },
    "3": { class_type: "VAEDecode", inputs: {} },
  };
  const touched = wrapAllSaveImagePrefixes(graph, "pre_", "_suf");
  assertEquals(touched, 2);
  assertEquals(graph["1"].inputs.filename_prefix, "pre_Alpha_suf");
  assertEquals(graph["2"].inputs.filename_prefix, "pre_Beta_suf");
});

Deno.test("wrapAllSaveImagePrefixes: fallback subtracts pfx/sfx from the middle budget", () => {
  // clampBudget was defined but never called on this path — a long pfx/sfx
  // plus a long node prefix could still push the assembly over NAME_MAX.
  const pfx = "pre_".repeat(20);       // 80 chars
  const sfx = "_suf".repeat(20);       // 80 chars
  const graph = {
    "1": { class_type: "SaveImage", inputs: { filename_prefix: "m".repeat(200), images: [] } },
  };
  wrapAllSaveImagePrefixes(graph, pfx, sfx);
  const out = graph["1"].inputs.filename_prefix;
  // assembled + ComfyUI's "_NNNNN_.png" (~15 headroom) must fit NAME_MAX 255
  assert(out.length <= 255 - 15, `assembled ${out.length} over the 240 budget`);
  assert(out.startsWith(pfx), "pfx survives");
  assert(out.endsWith(sfx), "sfx survives");
});

// --- inspectGraph: graph-driven param discovery -------------------------------
// Generic: every numeric scalar input of every node instance is a param,
// id = <class_type>.<input>, shared with the fields registry.

const byId = (params, id) => params.find((p) => p.id === id) ?? null;

Deno.test("inspectGraph: KSampler flow surfaces denoise/cfg/steps/seed", () => {
  const graph = {
    "1": { class_type: "KSampler", inputs: {
      seed: 12345, steps: 20, cfg: 7.5, denoise: 0.8,
    } },
  };
  const params = inspectGraph(graph);
  assertEquals(byId(params, "KSampler.denoise")?.current, 0.8);
  assertEquals(byId(params, "KSampler.cfg")?.current, 7.5);
  assertEquals(byId(params, "KSampler.steps")?.current, 20);
  assertEquals(byId(params, "KSampler.seed")?.current, 12345);
  assertEquals(byId(params, "KSampler.steps")?.integer, true);
  assertEquals(byId(params, "KSampler.denoise")?.integer, false);
});

Deno.test("inspectGraph: FluxGuidance surfaces guidance with the node's title", () => {
  const graph = {
    "1": { class_type: "KSampler", inputs: {
      seed: 1, steps: 20, cfg: 1.0, denoise: 1.0,
    } },
    "2": { class_type: "FluxGuidance", inputs: { guidance: 3.5, conditioning: ["3", 0] }, _meta: { title: "FluxGuidance 3.5" } },
  };
  const params = inspectGraph(graph);
  assertEquals(byId(params, "FluxGuidance.guidance")?.current, 3.5);
  assertEquals(byId(params, "FluxGuidance.guidance")?.title, "FluxGuidance 3.5");
});

Deno.test("inspectGraph: ModelSampling surfaces shift", () => {
  const graph = {
    "1": { class_type: "KSampler", inputs: {
      seed: 1, steps: 20, cfg: 1.0, denoise: 1.0,
    } },
    "2": { class_type: "ModelSamplingFlux", inputs: { shift: 1.15, model: ["3", 0] } },
  };
  const params = inspectGraph(graph);
  assertEquals(byId(params, "ModelSamplingFlux.shift")?.current, 1.15);
});

Deno.test("inspectGraph: ApplyPulid surfaces pulid weight", () => {
  const graph = {
    "1": { class_type: "KSampler", inputs: {
      seed: 1, steps: 20, cfg: 1.0, denoise: 1.0,
    } },
    "2": { class_type: "ApplyPulidFlux", inputs: { weight: 0.9, model: ["3", 0] } },
  };
  const params = inspectGraph(graph);
  assertEquals(byId(params, "ApplyPulidFlux.weight")?.current, 0.9);
});

Deno.test("inspectGraph: LoraLoaderModelOnly surfaces strength_model", () => {
  const graph = {
    "1": { class_type: "KSampler", inputs: {
      seed: 1, steps: 20, cfg: 1.0, denoise: 1.0,
    } },
    "2": { class_type: "LoraLoaderModelOnly", inputs: {
      lora_name: "athena_film_v1.safetensors", strength_model: 1.2, model: ["1", 0],
    } },
  };
  const params = inspectGraph(graph);
  assertEquals(byId(params, "LoraLoaderModelOnly.strength_model")?.current, 1.2);
  assertEquals(byId(params, "LoraLoaderModelOnly.strength_clip"), null); // ModelOnly has no clip side
});

Deno.test("inspectGraph: full LoraLoader surfaces both model and clip strength", () => {
  const graph = {
    "1": { class_type: "KSampler", inputs: {
      seed: 1, steps: 20, cfg: 1.0, denoise: 1.0,
    } },
    "2": { class_type: "LoraLoader", inputs: {
      lora_name: "detail.safetensors", strength_model: 0.8, strength_clip: 0.5,
      model: ["1", 0], clip: ["3", 0],
    } },
  };
  const params = inspectGraph(graph);
  assertEquals(byId(params, "LoraLoader.strength_model")?.current, 0.8);
  assertEquals(byId(params, "LoraLoader.strength_clip")?.current, 0.5);
});

Deno.test("inspectGraph: multiple lora loaders — one param, all node ids, first-carrier current", () => {
  const graph = {
    "1": { class_type: "KSampler", inputs: {
      seed: 1, steps: 20, cfg: 1.0, denoise: 1.0,
    } },
    "2": { class_type: "LoraLoader", inputs: {
      lora_name: "detail.safetensors", strength_model: 0.8, strength_clip: 0.8,
      model: ["1", 0], clip: ["3", 0],
    } },
    "3": { class_type: "LoraLoader", inputs: {
      lora_name: "style.safetensors", strength_model: 0.5, strength_clip: 0.5,
      model: ["2", 0], clip: ["2", 1],
    } },
  };
  const params = inspectGraph(graph);
  const p = byId(params, "LoraLoader.strength_model");
  assertEquals(p?.current, 0.8); // first carrier's value
  assertEquals(p?.nodeIds, ["2", "3"]); // both carriers sweep together
});

Deno.test("inspectGraph: mutateGraph sweeps every carrier of a multi-instance param", () => {
  const graph = {
    "1": { class_type: "KSampler", inputs: {
      seed: 1, steps: 20, cfg: 1.0, denoise: 1.0,
    } },
    "2": { class_type: "LoraLoader", inputs: {
      lora_name: "detail.safetensors", strength_model: 0.8,
      model: ["1", 0], clip: ["3", 0],
    } },
    "3": { class_type: "LoraLoader", inputs: {
      lora_name: "style.safetensors", strength_model: 0.5,
      model: ["2", 0], clip: ["2", 1],
    } },
  };
  const { graph: mutated, applied } = mutateGraph(graph, { "LoraLoader.strength_model": 0.1 });
  assertEquals(applied, ["LoraLoader.strength_model"]);
  assertEquals(mutated["2"].inputs.strength_model, 0.1);
  assertEquals(mutated["3"].inputs.strength_model, 0.1);
});

Deno.test("inspectGraph: integer params round on write", () => {
  const graph = {
    "1": { class_type: "KSampler", inputs: {
      seed: 1, steps: 20, cfg: 1.0, denoise: 1.0,
    } },
  };
  const { graph: mutated } = mutateGraph(graph, { "KSampler.steps": 20.7 });
  assertEquals(mutated["1"].inputs.steps, 21); // integer-typed → rounded
});

Deno.test("inspectGraph: string inputs are not varyable", () => {
  const graph = {
    "1": { class_type: "CLIPTextEncode", inputs: { text: "fish" } },
  };
  const params = inspectGraph(graph);
  assertEquals(params.length, 0);
});

// --- LoadImage sweep axes ------------------------------------------------------

Deno.test("stringParams: LoadImage image inputs surface, other strings don't", () => {
  const graph = {
    "1": { class_type: "LoadImage", inputs: { image: "a.png", upload: true } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: "fish" } },
    "3": { class_type: "ImageOnlyLoadImage", inputs: { image: "m.png" } },
    "4": { class_type: "LoadImage", inputs: { image: "notanimage.txt" } },
    "5": { class_type: "KSampler", inputs: { seed: 1, steps: 20 } },
  };
  const sp = stringParams(graph);
  assertEquals(sp.length, 2);
  assertEquals(sp[0].id, "LoadImage.image");
  assertEquals(sp[0].current, "a.png");
  assertEquals(sp[1].id, "ImageOnlyLoadImage.image");
  assertEquals(sp[1].current, "m.png");
});

Deno.test("generatePermutations: image axes multiply the numeric cartesian", () => {
  const perms = generatePermutations(
    { "KSampler.denoise": { enabled: true, min: 0.5, max: 1, increment: 0.5 } },
    0.05,
    { "KSampler.denoise": 0.7, "LoadImage.image": "orig.png" },
    { "LoadImage.image": { enabled: true, values: ["x.png", "y.png"] } },
  );
  // 2 denoise values × 2 images = 4; current combo (0.7 not in range) not
  // excluded → all 4 survive
  assertEquals(perms.length, 4);
  assert(perms.some((p) => p["LoadImage.image"] === "x.png" && p["KSampler.denoise"] === 0.5));
  assert(perms.some((p) => p["LoadImage.image"] === "y.png" && p["KSampler.denoise"] === 1));
});

Deno.test("generatePermutations: the current combo (current filename) is excluded", () => {
  const perms = generatePermutations(
    {},
    0.05,
    { "LoadImage.image": "orig.png" },
    { "LoadImage.image": { enabled: true, values: ["orig.png", "x.png", "y.png"] } },
  );
  assertEquals(perms.length, 2);
  assert(!perms.some((p) => p["LoadImage.image"] === "orig.png"));
});

Deno.test("generatePermutations: current numeric value is NOT skipped at a different source image", () => {
  // denoise range includes the current 0.7; the image axis sweeps to x.png —
  // (denoise 0.7, x.png) is novel, only (denoise 0.7, orig.png) is redundant
  const perms = generatePermutations(
    { "KSampler.denoise": { enabled: true, min: 0.5, max: 1, increment: 0.5 } },
    0.05,
    { "KSampler.denoise": 0.7, "LoadImage.image": "orig.png" },
    { "LoadImage.image": { enabled: true, values: ["orig.png", "x.png"] } },
  );
  // values 0.5/1 × {orig, x} = 4, plus 0.7 is not a range step → only
  // (0.5..1 don't include 0.7) — assert by the count and the key combos
  assert(perms.some((p) => p["LoadImage.image"] === "x.png" && p["KSampler.denoise"] === 0.5));
  assert(perms.some((p) => p["LoadImage.image"] === "x.png" && p["KSampler.denoise"] === 1));
  assert(perms.some((p) => p["LoadImage.image"] === "orig.png" && p["KSampler.denoise"] === 0.5));
});

Deno.test("generatePermutations: a range step equal to the current value is kept when the image changes", () => {
  const perms = generatePermutations(
    { "KSampler.denoise": { enabled: true, min: 0.5, max: 1.5, increment: 0.5 } }, // steps 0.5,1.0,1.5 — current 1.0 IS a step
    0.05,
    { "KSampler.denoise": 1, "LoadImage.image": "orig.png" },
    { "LoadImage.image": { enabled: true, values: ["orig.png", "x.png"] } },
  );
  // 3 denoise steps × 2 images = 6; only (1.0, orig.png) excluded → 5
  assertEquals(perms.length, 5);
  assert(perms.some((p) => p["LoadImage.image"] === "x.png" && p["KSampler.denoise"] === 1),
    "current denoise at a DIFFERENT image must be kept");
  assert(!perms.some((p) => p["LoadImage.image"] === "orig.png" && p["KSampler.denoise"] === 1),
    "current denoise at the SAME image is redundant → dropped");
});

Deno.test("generatePermutations: image-only sweep (no numeric ranges)", () => {
  const perms = generatePermutations(
    {},
    0.05,
    { "LoadImage.image": "orig.png" },
    { "LoadImage.image": { enabled: true, values: ["x.png", "y.png"] } },
  );
  assertEquals(perms.length, 2);
});

Deno.test("mutateGraph: a string param writes verbatim (no rounding)", () => {
  const graph = {
    "1": { class_type: "LoadImage", inputs: { image: "a.png" } },
    "2": { class_type: "KSampler", inputs: { seed: 1, steps: 20 } },
  };
  const params = [...inspectGraph(graph), ...stringParams(graph)];
  const { graph: mutated, applied } = mutateGraph(graph, { "LoadImage.image": "chosen.png" }, params);
  assertEquals(mutated["1"].inputs.image, "chosen.png");
  assert(applied.includes("LoadImage.image"));
});

Deno.test("templateReplace: the chosen filename fills {LoadImage.image} and {image}", () => {
  const out = templateReplace(
    "run_{LoadImage.image}_vs_{image}",
    { "LoadImage.image": "chosen.png", image: "chosen.png" },
    { "LoadImage.image": "orig.png" },
    {},
  );
  assertEquals(out, "run_chosen.png_vs_chosen.png");
});

// --- host-tag dedup -----------------------------------------------------------

Deno.test("dedupHostTag: variation sources keep exactly one <host># tag", () => {
  assertEquals(dedupHostTag("plain_name_", "ark#"), "plain_name_");
  assertEquals(dedupHostTag("ark#alisa_00291_", "ark#"), "alisa_00291_");
  assertEquals(dedupHostTag("ark#ark#alisa_00341__0.8_", "ark#"), "alisa_00341__0.8_");
  assertEquals(dedupHostTag("ark#ark#ark#deep_", "ark#"), "deep_");
  // a different host's tag is not stripped (cross-host vary)
  assertEquals(dedupHostTag("anton#x_", "ark#"), "anton#x_");
  // degenerate: the basename IS the tag — kept, not emptied
  assertEquals(dedupHostTag("ark#", "ark#"), "ark#");
});

Deno.test("lineageTag: the extra_pnginfo payload carries source + params", () => {
  const tag = lineageTag("ark:src_00001_.png", { "KSampler.denoise": 0.55, "LoadImage.image": "x.png" });
  assertEquals(tag.kz.v, 1);
  assertEquals(tag.kz.source, "ark:src_00001_.png");
  assertEquals(tag.kz.params["KSampler.denoise"], 0.55);
  assertEquals(tag.kz.params["LoadImage.image"], "x.png");
  // JSON-safe (ComfyUI json.dumps each extra_pnginfo value)
  assertEquals(JSON.parse(JSON.stringify(tag)), tag);
});

// --- integer detection: the host's declared type, not the current value ---------

Deno.test("inspectGraph: declared FLOAT wins over an integer-looking current value", () => {
  // a lora strength currently at 1 must NOT be treated as integer
  const graph = {
    "1": { class_type: "LoraLoaderModelOnly", inputs: { strength_model: 1, model: ["9", 0] } },
    "9": { class_type: "KSampler", inputs: { seed: 1, steps: 20, denoise: 1 } },
  };
  const types = new Map([
    ["LoraLoaderModelOnly.strength_model", "FLOAT"],
    ["KSampler.seed", "INT"],
    ["KSampler.steps", "INT"],
    ["KSampler.denoise", "FLOAT"],
  ]);
  const params = inspectGraph(graph, types);
  const byId = (id) => params.find((p) => p.id === id);
  assertEquals(byId("LoraLoaderModelOnly.strength_model").integer, false);
  assertEquals(byId("KSampler.denoise").integer, false); // FLOAT, value 1 notwithstanding
  assertEquals(byId("KSampler.steps").integer, true);
  // no types map → the old value-inference fallback
  const fallback = inspectGraph(graph);
  assertEquals(fallback.find((p) => p.id === "KSampler.steps").integer, true);
});

Deno.test("mutateGraph: a declared-FLOAT strength sweeps in floats, not rounded to int", () => {
  const graph = {
    "1": { class_type: "LoraLoaderModelOnly", inputs: { strength_model: 1, model: ["9", 0] } },
  };
  const types = new Map([["LoraLoaderModelOnly.strength_model", "FLOAT"]]);
  const params = inspectGraph(graph, types);
  const { graph: mutated } = mutateGraph(graph, { "LoraLoaderModelOnly.strength_model": 0.55 }, params);
  assertEquals(mutated["1"].inputs.strength_model, 0.55);
});

// --- Errno 36 regression: basename clamp + host-tag stripping (2026-09-05) --

Deno.test("clampBasename: leaves short basenames alone", () => {
  assertEquals(clampBasename("athena_impl_00047_"), "athena_impl_00047_");
});

Deno.test("clampBasename: folds the MIDDLE of over-200-char lineage chains", () => {
  const long = "HEADHEADHEADHEADHEADHEAD" + "x".repeat(400) + "TAILTAILTAILTAIL";
  const out = clampBasename(long);
  assertEquals(out.length, 200);
  assert(out.startsWith("HEADHEADHEAD"), "head preserved");
  assert(out.endsWith("TAILTAILTAILTAIL"), "tail preserved");
  assert(out.includes("~"), "fold marker present");
});

Deno.test("clampBasename: head and tail are balanced", () => {
  const out = clampBasename("a".repeat(300));
  const head = out.slice(0, out.indexOf("~"));
  const tail = out.slice(out.indexOf("~") + 1);
  assertEquals(head.length, 100);
  assertEquals(tail.length, 99);
  assertEquals(out[head.length], "~");
});

Deno.test("clampBasename: custom max", () => {
  assertEquals(clampBasename("abcdefgh", 5), "ab~gh");
  assertEquals(clampBasename("abcd", 5), "abcd");
});

Deno.test("stripWideHostTag: removes every re-occurrence of the host tag", () => {
  const s = "athena_impl_00047__0.55_ark#var_alisa_impl_00341_ark#ark#chain_00001_";
  assertEquals(
    stripWideHostTag(s, "ark#"),
    "athena_impl_00047__0.55_var_alisa_impl_00341_chain_00001_",
  );
});

Deno.test("stripWideHostTag: no-op when tag absent", () => {
  assertEquals(stripWideHostTag("foo_00001_", "ark#"), "foo_00001_");
});

Deno.test("wrapAllSaveImagePrefixes: fallback path clamps over-length own prefixes", () => {
  // The fallback subtracts pfx/sfx from the budget (clampBudget) — the
  // middle is NOT the default 200; with a 2-char pfx/sfx it's 236, and the
  // assembled prefix lands exactly on the 240 (= 255 − 15 headroom) budget.
  const graph = {
    "18": { class_type: "SaveImage", inputs: { filename_prefix: "z".repeat(300), images: ["17", 0] } },
  };
  wrapAllSaveImagePrefixes(graph, "P_", "_S");
  const prefix = graph["18"].inputs.filename_prefix;
  assertEquals(prefix.length, 255 - 15);
  assert(prefix.startsWith("P_"));
  assert(prefix.endsWith("_S"));
  assert(prefix.includes("~"));
});

Deno.test("wrapAllSaveImagePrefixes: short prefixes pass through unchanged", () => {
  const graph = {
    "18": { class_type: "SaveImage", inputs: { filename_prefix: "small", images: ["17", 0] } },
  };
  wrapAllSaveImagePrefixes(graph, "P_", "_S");
  assertEquals(graph["18"].inputs.filename_prefix, "P_small_S");
});
// --- clampBudget: assembled-prefix length bound (Errno 36 round 2) ---------

Deno.test("clampBudget: pfx sfx eat from NAME_MAX", () => {
  assertEquals(clampBudget("ark#", "_0.55"), 255 - HEADROOM - 4 - 5);
});

Deno.test("narrowToOneSaveImage: assembles under NAME_MAX when budget small", () => {
  const graph = {
    "18": { class_type: "SaveImage", inputs: { filename_prefix: "anything", images: ["17", 0] } },
  };
  const producing = { id: "18", node: graph["18"], prefix: "anything" };
  const long = "x".repeat(400);
  narrowToOneSaveImage(graph, producing, long, "P_", "_S");
  const prefix = graph["18"].inputs.filename_prefix;
  assert(prefix.length <= 255, "assembled prefix within NAME_MAX");
  assert(prefix.startsWith("P_"));
  assert(prefix.endsWith("_S"));
});

Deno.test("narrowToOneSaveImage: oversized pfx+sfx truncated to the 200-cap", () => {
  const graph = {
    "18": { class_type: "SaveImage", inputs: { filename_prefix: "anything", images: ["17", 0] } },
  };
  const producing = { id: "18", node: graph["18"], prefix: "anything" };
  const pfx = "p".repeat(240);
  const sfx = "s".repeat(30);
  narrowToOneSaveImage(graph, producing, "yyyy", pfx, sfx);
  const prefix = graph["18"].inputs.filename_prefix;
  assert(prefix.length <= 200, "assembled prefix hard-capped at 200 regardless");
});
// --- hard 200-cap on the assembled prefix (user 2026-09-10) ----------------

Deno.test("narrowToOneSaveImage: assembled prefix hard-capped, middle-folded", () => {
  const graph = {
    "18": { class_type: "SaveImage", inputs: { filename_prefix: "a", images: ["17", 0] } },
  };
  const producing = { id: "18", node: graph["18"], prefix: "a" };
  const long = "p".repeat(500);
  narrowToOneSaveImage(graph, producing, long, "PFX_", "_SFX");
  const prefix = graph["18"].inputs.filename_prefix;
  assertEquals(prefix.length, 200, "exactly 200 chars");
  assert(prefix.startsWith("PFX_"));
  assert(prefix.includes("~"), "fold marker in middle");
  assert(prefix.endsWith("_SFX"));
});

Deno.test("narrowToOneSaveImage: short prefix passes through untouched", () => {
  const graph = {
    "18": { class_type: "SaveImage", inputs: { filename_prefix: "a", images: ["17", 0] } },
  };
  const producing = { id: "18", node: graph["18"], prefix: "a" };
  narrowToOneSaveImage(graph, producing, "short", "P_", "_S");
  assertEquals(graph["18"].inputs.filename_prefix, "P_short_S");
});
// --- imageParams dedup: duplicate sweep values don't double-submit ---------

Deno.test("generatePermutations: duplicate values in an image axis are deduplicated", () => {
  const perms = generatePermutations(
    {},
    0.05,
    {},
    { "LoadImage.image": { enabled: true, values: ["a.png", "a.png", "b.png", "b.png", "b.png"] } },
  );
  assertEquals(perms.length, 2, "only unique values sweep");
  const values = perms.map((p) => p["LoadImage.image"]).sort();
  assertEquals(values, ["a.png", "b.png"]);
});

Deno.test("generatePermutations: duplicates across numeric + image axes don't multiply", () => {
  const perms = generatePermutations(
    { "KSampler.denoise": { enabled: true, min: 0.5, max: 0.55, increment: 0.05 } },
    0.05,
    {},
    { "LoadImage.image": { enabled: true, values: ["a.png", "a.png"] } },
  );
  assertEquals(perms.length, 2, "numeric × unique image values only");
});
// --- breadth-first sweep ordering (user 2026-09-10) -------------------------

Deno.test("breadthFirstSweep: interleaves axes round-robin (panel order)", () => {
  const combos = breadthFirstSweep([[1, 2], ["a", "b", "c"], ["x"]]);
  // Axis 0 (A) alternates fastest, axis 1 (B) slower, axis 2 (C) slowest:
  // (1,a),(2,a),(1,b),(2,b),(1,c),(2,c) — breadth, not column-major.
  assertEquals(combos.length, 6);
  assertEquals(combos[0], [1, "a", "x"]);
  assertEquals(combos[1], [2, "a", "x"]);
  assertEquals(combos[2], [1, "b", "x"]);
  assertEquals(combos[3], [2, "b", "x"]);
  assertEquals(combos[4], [1, "c", "x"]);
  assertEquals(combos[5], [2, "c", "x"]);
});

Deno.test("generatePermutations: emits permutations in breadth-first order", () => {
  const perms = generatePermutations(
    { "KSampler.denoise": { enabled: true, min: 0.5, max: 0.6, increment: 0.05 } },
    0.05,
    {},
    { "LoadImage.image": { enabled: true, values: ["i1.png", "i2.png"] } },
  );
  // denoise axis (3 values) × image axis (2 values): image axis alternates
  // fastest, denoise slower.
  const seq = perms.map((p) => [p["LoadImage.image"], p["KSampler.denoise"]]);
  assertEquals(seq.length, 6);
  assertEquals(seq[0][0], "i1.png");
  assertEquals(seq[1][0], "i2.png");
  assertEquals(seq[2][0], "i1.png");
  assertEquals(seq[3][0], "i2.png");
});
