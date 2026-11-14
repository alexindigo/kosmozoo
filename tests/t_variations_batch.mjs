import { assert, assertEquals } from "jsr:@std/assert";
import { makeVariationEditor } from "../client-solid/features/variations/editor.js";
import { editorRig } from "./helpers/variation-editor.mjs";
import { makeHistoryClient } from "../client-solid/features/variations/history-client.js";
import { makeVariationSession } from "../client-solid/features/variations/session.js";

function rig(overrides = {}) {
  const base = editorRig(); base.editor.dispose();
  const targets = [60000, null, 180000].map((generationTimeMs, i) => ({ id: `fake:${i}.png`, host: "fake", filename: `${i}.png`, origin: base.context.origin, generationTimeMs }));
  let closed = 0;
  const editor = makeVariationEditor({ targets, services: { ...base.services, ...overrides }, currentOrigin: () => base.context.origin, close: () => closed++ });
  editor.installCatalogue(base.catalogue);
  const enable = () => { editor.setEnabled("n.denoise", true); editor.edit("numeric", "n.denoise", "mode", "value"); editor.edit("numeric", "n.denoise", "value", "0.9"); };
  return { ...base, editor, targets, enable, closed: () => closed };
}

Deno.test("batch membership: removal is private work, preserves recipe and recomputes count/time", () => {
  const r = rig(); assertEquals(r.editor.dirty(), false);
  const revision = r.editor.revision();
  assert(r.editor.removeTarget("fake:1.png")); assert(r.editor.dirty()); assertEquals(r.editor.revision(), revision + 1);
  assertEquals(r.editor.targets().map(t => t.id), ["fake:0.png", "fake:2.png"]);
  assertEquals(r.targets.length, 3, "opening never mutated");
  r.enable(); const before = r.editor.rows("numeric");
  assertEquals(r.editor.preview().n, 2); assertEquals(r.editor.preview().timeEstimate.display, "4m");
  assert(r.editor.removeTarget("fake:0.png"));
  assertEquals(r.editor.rows("numeric"), before);
  assertEquals(r.editor.preview().n, 1); assertEquals(r.editor.preview().timeEstimate.display, "3m");
  assertEquals(r.editor.generationTime("fake:0.png"), null);
  assertEquals(r.editor.removeTarget("fake:2.png"), false); assertEquals(r.editor.removeTarget("missing"), false);
  r.editor.dispose(); assertEquals(r.editor.removeTarget("fake:2.png"), false);
});

Deno.test("batch membership: Run freezes surviving targets, retains relative basis at one and rejects removal during IO", async () => {
  let resume, entered;
  const gate = new Promise(resolve => { resume = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const r = rig({ probe: async () => { entered(); await gate; return r.catalogue; } });
  r.enable(); r.editor.removeTarget("fake:0.png"); r.editor.removeTarget("fake:1.png");
  const task = r.editor.run(); await started;
  assertEquals(r.editor.removeTarget("fake:2.png"), false); resume();
  const result = await task; assertEquals(result.adopted, true);
  assertEquals(r.requests.map(request => request.id), ["fake:2.png"]);
  assertEquals(r.requests[0].relative, true);
  r.editor.dispose();
});

Deno.test("batch membership: history capture uses surviving subset and explicit bulk basis even at one", async () => {
  const r = rig(); r.enable(); r.editor.removeTarget("fake:0.png"); r.editor.removeTarget("fake:1.png");
  let captured;
  const client = makeHistoryClient({ api: { historyBegin: body => { captured = body; }, historyPrepare: () => ({}) } });
  await client.capture({ runId: crypto.randomUUID(), cohortMode: "bulk", targets: r.editor.targets(), snapshot: { numeric: {}, images: {}, enums: {}, texts: {}, candidates: {}, naming: {} } }, new Map(), () => {});
  assertEquals(captured.cohortMode, "bulk"); assertEquals(captured.targets.map(t => t.id), ["fake:2.png"]);
  await client.dispose(); r.editor.dispose();
  let opening = { open: false };
  const session = makeVariationSession({ read: () => opening, write: value => { opening = value; } });
  await session.openHistory({ id: "saved", leaseId: "lease", cohortMode: "bulk", targets: [{ id: "fake:one.png", host: "fake", filename: "one.png" }] });
  assertEquals(opening.cohortMode, "bulk");
});

Deno.test("batch membership: removed target's late timing cannot publish and decision rejects removal", async () => {
  let finish, changes = 0;
  const base = editorRig(); base.editor.dispose();
  const targets = ["a", "b"].map(n => ({ id: `fake:${n}.png`, host: "fake", filename: `${n}.png`, origin: base.context.origin }));
  const editor = makeVariationEditor({ targets, currentOrigin: () => base.context.origin, changed: () => changes++,
    services: { generationTime: t => t.id === targets[0].id ? new Promise(resolve => { finish = () => resolve({ name: t.filename, hash: "a".repeat(64), generationTimeMs: 1000 }); }) : Promise.resolve(null) } });
  const reading = editor.loadGenerationTimes(); editor.decision(true); assertEquals(editor.removeTarget(targets[0].id), false); editor.decision(false);
  assert(editor.removeTarget(targets[0].id)); const before = changes; finish(); await reading; assertEquals(changes, before);
  assertEquals(editor.generationTime(targets[0].id), null); editor.dispose();
});
