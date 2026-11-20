import { assertEquals } from "jsr:@std/assert";
import { planCohort, countingTarget } from "../src/features/variations/cohort-plan.mjs";
import { MAX_JOBS_PER_IMAGE } from "../src/features/variations/shared.mjs";
import { encodeHistoryRecipe } from "../src/features/variations/history-codec.mjs";
import { editorRig } from "./helpers/variation-editor.mjs";

function fixture() {
  const rig = editorRig();
  rig.editor.setEnabled("n.denoise", true);
  rig.editor.edit("numeric", "n.denoise", "mode", "value");
  rig.editor.edit("numeric", "n.denoise", "value", "0.9");
  // The raw recipe is public only through immutable Run capture.
  let recipe;
  const original = rig.services.history;
  rig.services.history = { capture(ticket) { recipe = ticket.snapshot; throw new Error("capture only"); }, finish() {} };
  return rig.editor.run().then(() => {
    rig.services.history = original; rig.editor.dispose();
    const target = { host: "fake", filename: "image.png", catalogue: rig.catalogue };
    return { recipe: structuredClone(recipe), target };
  });
}

Deno.test("cohort planner: each target owns its current tuple; mixed zero/valid counts", async () => {
  const { recipe, target } = await fixture();
  const zero = { ...target, catalogue: { ...target.catalogue, parameters: target.catalogue.parameters.map(p => p.id === "n.denoise" ? { ...p, current: .9, currentValue: .9 } : p) } };
  assertEquals(planCohort({ targets: [zero, target, target], cohortMode: "bulk", recipe }).map(p => [p.count, p.problem?.code ?? null]),
    [[0, "no-work"], [1, null], [1, null]]);
});

Deno.test("cohort planner: destination alone supplies exactly one job", async () => {
  const { recipe, target } = await fixture();
  recipe.numeric["n.denoise"].values.enabled = false;
  const [planned] = planCohort({ targets: [target], cohortMode: "single", recipe, destination: { source: "another" } });
  assertEquals([planned.index, planned.count, planned.problem], [0, 1, null]);
  assertEquals(planned.counts, { requested: 0, applicable: 0, distinct: 1, excluded: 0, admitted: 1 });
  assertEquals(planCohort({ targets: [target], cohortMode: "single", recipe })[0].problem.code, "no-work");
});

Deno.test("cohort planner: per-target cap and missing destination class/carrier", async () => {
  const { recipe, target } = await fixture();
  recipe.numeric["n.denoise"].values = { ...recipe.numeric["n.denoise"].values, mode: "range", min: "0", max: "1", rawIncrement: "0.0005" };
  recipe.numeric["n.denoise"].metadata.minIncrement = .0005;
  assertEquals(planCohort({ targets: [target], cohortMode: "single", recipe })[0].problem.code, "too-many");
  const missing = { ...target, catalogue: { ...target.catalogue, destination: { missing: ["ParameterlessNode"] } } };
  assertEquals(planCohort({ targets: [missing], cohortMode: "single", recipe })[0].problem.code, "missing-class");
  recipe.numeric["n.denoise"].values.mode = "value";
  assertEquals(planCohort({ targets: [{ ...target, catalogue: { ...target.catalogue, parameters: [] } }], cohortMode: "single", recipe })[0].problem.code, "parameter-missing");
});

Deno.test("cohort planner: absent relative numeric carriers are exclusions, discrete carriers are required", async () => {
  const { recipe, target } = await fixture();
  const absent = { ...target, catalogue: { ...target.catalogue, parameters: target.catalogue.parameters.filter(p => p.id !== "n.denoise") } };
  assertEquals(planCohort({ targets: [absent], cohortMode: "bulk", recipe })[0].problem.code, "no-work");
  recipe.enums["choice.value"].values.enabled = true;
  const noChoice = { ...target, catalogue: { ...target.catalogue, parameters: target.catalogue.parameters.filter(p => p.id !== "choice.value") } };
  assertEquals(planCohort({ targets: [noChoice], cohortMode: "bulk", recipe })[0].problem.code, "parameter-missing");
});

Deno.test("silent row 4: absent-relative producer retains exact notice and rejected count chain", async () => {
  const { recipe, target } = await fixture();
  recipe.numeric["n.denoise"].metadata.label = "Denoise";
  const absent = { ...target, catalogue: { ...target.catalogue, parameters: target.catalogue.parameters.filter(p => p.id !== "n.denoise") } };
  const [plan] = planCohort({ targets: [absent], cohortMode: "bulk", recipe });
  assertEquals(plan.notices[0].message, "image.png: Denoise is absent, so its relative sweep is not applied. 0 jobs use 0 of 1 selected parameters.");
  assertEquals(plan.notices[0].target, { index: 0, source: "fake", name: "image.png" });
  assertEquals(plan.counts, { requested: 1, applicable: 0, distinct: 1, excluded: 1, admitted: 0 });
});

Deno.test("silent rows 74,83,84: producer dedupe, shortening and name rejection preserve count evidence", async () => {
  const { recipe, target } = await fixture();
  recipe.enums["choice.value"].values.enabled = true;
  recipe.enums["choice.value"].values.picks = ["first", "second", "second"];
  target.catalogue.outputNaming = { directory: "", sourceStem: "x".repeat(240) };
  recipe.naming.root.values.prefix = "pre"; recipe.naming.root.values.suffix = "post";
  const [plan] = planCohort({ targets: [target], cohortMode: "single", recipe });
  assertEquals(plan.counts, { requested: 2, applicable: 2, distinct: 2, excluded: 0, admitted: 2 });
  assertEquals(plan.notices.find(p => p.code === "deduplicated").numbers, { selected: 3, distinct: 2, duplicates: 1 });
  assertEquals(plan.notices.find(p => p.code === "name-shortened").message,
    "image.png: source-name/token text was shortened from 240 to 187 UTF-8 bytes to fit the 200-byte output-name budget; Prefix/Suffix remain intact.");
  recipe.naming.root.values.prefix = "{missing}";
  const [invalid] = planCohort({ targets: [target], cohortMode: "single", recipe });
  assertEquals(invalid.problem.message, 'image.png, Prefix: Unresolved naming token "{missing}" (unknown parameter).');
  assertEquals(invalid.counts.admitted, 0); assertEquals(invalid.counts.distinct, 2);
  assertEquals(invalid.notices[0].code, "deduplicated");
});

Deno.test("cohort planner: unknown receipt names use byte identities and dedupe without graph assignments", async () => {
  const { recipe, target } = await fixture();
  recipe.images["image.image"].values.enabled = true;
  recipe.images["image.image"].values.items = [0, 1].map(() => ({ kind: "upload", name: "same.png", file: new File(["same bytes"], "same.png") }));
  const encoded = encodeHistoryRecipe(recipe, crypto.randomUUID());
  const resources = encoded.resources.map(resource => ({ ...resource, hash: "a".repeat(64) }));
  const counted = countingTarget(target, encoded.recipe, resources, { source: "other" }, 0);
  assertEquals([...counted.resourceIdentities.values()], [{ resource: "a".repeat(64) }, { resource: "a".repeat(64) }]);
  const [planned] = planCohort({ targets: [counted], cohortMode: "single", recipe: encoded.recipe, destination: { source: "other" } });
  assertEquals([planned.index, planned.count, planned.problem], [0, 1, null]);
  assertEquals(planned.notices[0].code, "deduplicated");
  assertEquals(planned.notices[0].numbers, { selected: 2, distinct: 1, duplicates: 1 });
});

Deno.test("cohort planner: shared kernel axis/traversal budget is admission, not a late dispatch failure", async () => {
  const { recipe, target } = await fixture();
  const base = recipe.numeric["n.denoise"], parameter = target.catalogue.parameters.find(p => p.id === "n.denoise");
  const parameters = Array.from({ length: 129 }, (_, index) => ({ ...parameter, id: `n.axis${index}`, key: `axis${index}` }));
  recipe.numeric = Object.fromEntries(parameters.map(p => [p.id, { ...structuredClone(base), metadata: { ...base.metadata, ...p } }]));
  const planned = planCohort({ targets: [{ ...target, catalogue: { ...target.catalogue, parameters } }], cohortMode: "single", recipe });
  assertEquals(planned[0].problem.code, "axis-budget");
});

Deno.test("cohort planner: a file reuses a prior selected local reference by byte identity", async () => {
  const { recipe, target } = await fixture();
  const runId = crypto.randomUUID();
  recipe.images["image.image"].values.enabled = true;
  recipe.images["image.image"].values.items = [
    { kind: "archive", runId, resourceId: "image-0", name: "next.png" },
    { kind: "archive", runId, resourceId: "image-1", name: "different-name.png" },
  ];
  const resources = [
    { id: "image-0", host: "fake", root: "input", name: "next.png", value: "next.png", hash: "b".repeat(64) },
    { id: "image-1", name: "different-name.png", hash: "b".repeat(64) },
  ];
  const counted = countingTarget(target, recipe, resources, { source: "fake" }, 0);
  assertEquals([...counted.resourceIdentities.values()], ["next.png", "next.png"]);
  const planned = planCohort({ targets: [counted], cohortMode: "single", recipe });
  assertEquals(planned[0].count, 1, JSON.stringify(planned));
});

Deno.test("cohort planner: adding images retains the exact count across the per-image limit", async () => {
  const { recipe, target } = await fixture();
  recipe.numeric["n.denoise"].values = { ...recipe.numeric["n.denoise"].values, mode: "range", min: "1", max: "17", rawIncrement: "1" };
  recipe.images["image.image"].values.enabled = true;
  for (const [images, count] of [[22, 374], [36, 612], [60, 1020]]) {
    recipe.images["image.image"].values.items = Array.from({ length: images }, (_, i) => ({ kind: "reference", value: `added-${i}.png` }));
    const encoded = encodeHistoryRecipe(recipe, crypto.randomUUID());
    const resources = encoded.resources.map(resource => ({ ...resource, host: "fake", root: "input" }));
    const counted = countingTarget(target, encoded.recipe, resources, { source: "fake" }, 0);
    const plan = planCohort({ targets: [counted], cohortMode: "single", recipe: encoded.recipe });
    assertEquals(plan[0].count, count, JSON.stringify(plan));
    assertEquals(plan[0].problem?.code ?? null, count > MAX_JOBS_PER_IMAGE ? "too-many" : null);
    if (count > MAX_JOBS_PER_IMAGE) assertEquals(plan[0].problem.message, `image.png: ${count} jobs for this image; the limit is ${MAX_JOBS_PER_IMAGE} per image. Reduce the axes or increase the increment.`);
  }
});

for (const kind of ["browser-file", "server-path", "pexels", "foreign-output", "input", "output", "target"]) {
  Deno.test(`cohort planner: ${kind} counts before upload, including over-limit work`, async () => {
    const { recipe, target } = await fixture();
    recipe.images["image.image"].values.enabled = true;
    const item = i => kind === "input" || kind === "output" ? { kind: "reference", value: `added-${i}.png [${kind}]` }
      : kind === "target" ? { kind: "target" }
      : kind === "server-path" ? { kind: "server-path", path: `/engine/added-${i}.png`, name: `added-${i}.png` }
      : { kind: "upload", file: new File([`${kind}-${i}`], `added-${i}.png`), name: `added-${i}.png` };
    for (const size of [2, MAX_JOBS_PER_IMAGE, MAX_JOBS_PER_IMAGE + 1]) {
      // The target-relative item is singular; multiply it with a numeric axis.
      recipe.images["image.image"].values.items = Array.from({ length: kind === "target" ? 1 : size }, (_, i) => item(i));
      if (kind === "target") recipe.numeric["n.denoise"].values = { ...recipe.numeric["n.denoise"].values, mode: "range", min: "2", max: String(size + 1), rawIncrement: "1" };
      const encoded = encodeHistoryRecipe(recipe, crypto.randomUUID());
      const resources = [...encoded.resources.map(resource => ({ ...resource,
        ...(["input", "output"].includes(kind) ? { host: "fake", root: kind } : {}), hash: resource.id.padStart(64, "0") })),
        { id: "target-0", host: "fake", root: "output", name: "image.png" }];
      const counted = countingTarget(target, encoded.recipe, resources, null, 0);
      const [plan] = planCohort({ targets: [counted], cohortMode: "single", recipe: encoded.recipe });
      assertEquals(plan.count, size, JSON.stringify(plan));
      assertEquals(plan.problem?.code ?? null, size > MAX_JOBS_PER_IMAGE ? "too-many" : null);
      if (plan.problem) assertEquals(typeof plan.problem.message === "string" && plan.problem.message.trim().length > 0, true);
    }
  });
}
