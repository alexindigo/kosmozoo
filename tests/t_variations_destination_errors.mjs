import { assert, assertEquals, assertThrows } from "jsr:@std/assert";
import { destinationProblemCases } from "./helpers/variation-destination-problem-cases.mjs";
import { variationProblem, problemFrom, problemText } from "../src/features/variations/problems.mjs";
import { problemPresentation } from "../client-solid/features/variations/problem-presentation.js";
import { inspectSource } from "../src/features/variations/inspection.mjs";
import { inspectDestination } from "../src/features/variations/destination.mjs";
import { objectInfoView } from "../src/backings/comfy.mjs";
import { parameterIndex, resourceReferenceValue } from "../src/parameters.mjs";
import { editorRig } from "./helpers/variation-editor.mjs";
for (const test of destinationProblemCases) Deno.test(`destination catalogue row ${test.row}: exact ${test.location} contract`, () => {
  const p = variationProblem(test.code, test.context), projection = problemPresentation([p]);
  assertEquals(p.message, test.message); assertEquals(projection.text, test.message + " " + p.action);
  assertEquals(projection.fields.get("n.steps")[0], p); assertEquals(projection.targets.get(0)[0], p);
});
Deno.test("inspection producers preserve each failed stage, target identity and recovery", async () => {
  let accepting = true, address = "host:8188", hash = "a".repeat(64), current = true, graph = {};
  const app = { backings: { accepting: () => accepting, capture: () => ({ address }), source: () => ({ address, kind: "comfy", incarnation: "i" }), comfy: () => ({}), isCurrent: () => current }, store: { hashFor: () => hash }, ingest: { graph: async () => graph } };
  const inspect = () => inspectSource(app, "fake", "b.png");
  accepting = false; assertEquals((await inspect()).problem.code, "source-stopping"); accepting = true;
  address = null; assertEquals((await inspect()).problem.code, "source-missing"); address = "host:8188";
  assertEquals((await inspectSource(app, "fake", "../bad.png")).problem.code, "source-path");
  hash = null; assertEquals((await inspect()).problem.code, "source-unindexed"); hash = "a".repeat(64);
  graph = null; assertEquals((await inspect()).problem.code, "workflow-missing"); graph = { n: { class_type: "Node", inputs: { n: Infinity } } };
  assertEquals((await inspect()).problem.code, "workflow-inexact"); current = false;
  const result = await inspect(); assertEquals(result.problem.code, "inspection-retired"); assertEquals(result.problem.target, { source: "fake", name: "b.png" });
});
Deno.test("schema budget diagnostics carry native limits and field scope into destination failures", async () => {
  const invalid = objectInfoView({ Node: { input: { required: { group: ["COMFY_DYNAMICGROUP_V3", { max: 21, template: {} }] } } } });
  assertEquals(invalid.schemaIssue, { code: "schema-group", path: "Node.group", value: 21, numbers: { limit: 20 } });
  let nested = { required: { value: ["INT", {}] } };
  for (let i = 0; i < 34; i++) nested = { required: { child: ["COMFY_DYNAMICSLOT_V3", { inputs: nested }] } };
  const deep = objectInfoView({ Node: { input: nested } });
  assertEquals(deep.schemaIssue.code, "schema-depth"); assertEquals(deep.schemaIssue.numbers, { limit: 32, depth: 33 }); assert(deep.schemaIssue.path.startsWith("Node.child"));
  const large = objectInfoView({ Node: { input: { required: { choice: [Array(100001).fill("x")] } } } });
  assertEquals(large.schemaIssue.code, "schema-budget"); assert(large.schemaIssue.numbers.requested > large.schemaIssue.numbers.limit);
  const missing = await inspectDestination({}, { graph: {}, hash: "a", name: "b.png", originContext: null, destination: null });
  assertEquals(missing.problem.code, "origin-unavailable"); assertEquals(missing.problem.target.name, "b.png");
});
Deno.test("catalogue and resource validation expose structured locations without core depending on the feature", () => {
  const p = { id: "n.steps", key: "steps", nodeIds: ["n"] };
  const problem = problemFrom(assertThrows(() => parameterIndex([p, p])), { target: { name: "b.png" } });
  assertEquals(problem.code, "catalogue-location"); assertEquals(problem.path, "n.steps");
  const root = problemFrom(assertThrows(() => resourceReferenceValue("x.png", "wrong")), { parameter: { id: "n.steps" } });
  assertEquals(root.code, "resource-root"); assertEquals(root.root, "wrong");
});
Deno.test("catalogue client failure retains exact image/destination/cause in active status", () => {
  const rig = editorRig(); rig.editor.catalogueFailure(new Error("HTTP 502"));
  const p = rig.editor.problems().find(p => p.code === "catalogue-read");
  assert(p); assertEquals(rig.editor.preview().message, problemText(p)); assertEquals(p.target.name, "image.png");
  rig.editor.dispose();
});
