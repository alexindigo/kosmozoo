import { assert, assertEquals, assertThrows } from "jsr:@std/assert";
import { plannerProblemCases } from "./helpers/variation-planner-problem-cases.mjs";
import { variationProblem, problemFrom, problemText } from "../src/features/variations/problems.mjs";
import { problemPresentation } from "../client-solid/features/variations/problem-presentation.js";
import { compileNumericOperation, parseRecipeCandidate } from "../src/features/variations/recipe-compile.mjs";
import { validateEditorValue } from "../src/features/variations/compile.mjs";
import { permutationPlan, generatePermutations, resolveRelativeRanges } from "../src/features/variations/shared.mjs";
import { planPresentation } from "../client-solid/features/variations/plan-presentation.js";
import { editorRig } from "./helpers/variation-editor.mjs";
for (const test of plannerProblemCases) Deno.test(`planner catalogue row ${test.row}: exact ${test.location} contract`, () => {
  const problem = variationProblem(test.code, test.context);
  assertEquals(problem.message, test.message);
  const projection = problemPresentation([problem]);
  assertEquals(projection.fields.get("n.steps")[0], problem);
  assertEquals(projection.targets.get(0)[0], problem);
  assertEquals(projection.text, test.message + " " + problem.action);
  JSON.stringify(problem);
});
Deno.test("planner rows 5/6: exact scope describes all-blocked and admitted siblings", () => {
  const targets = [{ id: "a", filename: "a.png" }, { id: "b", filename: "b.png" }];
  const problem = { code: "no-work", message: "a.png: unchanged." };
  assertEquals(planPresentation([{ index: 0, count: 0, problem }, { index: 1, count: 3, problem: null }], targets).message,
    "Run will submit 3 jobs for 1 of 2 images. 1 images will remain; see each image's reason below. Fix the reasons shown on each image or change the selection/destination.\na.png: a.png: unchanged.");
  assertEquals(planPresentation([{ index: 0, count: 0, problem }, { index: 1, count: 0, problem }], targets).message,
    "0 of 2 images can run; 0 jobs. Fix the reasons shown on each image or change the selection/destination.\na.png: a.png: unchanged.\nb.png: a.png: unchanged.");
});
Deno.test("planner producers keep raw values, bounds, types and missing labels in structured facts", () => {
  const metadata = { id: "n.steps", label: "Steps", nodeIds: ["n"], type: "Node", key: "steps", schema: { status: "known", type: "INT", min: 0, max: 10 }, minIncrement: 1 };
  const numeric = values => assertThrows(() => compileNumericOperation(values, metadata)).problem;
  assertEquals(numeric({ mode: "value", value: "1e" }).value, "1e");
  assertEquals(numeric({ mode: "range", min: "10", max: "2", rawIncrement: "1" }).numbers, { from: "10", to: "2" });
  assertEquals(numeric({ mode: "range", min: "0", max: "2", rawIncrement: "0" }).numbers.minimum, 1);
  assertEquals(assertThrows(() => validateEditorValue(metadata, 1.5)).problem.code, "value-type");
  assertEquals(assertThrows(() => validateEditorValue(metadata, -1)).problem.numbers, { bound: 0, min: 0, max: 10 });
  const missing = assertThrows(() => parseRecipeCandidate({ ...metadata, candidateKind: "connection" }, '{"node":"n","slot":"-1"}', [], 1)).problem;
  assertEquals(missing.numbers.candidate, 2); assertEquals(missing.slot, "-1");
});
Deno.test("planner kernels retain offending axis, exact count, visits and relative bounds", () => {
  const range = (min, max, increment) => ({ a: { enabled: true, min, max, increment } });
  assertEquals(assertThrows(() => permutationPlan(range(0n, 10n, 1.5), {})).problem.parameter.id, "a");
  assertEquals(assertThrows(() => permutationPlan(range(0n, 9007199254740992n, 1n), {})).problem.numbers.count, "9007199254740993");
  const axes = Object.fromEntries(Array.from({ length: 129 }, (_, i) => ["n" + i, { enabled: true, values: [1] }]));
  assertEquals(assertThrows(() => permutationPlan({}, {}, axes)).problem.numbers.axes, 129);
  const huge = assertThrows(() => generatePermutations(range(1, 100001, 1), {})).problem;
  assertEquals(huge.numbers.visits, 100001); assertEquals(huge.names, ["a (100001)"]);
  assertEquals(assertThrows(() => resolveRelativeRanges({ a: { min: .5, max: 1n, clamp: [0n, 2n] } }, { a: 0n })).problem.relative, true);
});
Deno.test("planner live editor exposes the same invalid field problem and status without editing raw data", () => {
  const rig = editorRig(); rig.editor.setEnabled("n.steps", true);
  rig.editor.edit("numeric", "n.steps", "mode", "value"); rig.editor.edit("numeric", "n.steps", "value", "1e");
  const revision = rig.editor.revision(), problem = rig.editor.problems().find(p => p.code === "numeric-text");
  assert(problem); assertEquals(problem.target.name, "image.png");
  assertEquals(rig.editor.rows("numeric")["n.steps"].problems[0], problem);
  assert(rig.editor.preview().message.includes(problem.message)); assertEquals(rig.editor.revision(), revision);
  rig.editor.dispose();
});
Deno.test("planner problem data is durable JSON and enrichment keeps both constraint and candidate facts", () => {
  const original = variationProblem("value-bound", { parameter: { id: "p" }, value: 10n, side: "max", numbers: { bound: 5n, min: undefined } });
  const enriched = problemFrom({ problem: original }, { target: { name: "b.png" }, parameter: { label: "Steps" }, numbers: { candidate: 2 } });
  assertEquals(enriched.numbers, { candidate: 2, bound: "5" }); assertEquals(enriched.parameter, { id: "p", label: "Steps" });
  assertEquals(JSON.parse(JSON.stringify(enriched)), enriched); assert(problemText(enriched).includes("b.png, Steps"));
});
