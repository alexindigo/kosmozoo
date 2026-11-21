import { assert, assertEquals } from "jsr:@std/assert";
import { acquisitionProblemCases } from "./helpers/variation-acquisition-problem-cases.mjs";
import { variationProblem } from "../src/features/variations/problems.mjs";
import { problemPresentation } from "../client-solid/features/variations/problem-presentation.js";
import { inspectImage } from "../src/features/variations/image-inspection.mjs";
import { editorRig } from "./helpers/variation-editor.mjs";
for (const test of acquisitionProblemCases) Deno.test(`acquisition catalogue row ${test.row}: exact ${test.location} contract`, () => {
  const p = variationProblem(test.code, test.context), projection = problemPresentation([p]);
  assertEquals(p.message, test.message); assertEquals(projection.text, test.message + " " + p.action);
  assertEquals(projection.fields.get("n.steps")[0], p); assertEquals(projection.targets.get(0)[0], p);
});
Deno.test("comparison producers name the actual missing current/collision image and HTTP status", async () => {
  let status = 404;
  const app = { backings: { isCurrent: () => true }, ingest: { ensure: (_host, name) => Promise.resolve({ status: name === "old.png" && status !== 404 ? 200 : status, hash: "a".repeat(64) }) } };
  const request = { name: "picked.png", bytes: new Uint8Array([1]), current: "old.png", kind: "input", names: ["picked (1).png"] };
  let data = await (await inspectImage(app, { address: "host:8188" }, "other", request, {})).json();
  assertEquals(data.problem.code, "comparison-current"); assertEquals(data.problem.current, "old.png"); assertEquals(data.problem.numbers.status, 404);
  status = 503;
  data = await (await inspectImage(app, { address: "host:8188" }, "other", request, {})).json();
  assertEquals(data.problem.code, "comparison-existing"); assertEquals(data.problem.current, "picked (1).png"); assertEquals(data.problem.numbers.status, 503);
});
Deno.test("comparison failures are scoped to current image membership rather than permanently blocking a removed item", async () => {
  const rig = editorRig({ inspectImage: () => ({ hash: "bad", origin: null }) });
  rig.editor.setEnabled("image.image", true);
  const item = { kind: "upload", name: "picked.png", file: new File(["bytes"], "picked.png") };
  rig.editor.addImages("image.image", [item]); await rig.editor.inspectImages();
  assert(rig.editor.problems().some(problem => problem.resource === "picked.png"));
  rig.editor.removeImage("image.image", item);
  assertEquals(rig.editor.problems().filter(problem => problem.resource === "picked.png").length, 0);
  rig.editor.dispose();
});
