import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import { makeHistoryClient } from "../client-solid/features/variations/history-client.js";
import { editorRig } from "./helpers/variation-editor.mjs";
import { createRunId } from "../client-solid/features/variations/draft.js";
import { makeVariationSession } from "../client-solid/features/variations/session.js";

Deno.test("history opening: Store composition containers never alias the exact-JSON leased read model", async () => {
  const record = { id: createRunId(), leaseId: createRunId(), targets: [{ id: "fake:a.png", host: "fake", filename: "a.png", origin: { source: "fake" }, context: { graphHash: "a".repeat(64) }, historyRef: { runId: "saved" }, unavailable: null }] };
  let opening = { open: false };
  const broker = makeVariationSession({ read: () => opening, write(value) { opening = value; value.images[0].context[Symbol("proxy")] = true; } });
  assertEquals((await broker.openHistory(record)).status, "applied");
  assertEquals(Object.getOwnPropertySymbols(record.targets[0].context), []);
  assert(opening.images[0].context !== record.targets[0].context);
});
Deno.test("history opening: a completed read cannot replace a newer opening or closed A-B-A lifetime", async () => {
  let opening = { open: false, session: null };
  const broker = makeVariationSession({ read: () => opening, write: value => { opening = value; } });
  const ticket = broker.captureOpening();
  const record = { id: createRunId(), leaseId: createRunId(), targets: [{ id: "fake:saved.png", host: "fake", filename: "saved.png" }] };
  await broker.open([{ id: "fake:newer.png", host: "fake", filename: "newer.png" }]);
  broker.register(opening.session, { requestLeave: request => Promise.resolve(request.permit()) });
  assertEquals((await broker.openHistory(record, ticket)).status, "stale");
  assertEquals(opening.images[0].filename, "newer.png");
  await broker.close();
  assertEquals((await broker.openHistory(record, ticket)).status, "stale");
  assertEquals(opening.open, false);
});

Deno.test("history client: reads coalesce, deletion fences late list results and failed deletion preserves row", async () => {
  let resolve, reads = 0, rejected = false;
  const api = { historyList: () => { reads++; return new Promise(r => { resolve = r; }); }, historyRemove: () => rejected ? Promise.reject(new Error("disk failed")) : Promise.resolve() };
  const owner = makeHistoryClient({ api });
  const first = owner.refresh(), second = owner.refresh(); assert(first === second);
  await Promise.resolve(); resolve({ format: 1, items: [{ id: "a" }, { id: "b" }], nextCursor: null }); await first;
  assertEquals(reads, 1);
  const retained = owner.state().items[1];
  const fresh = owner.refresh(); await Promise.resolve(); resolve({ format: 1, items: [{ id: "a" }, { id: "b" }], nextCursor: null }); await fresh;
  assert(owner.state().items[1] === retained, "unchanged rows retain native action and preview owners across refresh");
  const late = owner.refresh(); await Promise.resolve(); await owner.remove("a");
  resolve({ format: 1, items: [{ id: "a" }, { id: "b" }], nextCursor: null }); await late;
  assertEquals(owner.state().items, [{ id: "b" }]);
  rejected = true; await owner.remove("b"); assertEquals(owner.state().items, [{ id: "b" }]); assertEquals(owner.state().error, "disk failed");
  owner.dispose();
});
Deno.test("history Run: initial immutable capture precedes waits and invalid input remains captured without dispatch", async () => {
  let captured, saved = 0, planned = 0;
  const rig = editorRig({ history: { capture(ticket) { captured = ticket; saved++; throw new Error("invalid saved raw value"); }, plans() { planned++; }, finish() {} } });
  rig.editor.setEnabled("n.denoise", true); rig.editor.edit("numeric", "n.denoise", "value", "1e");
  const file = new File(["identity"], "identity.png"); rig.editor.addImages("image.image", [{ kind: "upload", name: file.name, file }]);
  const running = rig.editor.run(); rig.editor.edit("numeric", "n.denoise", "value", "newer");
  await running;
  assertEquals(saved, 1); assertEquals(planned, 0); assertEquals(rig.requests.length, 0);
  assertEquals(captured.snapshot.numeric["n.denoise"].values.value, "1e");
  assert(captured.snapshot.images["image.image"].values.items[1].file === file);
  assertEquals(rig.editor.rows("numeric")["n.denoise"].value, "newer"); rig.editor.dispose();
});
Deno.test("history client: pagination/error recovery and retired late-open leases are owned", async () => {
  let failure = true, resolveOpen, released = [];
  const api = { historyList: before => failure ? Promise.reject(new Error("offline")) : Promise.resolve({ format: 1,
    items: before ? [{ id: "b" }] : [{ id: "a" }], nextCursor: before ? null : "next" }),
    historyOpen: () => new Promise(resolve => { resolveOpen = resolve; }), historyRelease: async (id, leaseId) => { released.push([id, leaseId]); } };
  const owner = makeHistoryClient({ api });
  await owner.refresh(); assertEquals(owner.state().error, "offline"); assertEquals(owner.state().pending, false);
  failure = false; await owner.refresh(); await owner.more();
  assertEquals(owner.state().items, [{ id: "a" }, { id: "b" }]); assertEquals(owner.state().more, false);
  const pending = owner.open("a"); owner.dispose(); resolveOpen({ id: "a", leaseId: "late" });
  await assertRejects(() => pending, Error, "unavailable"); assertEquals(released, [["a", "late"]]);
});
Deno.test("history plans: engine-correlated request proof is mandatory outside unchanged v2 acknowledgement", async () => {
  const baseline = editorRig();
  for (const echo of [true, false]) {
    const history = { capture: () => ({}), plans(ticket) {
      return [{ target: ticket.targets[0], request: { id: ticket.targets[0].id, host: "fake", filename: "image.png", ranges: { "n.denoise": { enabled: true, min: .9, max: .9, increment: .1 } }, imageParams: {}, prefix: "", suffix: "",
        context: baseline.context, acknowledgement: { version: 2, runId: ticket.runId, requestId: createRunId() }, history: { id: ticket.runId, snapshotHash: "a".repeat(64), targetIndex: 0, planHash: "b".repeat(64) } }, expectedTotal: 1 }];
    }, finish() {} };
    const rig = editorRig({ history, run: async request => {
      const response = await baseline.services.run(request);
      return { ...response, data: { ...response.data, ...(echo ? { history: request.history } : {}) } };
    } });
    rig.editor.setEnabled("n.denoise", true);
    assertEquals((await rig.editor.run()).adopted, echo); assertEquals(rig.editor.dirty(), !echo);
    rig.editor.dispose();
  }
  baseline.editor.dispose();
});
