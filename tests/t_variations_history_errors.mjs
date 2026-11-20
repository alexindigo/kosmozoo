import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert";
import { historyProblemCases } from "./helpers/variation-history-problem-cases.mjs";
import { variationProblem } from "../src/features/variations/problems.mjs";
import { problemPresentation } from "../client-solid/features/variations/problem-presentation.js";
import { makeHistoryClient } from "../client-solid/features/variations/history-client.js";
import { decodeHistoryRecipe } from "../src/features/variations/history-codec.mjs";
import { makeLeaveGuard } from "../client-solid/features/variations/draft.js";
import { makeVariationRecipe } from "../client-solid/features/variations/recipe.js";
import { makeVariationHistory } from "../src/features/variations/history.mjs";
import { registerHistory } from "../src/features/variations/history-routes.mjs";
for (const test of historyProblemCases) Deno.test(`history catalogue row ${test.row}: exact ${test.location} contract`, () => {
  const problem = variationProblem(test.code, test.context), projection = problemPresentation([problem]);
  assertEquals(problem.message, test.message); assertEquals(projection.text, test.message + " " + problem.action);
  assertEquals(projection.fields.get(test.context.parameter.id)[0], problem); assertEquals(projection.targets.get(0)[0], problem);
});
Deno.test("history codec rejects malformed own data with the actual path without running a getter", () => {
  let reads = 0; const document = { format: 1, recipe: { numeric: { broken: Object.defineProperty({}, "value", { enumerable: true, get() { reads++; } }) } } };
  const error = assertThrows(() => decodeHistoryRecipe(document));
  assertEquals(error.problem.code, "history-codec"); assertEquals(error.problem.path, "history.recipe.numeric.broken.value"); assertEquals(reads, 0);
  const format = assertThrows(() => decodeHistoryRecipe({ format: 2 })); assertEquals(format.problem.path, "format"); assert(format.message.includes("format 1"));
});
Deno.test("history client preserves structured preparation problems in leftovers", async () => {
  const problem = variationProblem("history-resource", { resource: "picked.png", runId: "saved-a", detail: "bytes unavailable" });
  const client = makeHistoryClient({ api: { historyMaterialize() { throw Object.assign(new Error(problem.message), { problem }); } } });
  const target = { id: "fake:b.png", host: "fake", filename: "b.png" };
  const result = await client.plans({ runId: "saved-a", targets: [target] }, { admission: [{ index: 0, count: 1 }], targets: [{ graphResources: { image: "image-0" } }], recipe: { images: {} } }, () => {});
  assertEquals(result.plans, []); assertEquals(result.leftovers[0].problem.code, "history-resource"); assertEquals(result.leftovers[0].problem.target.name, "b.png");
  await client.dispose();
});
Deno.test("history begin failure names Run scope and never archives browser files", async () => {
  const client = makeHistoryClient({ api: { historyBegin() { throw new Error("disk full"); } } });
  const recipe = makeVariationRecipe(); recipe.seed("naming", "root", {}, { prefix: "", suffix: "" });
  const ticket = { runId: "12345678-1234-4123-8123-123456789abc", snapshot: recipe.capture(), targets: [{ id: "fake:b.png", host: "fake", filename: "b.png" }] };
  const error = await assertRejects(() => client.capture(ticket, new Map(), () => {}));
  assertEquals(error.problem.code, "history-capture"); assertEquals(error.problem.numbers.images, 1); await client.dispose();
});
Deno.test("transition owner reports conflicting confirmation without replacing it", async () => {
  const problems = [], guard = makeLeaveGuard({ dirty: () => true, suspend() {}, restore() {}, decision() {}, invalidate() {}, failure: problem => problem && problems.push(problem) });
  const pending = guard.request({ intent: { type: "close" }, permit() {}, cancel() {} });
  assertEquals(await guard.request({ intent: { type: "replace" }, permit() {} }), { status: "busy" });
  assertEquals(problems[0].code, "transition-failed"); assertEquals(problems[0].message, "Could not open the new selection: the confirmation to close Variations is still open. Your current setup is kept."); guard.cancel(); assertEquals(await pending, { status: "cancelled" });
});
Deno.test("history public guards retain Run ID, missing resource names and target bounds", async () => {
  const id = "12345678-1234-4123-8123-123456789abc", rows = new Map(), resources = [{ hash: null, descriptor_json: JSON.stringify({ name: "missing.png" }) }];
  const store = { variationGet: key => rows.get(key), variationEffects: () => [], variationResources: () => resources, variationResource: () => resources[0], variationLease: () => null };
  const app = { store, archive: { read: () => { throw new Error("unexpected archive read"); } }, backings: {}, lifetime: { run: (_key, operation) => operation() } }, owner = makeVariationHistory(app);
  const malformed = assertThrows(() => owner.detail("bad-id")); assertEquals(malformed.problem.code, "history-id"); assertEquals(malformed.problem.runId, "bad-id");
  const gone = assertThrows(() => owner.detail(id)); assertEquals(gone.problem.code, "history-record"); assert(gone.message.includes("not found"));
  rows.set(id, { id, format: 1, deleted_at: null, recipe_json: "{}", summary_json: "{}", capture_state: "preparing" });
  const missing = await assertRejects(() => owner.open(id)); assertEquals(missing.problem.code, "history-incomplete"); assertEquals(missing.problem.names, ["missing.png"]); assertEquals(missing.problem.numbers, { missing: 1, total: 1 });
  const bytes = await assertRejects(() => owner.bytes(id, "image-0")); assertEquals(bytes.problem.code, "history-resource"); assertEquals(bytes.problem.resource, "missing.png");
  rows.get(id).capture_state = "complete"; rows.get(id).snapshot_json = JSON.stringify({ targets: [] });
  const target = await assertRejects(() => owner.catalogue(id, null, 2, {})); assertEquals(target.problem.code, "history-target"); assertEquals(target.problem.numbers, { index: 2, total: 0 });
  // Row 118: an unclassified storage failure names operation, file and Run.
  resources[0].hash = "a".repeat(64);
  const storage = await assertRejects(() => owner.bytes(id, "image-0")); assertEquals(storage.problem.code, "history-io");
  assert(storage.message.startsWith(`Could not read missing.png in saved Run ${id}: unexpected archive read.`), storage.message);
});
Deno.test("history HTTP guard errors are structured across JSON, pagination, bytes and target bodies", async () => {
  const routes = new Map(), app = { store: {}, backings: {}, lifetime: { run: (_key, operation) => operation() }, route: (method, path, handler) => routes.set(`${method} ${path}`, handler) };
  registerHistory(app);
  const cases = [
    ["GET /history", "?limit=101", null, "history-page", 400], ["GET /history", "?before=bad", null, "history-page", 400],
    ["POST /history", "", "bad", "history-request", 400], ["POST /history/<id>/prepare-target", "", "{}", "history-request", 400],
    ["PUT /history/<id>/resources/<resourceId>", "", "{}", "history-request", 415],
    ["GET /history/<id>/catalogue", "?target=-1", null, "history-request", 400],
  ];
  for (const [key, query, body, code, status] of cases) {
    const method = key.split(" ")[0], response = await routes.get(key)(new Request(`http://localhost/${query}`, { method, ...(body === null ? {} : { body, headers: { "Content-Type": "application/json" } }) }), { id: "saved-a", resourceId: "image-0" });
    const data = await response.json(); assertEquals(response.status, status); assertEquals(data.problem.code, code); assertEquals(data.error, data.problem.message);
  }
});
