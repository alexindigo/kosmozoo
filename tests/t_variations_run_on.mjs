import { assert, assertEquals } from "jsr:@std/assert";
import { makeVariationEditor } from "../client-solid/features/variations/editor.js";
import { makeHistoryClient } from "../client-solid/features/variations/history-client.js";
import { cataloguePresentation } from "../client-solid/features/variations/field-filter.js";
import { permutationPlan, generatePermutations, automaticNaming, reproducesOriginal } from "../src/features/variations/shared.mjs";
import { editorRig } from "./helpers/variation-editor.mjs";

function rig() {
  const base = editorRig(); base.editor.dispose();
  const origin = base.context.origin, other = { ...origin, source: "other", address: "other:8188", epoch: "other-epoch", incarnation: "other-incarnation" };
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
  assertEquals(r.editor.preview().status, "reading", "a late reply for the previous destination cannot install");
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
  assertEquals(r.editor.preview().message, "Resolve 2 conflicts with other before running.");
  assertEquals((await r.editor.run()).status, "invalid"); assertEquals(r.requests.length, 0);
  assertEquals(r.editor.resolveConflict("choice.value", "missing"), false, "only declared destination choices");
  assert(r.editor.resolveConflict("choice.value", "second"));
  assertEquals(r.editor.rows("enums")["choice.value"].picks, ["second"]);
  assertEquals(r.editor.rows("enums")["choice.value"].conflict, null);
  assertEquals(r.editor.preview().message, "Resolve 1 conflict with other before running.");
  assertEquals(r.editor.resolveConflict("text.text", "x"), false);
  r.editor.dispose();
});

Deno.test("run on: the issued ticket captures the destination and history binds uploads/plans to it", async () => {
  const r = rig(); r.install({});
  let begun; const bindings = [];
  const history = makeHistoryClient({ api: { historyBegin: body => { begun = body; }, historyPrepare: () => ({ snapshotHash: "a".repeat(64), targets: [{ graphResources: {} }], recipe: { images: {} } }),
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
  assertEquals(permutationPlan({}, current, {}, { sameHost: false }).total, 0, "no enabled axis is still nothing to vary");
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
