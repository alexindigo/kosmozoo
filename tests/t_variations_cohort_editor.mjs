import { assert, assertEquals } from "jsr:@std/assert";
import { editorRig } from "./helpers/variation-editor.mjs";
import { compileRecipe } from "../src/features/variations/recipe-compile.mjs";
import { runStatus } from "../client-solid/features/variations/run-status.js";
import { MAX_JOBS_PER_IMAGE } from "../src/features/variations/shared.mjs";

const settle = async rig => {
  const timer = rig.timers.findLast(timer => timer.active && timer.ms === 150);
  assert(timer); timer.active = false; await timer.callback();
};
Deno.test("cohort preview: pending/zero plans gate the detached Run port without history effects", async () => {
  let count = 0, captures = 0;
  const rig = editorRig({ plan: async () => [{ index: 0, count, problem: count ? null : { code: "no-work", message: "Choose a different value." } }],
    history: { capture() { captures++; throw new Error("capture reached"); }, finish() {} } });
  const requestRun = rig.editor.run;
  assertEquals(rig.editor.canRun(), false);
  assertEquals((await requestRun()).status, "invalid");
  await settle(rig);
  assertEquals([rig.editor.canRun(), rig.editor.preview().n], [false, 0]);
  assertEquals(rig.editor.targetProblem("fake:image.png").code, "no-work");
  assertEquals((await requestRun()).status, "invalid"); assertEquals(captures, 0);
  count = 2; rig.editor.setEnabled("n.denoise", true);
  await settle(rig);
  assertEquals([rig.editor.canRun(), rig.editor.preview().n], [true, 2]);
  assertEquals((await requestRun()).status, "invalid"); assertEquals(captures, 1);
  rig.editor.dispose();
});

Deno.test("cohort preview: latest-only reads abort retired plans and disposal aborts pending transport", async () => {
  const reads = [];
  const rig = editorRig({ plan: (input, signal) => new Promise(resolve => reads.push({ input, signal, resolve })) });
  const first = rig.timers.findLast(timer => timer.active && timer.ms === 150); first.active = false;
  const old = first.callback();
  rig.editor.setEnabled("n.denoise", true);
  assert(reads[0].signal.aborted);
  const next = rig.timers.findLast(timer => timer.active && timer.ms === 150); next.active = false;
  const fresh = next.callback();
  reads[1].resolve([{ index: 0, count: 3, problem: null }]); await fresh;
  reads[0].resolve([{ index: 0, count: 99, problem: null }]); await old;
  assertEquals(rig.editor.preview().n, 3);
  rig.editor.dispose(); assert(reads[1].signal.aborted);
});

Deno.test("cohort preview: over-limit count is display data, never Run admission", async () => {
  let captures = 0;
  const problem = { code: "too-many", message: `1020 jobs for this image; the limit is ${MAX_JOBS_PER_IMAGE} per image.` };
  const rig = editorRig({ plan: async () => [{ index: 0, count: 1020, problem }], history: { capture() { captures++; } } });
  await settle(rig);
  assertEquals(rig.editor.preview().n, 1020); assertEquals(rig.editor.preview().overLimit, true);
  assertEquals(rig.editor.preview().message, problem.message);
  assertEquals(rig.editor.targetProblem("fake:image.png"), problem);
  assertEquals(rig.editor.canRun(), false); assertEquals((await rig.editor.run()).status, "invalid");
  assertEquals(captures, 0); rig.editor.dispose();
});

Deno.test("cohort preview: blank problem messages reject the response instead of a silent zero", async () => {
  const rig = editorRig({ plan: async () => [{ index: 0, count: 0, problem: { code: "no-work", message: " " } }] });
  await settle(rig);
  assertEquals(rig.editor.preview().n, null); assertEquals(rig.editor.preview().message, "Cohort plan unavailable");
  assertEquals(rig.editor.canRun(), false); rig.editor.dispose();
});

Deno.test("cohort preview: actionable destination conflicts precede planner problems, including after a blocked Run", async () => {
  let problem = { code: "missing-class", message: "Not installed on other: Text." };
  const rig = editorRig({ plan: async () => [{ index: 0, count: problem ? 0 : 1, problem }] });
  const other = { ...rig.context.origin, source: "other", address: "other:8188" };
  rig.editor.setDestination(other);
  const conflicts = { "choice.value": { kind: "value", current: "first", choices: ["second"], suggestions: ["second"] },
    "text.text": { kind: "node", type: "Text" } };
  rig.editor.installCatalogue({ ...rig.catalogue, destination: { origin: other, conflicts, unchecked: ["n.steps"] } });
  await settle(rig);
  assertEquals(rig.editor.preview().message, "Resolve 2 conflicts with other before running.");
  assertEquals(rig.editor.preview().status, "conflict");
  assertEquals(rig.editor.targetProblem("fake:image.png"), problem, "target detail keeps the planner's problem");
  assertEquals((await rig.editor.run()).status, "invalid");
  assert(rig.editor.resolveConflict("choice.value", "second"));
  await settle(rig);
  assertEquals(rig.editor.preview().message, "Resolve 1 conflict with other before running.");
  const status = runStatus({ preview: rig.editor.preview(), result: rig.editor.result() });
  assertEquals(status.items[0].text, "Resolve 1 conflict with other before running.");
  assertEquals(status.items[0].class, "vz-readiness-error");
  problem = null;
  rig.editor.setDestination(rig.context.origin);
  rig.editor.installCatalogue({ ...rig.catalogue, destination: { origin: rig.context.origin, conflicts: {}, unchecked: [] } });
  await settle(rig);
  assertEquals(rig.editor.preview().message, ""); assertEquals(rig.editor.preview().status, "ready");
  assertEquals(rig.editor.preview().n, 1); assertEquals(rig.editor.canRun(), true);
  rig.editor.dispose();
});

for (const newerEdits of [false, true]) Deno.test(`cohort settlement: ${newerEdits ? "newer edits retain the captured target and queued outcome" : "unchanged revision removes the queued target"}`, async () => {
  const baseline = editorRig(); baseline.editor.dispose();
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const history = {
    capture: async () => ({}),
    plans(ticket) {
      const target = ticket.targets[0], compiled = compileRecipe(ticket.snapshot, { catalogue: baseline.catalogue, target });
      const request = { id: target.id, host: target.host, filename: target.filename, ...compiled.payload, context: baseline.context,
        acknowledgement: { version: 2, runId: ticket.runId, requestId: crypto.randomUUID() },
        history: { id: ticket.runId, snapshotHash: "a".repeat(64), targetIndex: 0, planHash: "b".repeat(64) } };
      return { plans: [{ target, request, expectedTotal: 1 }], leftovers: [] };
    },
    finish() {},
  };
  const rig = editorRig({ history, run: async request => {
    enter(); await gate;
    const response = await baseline.services.run(request);
    return { ...response, data: { ...response.data, history: request.history } };
  } });
  rig.editor.setEnabled("n.denoise", true);
  rig.editor.edit("numeric", "n.denoise", "mode", "value"); rig.editor.edit("numeric", "n.denoise", "value", "0.9");
  const running = rig.editor.run(); await entered;
  if (newerEdits) rig.editor.edit("numeric", "n.denoise", "value", "0.8");
  release(); const result = await running;
  assertEquals(result.submitted, 1); assertEquals(result.adopted, !newerEdits);
  assertEquals(rig.editor.targets().length, newerEdits ? 1 : 0);
  assertEquals(rig.editor.targetOutcome("fake:image.png"), newerEdits ? { state: "queued", message: "Queued 1 job" } : null);
  assertEquals(rig.editor.rows("numeric")["n.denoise"].value, newerEdits ? "0.8" : "0.9");
  assertEquals(rig.editor.dirty(), newerEdits);
  assertEquals(rig.timers.filter(timer => timer.active && timer.ms === 3000).length, newerEdits ? 0 : 1);
  if (!newerEdits) {
    rig.editor.edit("numeric", "n.denoise", "value", "0.8");
    assertEquals(rig.editor.targets().map(target => target.id), ["fake:image.png"], "a newer edit during the successful close countdown restores its issued subject");
    assertEquals(rig.editor.targetOutcome("fake:image.png"), { state: "queued", message: "Queued 1 job" });
    assertEquals(rig.editor.dirty(), true);
    assertEquals(rig.timers.filter(timer => timer.active && timer.ms === 3000).length, 0);
  }
  rig.editor.dispose();
});

Deno.test("cohort preview: the count is busy from the debounced request through its reply, settled otherwise", async () => {
  const reads = [];
  const rig = editorRig({ plan: () => new Promise(resolve => reads.push(resolve)) });
  assertEquals([rig.editor.preview().busy, rig.editor.preview().display], [true, "--"], "debounced, not yet sent");
  const timer = rig.timers.findLast(timer => timer.active && timer.ms === 150); timer.active = false;
  const sent = timer.callback();
  assertEquals(rig.editor.preview().busy, true, "in flight");
  reads[0]([{ index: 0, count: 0, problem: { code: "no-work", message: "Choose a different value." } }]); await sent;
  assertEquals([rig.editor.preview().busy, rig.editor.preview().display], [false, "0"]);
  rig.editor.setEnabled("n.denoise", true);
  assertEquals(rig.editor.preview().busy, true, "an edit reschedules the plan");
  rig.editor.edit("naming", "root", "prefix", "{{unknown}}");
  assertEquals([rig.editor.preview().status, rig.editor.preview().busy], ["invalid", false], "an invalid recipe shows its final marker");
  rig.editor.dispose();
});
