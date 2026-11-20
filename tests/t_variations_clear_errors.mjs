import { assert, assertEquals, assertThrows } from "jsr:@std/assert";
import { variationProblem, problemFrom, effectCounts, effectMessage } from "../src/features/variations/problems.mjs";
import { problemPresentation, historyPresentation, acquisitionProblems } from "../client-solid/features/variations/problem-presentation.js";
import { editorRig } from "./helpers/variation-editor.mjs";
import { problemCases } from "./helpers/variation-problem-cases.mjs";
import { problemText } from "../src/features/variations/problems.mjs";
import { makeHistoryClient } from "../client-solid/features/variations/history-client.js";
import { connectionProblem } from "../client-solid/features/variations/field-filter.js";
import { objectInfoView } from "../src/backings/comfy.mjs";
import { droppedFiles } from "../client-solid/features/variations/image-drop.js";
import { listImages } from "../src/features/variations/folder-images.mjs";
import { planPresentation } from "../client-solid/features/variations/plan-presentation.js";
import { observeSubmission } from "../client-solid/features/variations/submission-progress.js";
import { makeVariationSession } from "../client-solid/features/variations/session.js";
import { makeVariationEditor } from "../client-solid/features/variations/editor.js";
import { encodeHistoryRecipe } from "../src/features/variations/history-codec.mjs";
import { makePexelsBrowse } from "../client-solid/features/variations/pexels-browse.js";
import { problemEnvelope, problemRoutes } from "../src/features/variations/problem-transport.mjs";
import { variationCommands } from "../client-solid/features/variations/commands.js";

for (const test of problemCases) Deno.test(`catalogue row ${test.row}: exact ${test.location} problem contract`, () => {
  const problem = variationProblem(test.code, test.context);
  assertEquals(problem.message, test.message);
  assert(problem.action.length > 0);
  const projected = problemPresentation([problem]);
  assertEquals(projected.text, test.message + " " + problem.action);
  assertEquals(projected.fields.get("n.steps")[0], problem);
  assertEquals(projected.targets.get(0)[0], problem);
});
Deno.test("phase 1 browser input contains all 38 exact row/location contracts", async () => {
  assertEquals(problemCases.length, 38);
  await Deno.mkdir("runtime", { recursive: true });
  await Deno.writeTextFile("runtime/clear-errors-cases.json", JSON.stringify(problemCases.map(test => ({ ...test, problem: variationProblem(test.code, test.context) }))));
});

Deno.test("silent rows 109,252,256: rejected public intents report without mutating recipe or targets", async () => {
  const rig = editorRig(), revision = rig.editor.revision();
  assertEquals(rig.editor.edit("numeric", "n.steps", "mode", "invented"), false);
  assertEquals(rig.editor.revision(), revision); assertEquals(rig.editor.problems()[0].code, "edit-failed");
  assertEquals(rig.editor.removeTarget("fake:image.png"), false);
  assertEquals(rig.editor.problems().at(-1).message, "image.png is the last remaining target. This editor requires at least 1 target.");
  rig.editor.decision(true); assertEquals((await rig.editor.run()).status, "busy");
  assertEquals(rig.editor.problems().at(-1).message, "Run was not started: confirmation is still in progress."); rig.editor.dispose();
});

Deno.test("silent rows 61,72,261: empty compatible ports, large admission and dropped declarations retain facts", () => {
  const p = { id: "n.image", label: "Image", schema: { status: "known", type: "IMAGE" } };
  assertEquals(connectionProblem(p, [{ id: "s", outputs: [{ type: "STRING" }] }]).message, "Image: no compatible known outputs among 1 nodes. This input needs IMAGE.");
  const view = planPresentation([{ index: 0, count: 101, problem: null }], [{ id: "fake:a.png", filename: "a.png" }]);
  assertEquals(view.notices[0].message, "This Run will queue 101 jobs across 1 images (101 maximum for one image; limit 500).");
  const schema = objectInfoView({ Node: { input: { required: { grow: ["COMFY_AUTOGROW_V3", { template: {} }], pick: ["COMFY_DYNAMICCOMBO_V3", { options: [{ key: 3 }] }] } } } });
  assertEquals(schema.schemaWarnings, [{ type: "Node", input: "Node.grow", detail: "invalid autogrow template" }, { type: "Node", input: "Node.pick", detail: "1 dynamic options have invalid keys" }]);
});

Deno.test("silent rows 213,214,215: catalogue drops, unreadable browser items and duplicate adds have owned field feedback", () => {
  const rig = editorRig();
  rig.editor.dropImages("image.image", { files: [new File(["x"], "bad.txt")], folders: 1 }, name => name.endsWith(".png"));
  assertEquals(rig.editor.rows("images")["image.image"].enabled, false);
  assertEquals(rig.editor.problems()[0].code, "drop-skipped");
  const resources = droppedFiles({ items: [{ kind: "file", getAsFile: () => null }] });
  rig.editor.dropImages("image.image", resources, () => true);
  assertEquals(rig.editor.problems().at(-1).numbers.unreadable, 1);
  rig.editor.addImages("image.image", [{ kind: "reference", value: "origin.png" }]);
  assertEquals(rig.editor.problems().at(-1).numbers, { added: 0, listed: 1, duplicates: 1 }); rig.editor.dispose();
});

Deno.test("silent row 185: folder traversal returns exact skipped symlink/unsupported counts", async () => {
  const path = await Deno.makeTempDir({ prefix: "ce-folder-" });
  try {
    await Deno.writeTextFile(path + "/a.png", "image"); await Deno.writeTextFile(path + "/a.txt", "text");
    await Deno.symlink(path + "/a.png", path + "/link.png");
    const result = await listImages(path); assertEquals(result.items.length, 1); assertEquals(result.skipped, { links: 1, other: 1 });
  } finally { await Deno.remove(path, { recursive: true }); }
});

Deno.test("silent rows 114,177: finish refresh failure reaches Run; disposed cleanup remains observable and retryable", async () => {
  const notices = [], client = makeHistoryClient({ api: { historyFinish: async () => ({ effects: { confirmed: 2 } }), historyList: () => { throw new Error("HTTP 503"); },
    historyOpen: async () => ({ id: "saved-a", leaseId: "lease-a" }), historyRelease: async () => { throw new Error("HTTP 503"); } }, notifyProblem: problem => notices.push(problem) });
  const finished = await client.finish("saved-a", null);
  assertEquals(finished.refreshProblem.code, "history-refresh");
  await client.open("saved-a"); await client.dispose();
  assertEquals(client.state().pendingCleanup, 1); assertEquals(client.state().problems.at(-1).code, "history-cleanup");
  assert(notices.length > 0); await client.activate(); assertEquals(client.state().pendingCleanup, 1);
});

Deno.test("silent row 112: progress retains last sample in explicit failure feedback without replay", async () => {
  let reads = 0, tick; const values = [], failures = [];
  const stop = observeSubmission({ read: async () => ++reads === 1 ? { sent: 2, total: 3 } : {}, publish: value => values.push(value), failure: (error, last) => failures.push({ message: error.message, last }),
    setTimer: fn => { tick = fn; return 1; }, clearTimer() {} });
  for (let i = 0; i < 8; i++) await Promise.resolve(); tick();
  for (let i = 0; i < 8; i++) await Promise.resolve(); await stop();
  assertEquals(failures, [{ message: "Invalid submission progress record", last: { sent: 2, total: 3 } }]); assertEquals(values.at(-1), null);
});

Deno.test("silent row 177: explicit cleanup recovery publishes removal of the notice and retry control", async () => {
  let failed = true, changes = 0;
  const owner = makeHistoryClient({ api: { historyOpen: async () => ({ id: "saved-a", leaseId: "lease-a" }),
    historyRelease: async () => { if (failed) throw new Error("offline"); } }, changed: () => changes++ });
  const record = await owner.open("saved-a"); await owner.release(record).catch(() => {});
  assertEquals(owner.state().pendingCleanup, 1); assert(owner.state().error.includes("offline"));
  const before = changes; failed = false; await owner.retryCleanup();
  assert(changes > before); assertEquals(owner.state().pendingCleanup, 0);
  assertEquals(owner.state().error, ""); assertEquals(owner.state().problems, []); await owner.dispose();
});

Deno.test("silent rows 173,255: invalid history decode cannot replace the current editor; opening races report", () => {
  let state = { open: false }, reports = [];
  const broker = makeVariationSession({ read: () => state, write: value => { state = value; }, report: value => reports.push(value) });
  assertThrows(() => broker.openHistory({ id: "saved-a", targets: [], format: 1, recipe: { invalid: {} } }), Error);
  assertEquals(state.open, false);
  broker.openHistory({}, { generation: 9, session: "old" });
  assertEquals(reports.at(-1).code, "session-changed");
});

Deno.test("silent rows 179,249,263: failed timing, retired photo choice and retired Run report through live owners", async () => {
  let release, began; const entered = new Promise(resolve => { began = resolve; });
  const notices = [], rig = editorRig({ generationTime: async () => { throw new Error("HTTP 503"); },
    readPexelsPhoto: () => new Promise(resolve => { release = resolve; }),
    history: { capture: async () => { began(); return new Promise(resolve => { release = resolve; }); }, finish() {}, notice: (id, problem) => notices.push(problem) } });
  await rig.editor.loadGenerationTimes(); assertEquals(rig.editor.problems().at(-1).code, "time-unavailable");
  const photo = rig.editor.togglePexels("image.image", "photos", "12", "http://photos");
  rig.editor.retirePexelsService("photos"); release(new File(["x"], "photo.png")); await photo;
  assertEquals(rig.editor.problems().find(problem => problem.code === "acquisition-retired").resource, "Photo 12");
  const running = rig.editor.run(); await entered; rig.editor.dispose(); release({}); await running;
  assertEquals(notices.at(-1).code, "run-retired");
});

Deno.test("problem contract retains identities, phase, numbers, effects and recovery across catches", () => {
  const problem = variationProblem("relative-absent", { target: { index: 1, source: "fake", name: "b.png" }, parameter: { id: "n.steps", label: "Steps" }, numbers: { jobs: 2, applied: 1, selected: 2 } });
  assertEquals(problem.message, "b.png: Steps is absent, so its relative sweep is not applied. 2 jobs use 1 of 2 selected parameters.");
  assertEquals(problemFrom({ problem }).target, problem.target);
  assert(problem.action.includes("shared parameter"));
  const view = problemPresentation([problem]);
  assertEquals(view.targets.get(1)[0], problem); assertEquals(view.fields.get("n.steps")[0], problem);
});

Deno.test("effect counts never call partial or unknown acceptance confirmed", () => {
  const effects = effectCounts([{ state: "confirmed", sent: true }, { state: "partial", sent: true }, { state: "uncertain", sent: true }, { state: "rejected", sent: true }], 5);
  assertEquals(effects, { sent: 4, confirmed: 1, partial: 1, unknown: 1, unsent: 1 });
  assertEquals(effectMessage(effects), "1 confirmed, 1 partial, 1 unknown, 1 unsent; 4 sent.");
});

Deno.test("silent row 178: saved effect presentation exposes partial node details without false confirmed errors", () => {
  const shown = historyPresentation({ summary: { targets: ["image.png"] }, effects: [
    { id: "job-0-0", kind: "permutation", state: "confirmed", result: { nodeErrors: {} } },
    { id: "job-0-1", kind: "permutation", state: "partial", result: { nodeErrors: { save: { errors: ["invalid input"] } } } },
  ] });
  assertEquals(shown.details[0].problems, []);
  assertEquals(shown.details[1].problems[0].message, 'image.png: permutation failed: {"save":{"errors":["invalid input"]}}.');
});

Deno.test("silent rows 16,18: catalogue install and current destination mismatch settle visibly", () => {
  const rig = editorRig();
  rig.editor.installCatalogue({ ...rig.catalogue, params: [...rig.catalogue.params, rig.catalogue.params[0]] });
  assertEquals(rig.editor.preview().status, "failed");
  assert(rig.editor.preview().message.includes("Cannot use the workflow catalogue for image.png"));
  const other = { ...rig.context.origin, source: "other", address: "other:8188" };
  rig.editor.setDestination(other);
  rig.editor.installCatalogue({ ...rig.catalogue, destination: { origin: rig.context.origin } });
  assert(rig.editor.preview().message.includes("not selected other"));
  rig.editor.dispose();
});

Deno.test("silent rows 84,19: invalid naming precedes count readiness and previous results", async () => {
  const rig = editorRig({ plan: async () => [{ index: 0, count: 1, problem: null }] });
  rig.editor.edit("naming", "root", "prefix", "{missing}");
  const timer = rig.timers.findLast(timer => timer.active && timer.ms === 150); timer.active = false; await timer.callback();
  assertEquals(rig.editor.canRun(), false);
  assertEquals(rig.editor.preview().status, "invalid");
  assert(rig.editor.preview().message.includes("Unresolved naming token"));
  rig.editor.dispose();
});

Deno.test("silent row 262: template expansion rejects before materializing an over-budget product", async () => {
  const { expandTextAxes } = await import("../src/features/variations/shared.mjs");
  const error = assertThrows(() => expandTextAxes("{{a}}{{b}}", { a: Array(1000).fill("a"), b: Array(1000).fill("b") }));
  assertEquals(error.problem.code, "template-budget");
  assertEquals(error.problem.numbers.requested, 1000000);
  assertEquals(error.problem.numbers.limit, 100000);
});

Deno.test("silent rows 25,204: unavailable destination and listing exclusions come from live owners", async () => {
  const rig = editorRig({ runDestinations: () => [], inputList: async () => ({ origin: rig.context.origin, root: "output", files: [
    { name: "visible.png", judgment: null }, { name: "hidden.png", judgment: { vote: "down" } }, { name: "../invalid.png" },
  ] }) });
  assertEquals(rig.editor.preview().message, problemText(variationProblem("no-destination", { phase: "destination" })));
  await rig.editor.loadSourceInputs(rig.context.origin, true, "output");
  const listing = rig.editor.sourceInputs(rig.context.origin, "output");
  assertEquals(listing.files, ["visible.png"]);
  assertEquals(listing.notices[0].message, "Showing 1 of 3 generated images from fake; 1 hidden by visibility preferences and 1 invalid paths omitted.");
  rig.editor.dispose();
});

Deno.test("silent rows 187,205,216,219,254: unavailable acquisition and opening paths publish explicit problems", async () => {
  assertEquals(acquisitionProblems({ pexels: { error: "offline" }, chooserError: new Error("HTTP 503") }).map(p => p.code),
    ["no-listing-source", "pexels-unavailable", "chooser-unavailable"]);
  assertEquals(acquisitionProblems({ sources: [{}], pexels: { loaded: true, services: [] } }).map(p => p.code), ["no-pexels"]);
  const reports = [], commands = variationCommands({ state: { images: [], hosts: {}, imageIdxById: () => new Map(), selected: {} }, broker: {}, report: p => reports.push(p) });
  assertEquals((await commands.find(command => command.id === "variations.open").execute({ id: "fake:missing.png" })).status, "stale");
  assertEquals(reports[0].message, "Could not open Variations: 1 of 1 selected images are unavailable (fake:missing.png).");
});

Deno.test("silent row 207: a retired foreign read rejection reports once without adding an image", async () => {
  const rig = editorRig(), origins = { fake: rig.context.origin, foreign: { ...rig.context.origin, source: "foreign", address: "foreign:8188" } };
  let reject;
  const editor = makeVariationEditor({ targets: rig.editor.targets(), services: { ...rig.services, readInput: () => new Promise((_, no) => { reject = no; }) }, currentOrigin: source => origins[source] });
  editor.installCatalogue(rig.catalogue);
  const before = editor.rows("images")["image.image"].items;
  const pending = editor.toggleSourceInput("image.image", origins.foreign, "foreign.png", "output");
  origins.foreign = { ...origins.foreign, incarnation: "replacement" }; reject(new Error("retired connection")); await pending;
  assertEquals(editor.rows("images")["image.image"].items, before);
  assertEquals(editor.problems().filter(p => p.code === "acquisition-retired").length, 1);
  assertEquals(editor.problems()[0].resource, "foreign.png"); editor.dispose(); rig.editor.dispose();
});

Deno.test("silent row 242: photo producer combines server exclusions and duplicate IDs across pages", async () => {
  const browse = makePexelsBrowse({ api: { pexelsPhotos: async (_service, _query, page) => ({ photos: page === 1 ? [{ id: "1" }] : [{ id: "1" }, { id: "2" }], more: page === 1,
    ...(page === 2 ? { skipped: { source: "Photos", received: 4, shown: 2, invalid: 1, duplicates: 1, page } } : {}) }) } });
  browse.request("photos"); for (let i = 0; i < 5; i++) await Promise.resolve();
  browse.more("photos"); for (let i = 0; i < 5; i++) await Promise.resolve();
  assertEquals(browse.results("photos").files, ["1", "2"]);
  assertEquals(browse.results("photos").notices[0].message, "Photos, page 2: showing 1 of 4 photos; skipped 1 invalid records and 2 duplicate IDs."); browse.dispose();
});

Deno.test("problem boundary preserves scoped partial-response problems even with HTTP 200", async () => {
  const context = { phase: "submission", target: { index: 0, source: "fake", name: "image.png" } };
  const envelope = problemEnvelope({ errors: [{ error: "partial receipt" }] }, context);
  assertEquals(envelope.errors[0].problem.message, "image.png: submission failed: partial receipt.");
  let handler;
  problemRoutes({ route(_method, _path, invoke) { handler = invoke; } }).route("POST", "/run", () => Response.json({ errors: [{ error: "partial receipt" }] }));
  const response = await handler(new Request("http://localhost/run"), {});
  assertEquals(response.status, 200); assertEquals((await response.json()).errors[0].problem.code, "operation");
});

Deno.test("silent row 173: real saved recipe validation precedes replacement; live archived destination checks settle", async () => {
  let snapshot;
  const rig = editorRig({ history: { capture: ticket => { snapshot = ticket.snapshot; throw new Error("capture only"); }, finish() {} } });
  await rig.editor.run();
  const encoded = encodeHistoryRecipe(snapshot, crypto.randomUUID());
  const record = { id: crypto.randomUUID(), format: encoded.format, recipe: encoded.recipe, resources: encoded.resources, targets: rig.editor.targets().map(target => ({ ...target, context: rig.context, catalogue: rig.catalogue })),
    cohortMode: "single", destination: rig.context.origin };
  let state = { open: false };
  const broker = makeVariationSession({ read: () => state, write: value => { state = value; } });
  broker.openHistory(record); assertEquals(state.open, true);
  const editor = makeVariationEditor({ targets: record.targets, cohortMode: "single", destination: record.destination, services: {}, currentOrigin: () => rig.context.origin });
  editor.restoreHistory(record); assertEquals(editor.preview().status, "reading");
  editor.installCatalogue({ ...rig.catalogue, destination: { origin: rig.context.origin } }, true);
  assertEquals(editor.preview().status, "ready");
  const invalid = structuredClone(record); invalid.recipe.numeric["n.steps"].values.mode = "invalid";
  const before = state; assertThrows(() => broker.openHistory(invalid)); assertEquals(state, before);
  editor.dispose(); rig.editor.dispose();
});
