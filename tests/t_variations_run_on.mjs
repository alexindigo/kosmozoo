import { assert, assertEquals, assertThrows } from "jsr:@std/assert";
import { makeVariationEditor } from "../client-solid/features/variations/editor.js";
import { makeHistoryClient } from "../client-solid/features/variations/history-client.js";
import { cataloguePresentation } from "../client-solid/features/variations/field-filter.js";
import { permutationPlan, generatePermutations, automaticNaming, reproducesOriginal } from "../src/features/variations/shared.mjs";
import { editorRig } from "./helpers/variation-editor.mjs";
const conflictMessage = names => `image.png: ${names.length} destination conflicts block Run on other: ${names.join(", ")}. Choose available values below or another destination.`;
const catalogueFailure = cause => `Could not read image.png's workflow for other: ${cause}. Your edits are kept. Retry the check or choose a reachable destination.`;

function rig() {
  const base = editorRig(); base.editor.dispose();
  const origin = base.context.origin, other = { ...origin, source: "other", address: "other:8188", incarnation: "other-incarnation" };
  const current = { [origin.source]: origin, other };
  const editor = makeVariationEditor({ targets: [{ id: "fake:image.png", host: "fake", filename: "image.png", origin }], destination: other,
    services: base.services, currentOrigin: host => current[host] });
  const install = conflicts => editor.installCatalogue({ ...base.catalogue, destination: { origin: other, missing: [], conflicts } });
  return { ...base, editor, origin, other, current, install };
}

Deno.test("run on: the destination catalogue gates preview and Run until it is inspected", async () => {
  const r = rig();
  r.editor.installCatalogue(r.catalogue);
  assertEquals(r.editor.preview().status, "reading", "the target catalogue alone is not the destination's view");
  assertEquals((await r.editor.run()).status, "invalid");
  r.install({});
  assertEquals(r.editor.preview().status, "ready");
  assert(r.editor.setDestination(r.origin)); assertEquals(r.editor.preview().status, "reading");
  r.install({ "choice.value": { kind: "node", type: "Choice" } });
  assertEquals(r.editor.preview().status, "failed", "a mismatched reply reaching the current install boundary cannot install or leave an endless wait");
  assert(r.editor.preview().message.includes("not selected fake"));
  r.editor.installCatalogue({ ...r.catalogue, destination: { origin: r.origin, missing: [], conflicts: {} } });
  assertEquals(r.editor.preview().status, "ready");
  assertEquals(r.editor.destination(), r.origin);
  r.editor.dispose();
});

Deno.test("run on: value conflicts are red until resolved; node conflicts block", async () => {
  const r = rig();
  r.install({ "choice.value": { kind: "value", current: "first", choices: ["second", "third"], suggestions: ["second"] },
    "text.text": { kind: "node", type: "Text" } });
  const rows = Object.fromEntries(r.editor.catalogue().map(row => [row.id, row]));
  assertEquals(rows["choice.value"].conflict.host, "other");
  assertEquals(cataloguePresentation(r.editor.catalogue())[0].name, "Conflicts");
  assertEquals(r.editor.preview().status, "conflict");
  assertEquals(r.editor.preview().message, conflictMessage(["Choice #choice \u00b7 value", "Text #text \u00b7 text"]));
  assertEquals((await r.editor.run()).status, "invalid"); assertEquals(r.requests.length, 0);
  assertEquals(r.editor.resolveConflict("choice.value", "missing"), false, "only declared destination choices");
  assert(r.editor.resolveConflict("choice.value", "second"));
  assertEquals(r.editor.rows("enums")["choice.value"].picks, ["second"]);
  assertEquals(r.editor.rows("enums")["choice.value"].conflict, null);
  assertEquals(r.editor.preview().message, conflictMessage(["Text #text \u00b7 text"]));
  assertEquals(r.editor.resolveConflict("text.text", "x"), false);
  r.editor.dispose();
});

Deno.test("run on: the issued ticket captures the destination and history binds uploads/plans to it", async () => {
  const r = rig(); r.install({});
  let begun; const bindings = [];
  const history = makeHistoryClient({ api: { historyBegin: body => { begun = body; }, historyPrepare: () => ({ snapshotHash: "a".repeat(64), targets: [{ graphResources: {} }], recipe: { images: {} }, admission: [{ index: 0, count: 1, problem: null }] }),
    historyMaterialize: () => ({}), historyTarget: (_id, binding) => { bindings.push(binding); throw new Error("stop after binding"); } } });
  const ticket = { runId: crypto.randomUUID(), targets: [{ id: "fake:image.png", host: "fake", filename: "image.png", origin: r.origin }], snapshot: { numeric: {}, images: {}, enums: {}, texts: {}, candidates: {}, naming: {} }, destination: r.other };
  const prepared = await history.capture(ticket, new Map(), () => {});
  assertEquals(begun.destination, r.other);
  await history.plans(ticket, prepared, () => {}).catch(() => {});
  assertEquals(bindings[0].origin, r.other);
  await history.dispose(); r.editor.dispose();
});

Deno.test("run on: the host is a compared parameter; the unchanged tuple is new on another host", () => {
  const ranges = { "n.steps": { enabled: true, min: 19, max: 21, increment: 1 } }, current = { "n.steps": 20 };
  assertEquals([reproducesOriginal("a", "a"), reproducesOriginal("a", null), reproducesOriginal("a", "b")], [true, true, false]);
  assertEquals([permutationPlan(ranges, current).total, permutationPlan(ranges, current).excluded], [2, 1]);
  const elsewhere = permutationPlan(ranges, current, {}, { sameHost: false });
  assertEquals([elsewhere.total, elsewhere.excluded], [3, 0]);
  assertEquals(generatePermutations(ranges, current, {}, { sameHost: false }).map(p => p["n.steps"]), [19, 20, 21]);
  const only = { "n.pick": { enabled: true, values: ["x"] } };
  assertEquals(generatePermutations({}, { "n.pick": "x" }, only), []);
  assertEquals(generatePermutations({}, { "n.pick": "x" }, only, { sameHost: false }), [{ "n.pick": "x" }]);
  assertEquals(automaticNaming({}, { "n.pick": "x" }, { "n.pick": { enabled: true, values: ["x", "y"] } }, { sameHost: false }).ids, ["n.pick"]);
  assertEquals(permutationPlan({}, current, {}, { sameHost: false }).total, 1, "destination alone is a parameter");
  assertEquals(generatePermutations({}, current, {}, { sameHost: false }), [{}], "the identity tuple invents no parameter assignments");
  assertEquals(generatePermutations({}, current), []);
  assertEquals(automaticNaming({}, current, {}, { sameHost: false }), { ids: [], suffix: "" });
  assertEquals(permutationPlan({ "n.steps": { enabled: false } }, current, {}, { sameHost: false }).total, 1);
  assertEquals(generatePermutations({ "n.steps": { enabled: true, min: 2, max: 1, increment: 1 } }, current, {}, { sameHost: false }), [], "an empty range is not the identity tuple");
  assertThrows(() => permutationPlan({}, current, { "n.pick": { enabled: true, values: [] } }, { sameHost: false }));
  assertThrows(() => permutationPlan({}, current, { "n.pick": { enabled: true } }, { sameHost: false }));
});

Deno.test("run on: every graph parameter off previews one unchanged graph elsewhere and zero on its own host", () => {
  const r = rig(); r.install({});
  assertEquals([r.editor.preview().n, r.editor.preview().excluded], [1, 0]);
  assertEquals(r.editor.preview().axes, [], "no fabricated graph axis");
  assert(r.editor.setDestination(r.origin));
  r.editor.installCatalogue({ ...r.catalogue, destination: { origin: r.origin, missing: [], conflicts: {} } });
  assertEquals(r.editor.preview().n, 0);
  r.editor.dispose();
});

Deno.test("run on: unchecked inputs inform without becoming conflicts and retire with their destination", () => {
  const r = rig();
  r.editor.installCatalogue({ ...r.catalogue, destination: { origin: r.other, missing: [], conflicts: {}, unchecked: ["text.text"] } });
  assertEquals(r.editor.preview().status, "ready");
  assertEquals(r.editor.preview().unchecked, ["text.text"]);
  assertEquals(r.editor.preview().uncheckedMessage, "image.png: 1 recorded inputs (Text #text \u00b7 text) are unchecked on other; they have no usable declarations. ComfyUI will validate them at submission. Inspect or change these inputs, or use another destination; Run can attempt them but ComfyUI may reject them.");
  assertEquals(r.editor.preview().message, "");
  r.editor.installCatalogue({ ...r.catalogue, destination: { origin: r.other, missing: [], conflicts: { "choice.value": { kind: "value", current: "first", choices: ["second"], suggestions: [] } }, unchecked: ["text.text"] } });
  assertEquals(r.editor.preview().status, "conflict");
  assertEquals(r.editor.preview().message, conflictMessage(["Choice #choice \u00b7 value"]));
  assert(r.editor.preview().uncheckedMessage.startsWith("image.png: 1 recorded inputs"));
  assert(r.editor.setDestination(r.origin));
  assertEquals(r.editor.preview().uncheckedMessage, undefined, "pending destinations cannot inherit old review facts");
  r.editor.installCatalogue({ ...r.catalogue, destination: { origin: r.origin, missing: [], conflicts: {}, unchecked: [] } });
  assertEquals(r.editor.preview().uncheckedMessage, "");
  r.editor.dispose();
});

Deno.test("run on: picking only the current value is one variation on another host, none on its own", () => {
  const r = rig(); r.install({});
  r.editor.setEnabled("choice.value", true); r.editor.edit("enums", "choice.value", "picks", ["first"]);
  assertEquals([r.editor.preview().n, r.editor.preview().excluded], [1, 0]);
  assert(r.editor.setDestination(r.origin));
  r.editor.installCatalogue({ ...r.catalogue, destination: { origin: r.origin, missing: [], conflicts: {} } });
  assertEquals([r.editor.preview().n, r.editor.preview().excluded], [0, 1]);
  r.editor.dispose();
});

Deno.test("run on: a failed catalogue request says so, sends nothing and can be retried", async () => {
  const r = rig();
  r.editor.catalogueFailure(new Error("HTTP 502"));
  assertEquals([r.editor.preview().status, r.editor.preview().message], ["failed", catalogueFailure("HTTP 502")]);
  assertEquals((await r.editor.run()).status, "invalid"); assertEquals(r.requests.length, 0);
  assert(r.editor.result().text.endsWith("Nothing was sent."));
  assert(r.editor.retryCatalogue());
  assertEquals(r.editor.result(), null, "a retry clears the blocked Run's message");
  assertEquals(r.editor.preview().status, "reading", "back to checking the same host");
  assertEquals(r.editor.retryCatalogue(), false, "only after a failure");
  r.install({});
  assertEquals(r.editor.preview().status, "ready");
  r.editor.catalogueFailure(Object.assign(new Error("GET /api/features/variations/probe/x: 502 \u2014 object_info timed out"), { status: 502, detail: "object_info timed out" }));
  assertEquals(r.editor.preview().message, catalogueFailure("object_info timed out"), "the server's reason, not the request path");
  r.editor.catalogueFailure(Object.assign(new Error("GET /x: 504"), { status: 504, detail: "" }));
  assertEquals(r.editor.preview().message, catalogueFailure("HTTP 504"));
  r.editor.dispose();
});
