import { assertEquals } from "jsr:@std/assert";
import { planCohort, countingTarget } from "../src/features/variations/cohort-plan.mjs";
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
  assertEquals(planCohort({ targets: [target], cohortMode: "single", recipe, destination: { source: "another" } }), [{ index: 0, count: 1, problem: null }]);
  assertEquals(planCohort({ targets: [target], cohortMode: "single", recipe })[0].problem.code, "no-work");
});

Deno.test("cohort planner: per-target cap and missing destination class/carrier", async () => {
  const { recipe, target } = await fixture();
  recipe.numeric["n.denoise"].values = { ...recipe.numeric["n.denoise"].values, mode: "range", min: "0", max: "1", rawIncrement: "0.001" };
  recipe.numeric["n.denoise"].metadata.minIncrement = .001;
  assertEquals(planCohort({ targets: [target], cohortMode: "single", recipe })[0].problem.code, "too-many");
  const missing = { ...target, catalogue: { ...target.catalogue, destination: { missing: ["ParameterlessNode"] } } };
  assertEquals(planCohort({ targets: [missing], cohortMode: "single", recipe })[0].problem.code, "missing-class");
  recipe.numeric["n.denoise"].values.mode = "value";
  assertEquals(planCohort({ targets: [{ ...target, catalogue: { ...target.catalogue, parameters: [] } }], cohortMode: "single", recipe })[0].problem.code, "invalid-plan");
});

Deno.test("cohort planner: absent relative numeric carriers are exclusions, discrete carriers are required", async () => {
  const { recipe, target } = await fixture();
  const absent = { ...target, catalogue: { ...target.catalogue, parameters: target.catalogue.parameters.filter(p => p.id !== "n.denoise") } };
  assertEquals(planCohort({ targets: [absent], cohortMode: "bulk", recipe })[0].problem.code, "no-work");
  recipe.enums["choice.value"].values.enabled = true;
  const noChoice = { ...target, catalogue: { ...target.catalogue, parameters: target.catalogue.parameters.filter(p => p.id !== "choice.value") } };
  assertEquals(planCohort({ targets: [noChoice], cohortMode: "bulk", recipe })[0].problem.code, "invalid-plan");
});

Deno.test("cohort planner: unknown receipt names use byte identities and dedupe without graph assignments", async () => {
  const { recipe, target } = await fixture();
  recipe.images["image.image"].values.enabled = true;
  recipe.images["image.image"].values.items = [0, 1].map(() => ({ kind: "upload", name: "same.png", file: new File(["same bytes"], "same.png") }));
  const encoded = encodeHistoryRecipe(recipe, crypto.randomUUID());
  const resources = encoded.resources.map(resource => ({ ...resource, hash: "a".repeat(64) }));
  const counted = countingTarget(target, encoded.recipe, resources, { source: "other" }, 0);
  assertEquals([...counted.resourceIdentities.values()], [{ resource: "a".repeat(64) }, { resource: "a".repeat(64) }]);
  assertEquals(planCohort({ targets: [counted], cohortMode: "single", recipe: encoded.recipe, destination: { source: "other" } }), [{ index: 0, count: 1, problem: null }]);
});

Deno.test("cohort planner: shared kernel axis/traversal budget is admission, not a late dispatch failure", async () => {
  const { recipe, target } = await fixture();
  const base = recipe.numeric["n.denoise"], parameter = target.catalogue.parameters.find(p => p.id === "n.denoise");
  const parameters = Array.from({ length: 129 }, (_, index) => ({ ...parameter, id: `n.axis${index}`, key: `axis${index}` }));
  recipe.numeric = Object.fromEntries(parameters.map(p => [p.id, { ...structuredClone(base), metadata: { ...base.metadata, ...p } }]));
  const planned = planCohort({ targets: [{ ...target, catalogue: { ...target.catalogue, parameters } }], cohortMode: "single", recipe });
  assertEquals(planned[0].problem.code, "work-budget");
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
