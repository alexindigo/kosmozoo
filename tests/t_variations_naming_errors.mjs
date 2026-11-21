import { assert, assertEquals, assertThrows } from "jsr:@std/assert";
import { namingProblemCases } from "./helpers/variation-naming-problem-cases.mjs";
import { variationProblem } from "../src/features/variations/problems.mjs";
import { problemPresentation } from "../client-solid/features/variations/problem-presentation.js";
import { composeOutputName, variationOutputName, templateReplaceWithProof } from "../src/features/variations/shared.mjs";
import { mutateGraph } from "../src/features/variations/server.mjs";
for (const test of namingProblemCases) Deno.test(`naming catalogue row ${test.row}: exact ${test.location} contract`, () => {
  const p = variationProblem(test.code, test.context), projection = problemPresentation([p]);
  assertEquals(p.message, test.message); assertEquals(projection.text, test.message + " " + p.action);
  assertEquals(projection.fields.get("n.steps")[0], p); assertEquals(projection.targets.get(0)[0], p);
});
Deno.test("naming producers report selected value, original/requested directory, UTF-8 bytes and affix identity", () => {
  const target = { parameterId: "save.filename_prefix", directory: "folder/", sourceStem: "source", leafOnly: true };
  const selected = (value, prefix = "", suffix = "") => assertThrows(() => composeOutputName(target, { "save.filename_prefix": value }, prefix, suffix)).problem;
  assertEquals(selected(42).value, 42);
  assertEquals(selected("../bad").code, "output-path");
  assertEquals(selected("other/name").actual, "other/");
  assertEquals(selected("folder/" + "x".repeat(199), "abc").numbers, { bytes: 202, limit: 200 });
  const separator = assertThrows(() => composeOutputName(target, {}, "", "nested/")).problem;
  assertEquals(separator.field, "Suffix"); assertEquals(separator.separator, "/");
  const composed = selected("folder/name", "\u0000"); assertEquals(composed.composed, true); assertEquals(composed.value, "folder/\u0000name");
});
Deno.test("naming tokens retain unknown spelling, unbalanced syntax and owning Prefix/Suffix in preview and execution projection", () => {
  const target = { directory: "", sourceStem: "source" };
  const projection = variationOutputName(target, { prefix: "{missing}", suffix: "broken{" }, {}, {});
  assertEquals(projection.complete, false);
  assertEquals(projection.problems.map(p => [p.field, p.token, p.detail]), [["Prefix", "{missing}", "unknown parameter"], ["Suffix", "broken{", "unbalanced braces"]]);
  assertEquals(templateReplaceWithProof("{missing}", {}, {}).unresolved, [{ token: "{missing}", detail: "unknown parameter" }]);
});
Deno.test("dynamic mutation reports missing branch and missing default without losing child identity", () => {
  const graph = { n: { class_type: "Node", inputs: { branch: "old" } } }, p = { id: "n.branch", key: "branch", nodeIds: ["n"], type: "Node" };
  const combos = new Map([["Node.branch", new Map([["new", { defaults: new Map([["Node.branch.value", undefined]]) }]])]]);
  assertEquals(assertThrows(() => mutateGraph(graph, { "n.branch": "bad" }, [p], combos)).problem.value, "bad");
  const missing = assertThrows(() => mutateGraph(graph, { "n.branch": "new" }, [p], combos)).problem;
  assertEquals(missing.child, "n.branch.value"); assertEquals(missing.value, "new");
  assertEquals(graph.n.inputs.branch, "old");
});
