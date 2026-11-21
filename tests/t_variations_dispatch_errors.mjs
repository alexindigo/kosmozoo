import { assert, assertEquals } from "jsr:@std/assert";
import { dispatchProblemCases } from "./helpers/variation-dispatch-problem-cases.mjs";
import { variationProblem, backendProblem, effectCounts } from "../src/features/variations/problems.mjs";
import { problemPresentation } from "../client-solid/features/variations/problem-presentation.js";
import { enqueue, write } from "../src/backings/comfy.mjs";
import { editorRig } from "./helpers/variation-editor.mjs";
for (const test of dispatchProblemCases) Deno.test(`dispatch catalogue row ${test.row}: exact ${test.location} contract`, () => {
  const p = variationProblem(test.code, test.context), projection = problemPresentation([p]);
  assertEquals(p.message, test.message); assertEquals(projection.text, test.message + " " + p.action);
  assertEquals(projection.fields.get("n.steps")[0], p); assertEquals(projection.targets.get(0)[0], p);
});
Deno.test("enqueue diagnostics retain the full validation body, node causes and uncertainty without another send", async () => {
  let calls = 0;
  const reason = "validation detail ".repeat(30), nodeErrors = { save: { errors: [{ message: "missing input", details: "images" }] } };
  const rejected = await enqueue("fake", { prompt: {} }, { fetcher: () => { calls++; return Response.json({ error: { message: reason }, node_errors: nodeErrors }, { status: 400 }); } });
  const context = { phase: "submission", target: { name: "b.png" }, destination: "other", numbers: { index: 1, total: 2 } };
  const problem = backendProblem(rejected, context);
  assertEquals(problem.code, "enqueue-rejected"); assert(problem.message.includes(reason)); assert(problem.message.includes("save: missing input: images")); assertEquals(calls, 1);
  const uncertain = await enqueue("fake", { prompt: {} }, { fetcher: () => Response.json({ prompt_id: "p" }) });
  assertEquals(backendProblem(uncertain, context).code, "enqueue-unknown");
  const partial = await enqueue("fake", { prompt: {} }, { fetcher: () => Response.json({ prompt_id: "p", node_errors: nodeErrors }) });
  assertEquals(backendProblem(partial, context).code, "enqueue-partial"); assertEquals(backendProblem(partial, context).nodeErrors, nodeErrors);
  const lost = await enqueue("fake", { prompt: {} }, { fetcher: () => { throw new Error("reset"); } });
  assertEquals(backendProblem(lost, context).code, "enqueue-unknown");
});
Deno.test("upload diagnostics distinguish rejected filename/HTTP from receipt and transport uncertainty", async () => {
  const context = { phase: "upload", resource: "picked.png", destination: "other", target: { name: "b.png" }, parameter: { label: "Image" } };
  assertEquals(backendProblem(await write("fake", "../bad", new Uint8Array()), context).code, "upload-name");
  const rejected = await write("fake", "picked.png", new Uint8Array(), { fetcher: () => new Response("permission denied", { status: 403 }) });
  assert(backendProblem(rejected, context).message.includes("permission denied"));
  const receipt = await write("fake", "picked.png", new Uint8Array(), { fetcher: () => Response.json({ name: "picked.png", type: "output" }) });
  assertEquals(backendProblem(receipt, context).code, "upload-unknown");
  const network = await write("fake", "picked.png", new Uint8Array(), { fetcher: () => { throw new Error("reset"); } });
  assertEquals(backendProblem(network, context).code, "upload-unknown");
});
Deno.test("lost client Run response keeps its expected count and target in the leftover and no implicit retry", async () => {
  let calls = 0;
  const rig = editorRig({ run: async () => { calls++; throw new Error("network reset"); } });
  rig.editor.setEnabled("n.steps", true); rig.editor.edit("numeric", "n.steps", "mode", "value"); rig.editor.edit("numeric", "n.steps", "value", "2");
  await rig.editor.run(); assertEquals(calls, 1);
  assert(rig.editor.result().reason.includes("Receipts for 1 expected jobs could not be verified"));
  assert(rig.editor.result().reason.includes("Do not Run again until")); assertEquals(rig.editor.result().adopted, false);
  rig.editor.dispose();
});
Deno.test("unknown job states never count as both unknown and unsent", () => {
  assertEquals(effectCounts([{ state: "unknown" }], 2), { sent: 0, confirmed: 0, partial: 0, unknown: 1, unsent: 1 });
});
