import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import { makeHistoryClient } from "../client-solid/features/variations/history-client.js";
import { editorRig } from "./helpers/variation-editor.mjs";
import { createRunId } from "../client-solid/features/variations/draft.js";
import { makeVariationSession } from "../client-solid/features/variations/session.js";

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
for (const permanent of [false, true]) Deno.test(`history disposal: admitted late opens drain bounded serial cleanup (${permanent})`, async () => {
  const gate = deferred(), entered = deferred(), finish = deferred(); let calls = 0, settled = false;
  const record = { id: "a", leaseId: "late" };
  const owner = makeHistoryClient({ api: { historyOpen: () => gate.promise, historyRelease: async () => {
    calls++; if (calls === 1) { entered.resolve(); await finish.promise; throw new Error("offline"); }
    if (permanent) throw new Error("still offline");
  } } });
  const opened = owner.open("a"), rejected = assertRejects(() => opened, Error, "unavailable");
  const drain = owner.dispose(); assert(drain === owner.dispose()); drain.then(() => { settled = true; });
  await Promise.resolve(); assertEquals(settled, false);
  gate.resolve(record); await entered.promise; assertEquals(settled, false); finish.resolve();
  const results = await drain; await rejected;
  assertEquals(calls, 2); assertEquals(results.map(r => r.status), [permanent ? "rejected" : "fulfilled"]);
  assertEquals(!!owner.retained("a", "late"), permanent);
  if (permanent) assert(owner.state().error.includes("still offline"));
  else { await owner.release(record); assertEquals(calls, 2, "acknowledged lease cannot be re-enrolled"); }
});
Deno.test("history disposal: multiple acquisitions, POST rejection, joined release and a later retry pass", async () => {
  const gates = [deferred(), deferred(), deferred()], deleting = deferred(); let next = 0, calls = 0, fail = true;
  const owner = makeHistoryClient({ api: { historyOpen: () => gates[next++].promise,
    historyRelease: async () => { calls++; await deleting.promise; if (fail) throw new Error("offline"); } } });
  const opens = gates.map(() => owner.open("a")), observed = opens.map(p => assertRejects(() => p));
  const drain = owner.dispose(); assert(drain === owner.dispose());
  gates[1].resolve({ id: "a", leaseId: "second" }); gates[2].reject(new Error("POST failed"));
  gates[0].resolve({ id: "a", leaseId: "first" }); deleting.resolve();
  assertEquals((await drain).map(r => r.status), ["rejected", "rejected"]); await Promise.all(observed);
  assertEquals(calls, 4); fail = false;
  const retry = owner.dispose(); assert(retry === owner.dispose()); await retry; assertEquals(calls, 6);
  assertEquals(owner.retained("a", "first"), null); assertEquals(owner.retained("a", "second"), null);
});
Deno.test("history disposal: a failed admitted POST preserves its public transport error", async () => {
  const gate = deferred(); const owner = makeHistoryClient({ api: { historyOpen: () => gate.promise } });
  const opened = owner.open("a"), rejected = assertRejects(() => opened, Error, "POST transport");
  const drain = owner.dispose(); gate.reject(new Error("POST transport")); await rejected;
  assertEquals(await drain, []);
});
Deno.test("history disposal: release, activation and disposal join one in-flight DELETE", async () => {
  const gate = deferred(), entered = deferred(), record = { id: "a", leaseId: "joined" }; let calls = 0;
  const owner = makeHistoryClient({ api: { historyOpen: () => record, historyRelease: async () => {
    calls++; if (calls === 1) { entered.resolve(); await gate.promise; throw new Error("retry"); }
  } } });
  await owner.open("a"); const released = owner.release(record), observed = assertRejects(() => released);
  await entered.promise; const activation = owner.activate(), drain = owner.dispose(); assert(drain === owner.dispose());
  assertEquals(calls, 1); gate.resolve(); await Promise.all([observed, activation, drain]);
  assertEquals(calls, 2); await owner.release(record); assertEquals(calls, 2);
});
Deno.test("history disposal: each retired open owns only its own cleanup error", async () => {
  const gates = [deferred(), deferred()]; let next = 0;
  const problem = new Error("bad lease");
  const owner = makeHistoryClient({ api: { historyOpen: () => gates[next++].promise,
    historyRelease: (_id, key) => key === "bad" ? Promise.reject(problem) : Promise.resolve() } });
  const opens = [owner.open("a"), owner.open("a")];
  const errors = opens.map(p => p.catch(error => error)); const drain = owner.dispose();
  gates[0].resolve({ id: "a", leaseId: "bad" }); gates[1].resolve({ id: "a", leaseId: "good" });
  await drain; const [bad, good] = await Promise.all(errors);
  assert(bad.cause === problem); assertEquals(good.cause, undefined);
});
Deno.test("history deletion: late detail is fenced and the late opened lease joins disposal retry", async () => {
  const open = deferred(), detail = deferred(); let calls = 0;
  const owner = makeHistoryClient({ api: { historyOpen: () => open.promise, historyDetail: () => detail.promise,
    historyRemove: async () => {}, historyRelease: async () => { if (++calls === 1) throw new Error("offline"); } } });
  const opening = owner.open("a"), reading = owner.detail("a");
  const rejectedOpen = assertRejects(() => opening, Error, "unavailable"), rejectedDetail = assertRejects(() => reading, Error, "unavailable");
  await owner.remove("a"); open.resolve({ id: "a", leaseId: "deleted" }); detail.resolve({ id: "a" });
  await Promise.all([rejectedOpen, rejectedDetail]); assert(owner.retained("a", "deleted"));
  await owner.dispose(); assertEquals(calls, 2); assertEquals(owner.retained("a", "deleted"), null);
});

Deno.test("history client: failed releases remain owned, coalesce and retry at disposal", async () => {
  const record = { id: "a", leaseId: "owned" }; let fail = true, calls = 0;
  const owner = makeHistoryClient({ api: { historyOpen: async () => record,
    historyRelease: async () => { calls++; if (fail) throw new Error("offline"); } } });
  await owner.open("a");
  await assertRejects(() => owner.release(record), Error, "offline");
  assert(owner.retained("a", "owned"), "failed release cannot forget the lease");
  fail = false; await owner.dispose();
  assertEquals(calls, 2); assertEquals(owner.retained("a", "owned"), null);
});

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
