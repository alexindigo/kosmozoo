import { assert, assertEquals, assertThrows } from "jsr:@std/assert";
import { WorkflowProgress, ProgressConnection } from "../src/workflow-progress.mjs";
import { Jobs } from "../src/jobs.mjs";
import { comfyClient } from "../src/backings/comfy.mjs";
import { dependencyClosure } from "../src/graph.mjs";
import { validateSourceSnapshot } from "../client/js/source-events.mjs";
import { sourceFrame } from "./helpers/source-stream.mjs";

const graph = {
  "1": { class_type: "LoadImage", inputs: { image: "fixture.png" } },
  "2": { class_type: "ImageScale", inputs: { image: ["1", 0] } },
  "3": { class_type: "SaveImage", inputs: { images: ["2", 0] } },
  unused: { class_type: "LoadImage", inputs: {} },
};
const info = { lazyInputs: new Map(Object.values(graph).map(n => [n.class_type, new Set()])) };
const state = (nodes, prompt = "p") => ({ type: "progress_state", data: { prompt_id: prompt, nodes } });
const node = (state = "running", value = 0, max = 1) => ({ state, value, max });
function model() {
  const m = new WorkflowProgress(); m.configure("p", { graph, outputs: ["3"] }); m.info = info; return m;
}

Deno.test("workflow: static closure, cached prefix inference, fractional work and authoritative completion cap", () => {
  const m = model();
  assertEquals([...dependencyClosure(graph, ["3"])], ["3", "2", "1"]);
  assertEquals(m.workflow(), null, "another tab / old server has no observed events");
  m.receive(state({ "1": node("running", 1, 2) }));
  assertEquals(m.workflow(), { promptId: "p", done: .5, total: 3, fraction: 1 / 6, basis: "graph+events" });
  m.receive(state({ "2": node("running", 1, 4) }));
  assertEquals(m.workflow().done, 1.25, "the cached input is inferred through strong links");
  m.receive(state({ "2": node("running", 0, 4) }));
  assertEquals(m.workflow().done, 1.25, "a restarted counter cannot move the outer ring backwards");
  m.receive(state({ "3": node("finished", 1, 1), "expanded.1": node("finished") }));
  assert(m.workflow().fraction < 1);
  assert(m.workflow().fraction > .9999);
  assertEquals(m.workflow().total, 3, "expanded and unrelated submitted nodes do not enter S");
  m.configure(null); assertEquals(m.workflow(), null);
});

Deno.test("workflow: lazy ancestors require their own finished event, not a consumer start", () => {
  const m = new WorkflowProgress();
  m.configure("p", { graph: { ...graph, "2": { class_type: "Switch", inputs: { selected: ["1", 0] } } }, outputs: ["3"] });
  m.info = { lazyInputs: new Map([...info.lazyInputs, ["Switch", new Set(["selected"])]]) };
  m.receive(state({ "3": node() }));
  assertEquals(m.workflow().done, 1, "strong parent 2 done; its lazy parent 1 is not inferred");
  m.receive(state({ "1": node("finished"), "3": node() }));
  assertEquals(m.workflow().done, 2);
});

Deno.test("workflow: missing graph/outputs/catalogue, malformed events, foreign prompt and binary data remain unavailable", () => {
  for (const descriptor of [null, { graph }, { graph, outputs: [] }, { graph, outputs: ["missing"] }]) {
    const m = new WorkflowProgress(); m.configure("p", descriptor); m.info = info;
    m.receive(state({ "1": node() })); assertEquals(m.workflow(), null);
  }
  const m = model(); m.info = null; m.receive(state({ "1": node() })); assertEquals(m.workflow(), null);
  m.info = info; m.receive(state({ "1": node() }, "foreign")); assertEquals(m.workflow(), null);
  m.receive(state({ "1": node("running", 2, 0) })); assertEquals(m.workflow(), null);
  m.receive(state({ "1": node() })); assert(m.workflow());
  m.disconnect(); assertEquals(m.workflow(), null); assertEquals(m.operation(), null);
  m.receive(state({ "2": node() })); assertEquals(m.workflow().done, 1);
  m.configure("new", { graph, outputs: ["3"] }); assertEquals(m.workflow(), null);
});

Deno.test("workflow: old prompt log retirement cannot discard a new prompt's already received events", () => {
  const m = model();
  m.receive(state({ "2": node("running", 1, 4) }, "next"));
  m.receive({ type: "progress", data: { prompt_id: "next", node: "2", value: 1, max: 4 } });
  m.disconnect("p");
  m.configure("next", { graph, outputs: ["3"] });
  assertEquals(m.workflow()?.done, 1.25);
  assertEquals(m.operation().fraction, .25);
  m.disconnect("next"); assertEquals(m.workflow(), null); assertEquals(m.operation(), null);
});

function socketRig() {
  const sockets = [], timers = new Map(); let serial = 0;
  const timer = (fn, delay) => { const id = ++serial; timers.set(id, { fn, delay }); return id; };
  const clear = id => timers.delete(id);
  const open = () => {
    const socket = { close() { this.closed = true; this.onclose?.(); },
      send() { throw new Error("telemetry must never send"); }, message(data) { this.onmessage?.({ data }); } };
    sockets.push(socket); return socket;
  };
  return { sockets, timers, timer, clear, open };
}

Deno.test("Jobs: retiring old prompt logs cannot erase the next prompt's already received progress", async () => {
  const r = socketRig(); let running = ["p"], release;
  const log = new Promise(resolve => release = resolve);
  const jobs = new Jobs({ hosts: { a: "fake:1" }, setTimer: r.timer, clearTimer: r.clear,
    client: () => ({ progressSocket: r.open, objectInfo: async () => info,
      queue: async () => ({ running, pending: [], prompts: new Map(["p", "next"].map(id => [id, { graph, outputs: ["3"] }])) }),
      history: async () => [], logs: () => log }) });
  try {
    jobs.start(); r.sockets[0].onopen(); await jobs.tick();
    r.sockets[0].message(JSON.stringify(state({ "2": node("running", 1, 4) }, "next")));
    r.sockets[0].message(JSON.stringify({ type: "progress", data: { prompt_id: "next", node: "2", value: 1, max: 4 } }));
    running = ["next"];
    const oldFlight = jobs.monitors.get("fake:1").progressTask;
    release({ entries: [], size: 0 }); await oldFlight;
    await jobs.tick();
    assertEquals(jobs.snapshot("a").workflow?.done, 1.25);
    assertEquals(jobs.snapshot("a").progress?.fraction, .25);
  } finally { release({ entries: [], size: 0 }); await jobs.stop(); }
});

Deno.test("workflow socket: read-only, previews ignored, bounded reconnect, timeout and stop", async () => {
  const r = socketRig(), received = []; let lost = 0;
  const c = new ProgressConnection({ open: r.open, receive: m => received.push(m), lost: () => lost++, setTimer: r.timer, clearTimer: r.clear });
  r.sockets[0].onopen();
  r.sockets[0].message(new Uint8Array([1, 2])); r.sockets[0].message("invalid");
  r.sockets[0].message(" ".repeat(1024 * 1024 + 1));
  r.sockets[0].message(JSON.stringify(state({ "1": node() })));
  assertEquals(received.length, 1);
  r.sockets[0].close(); assertEquals(lost, 1);
  assertEquals([...r.timers.values()].map(t => t.delay), [1000]);
  for (let n = 0; n < 8; n++) {
    const [id, t] = [...r.timers][0]; r.timers.delete(id); t.fn();
    r.sockets.at(-1).close();
  }
  assertEquals([...r.timers.values()].map(t => t.delay), [30000]);
  await c.stop(); assertEquals(r.timers.size, 0);
  const r2 = socketRig();
  const c2 = new ProgressConnection({ open: r2.open, receive() {}, lost() {}, setTimer: r2.timer, clearTimer: r2.clear });
  [...r2.timers.values()][0].fn(); assert(r2.sockets[0].closed, "unopened connection has a deadline");
  await c2.stop();
});

Deno.test("Jobs: one socket per alias address, exact operation wins logs, loss never changes queue state or completion", async () => {
  const r = socketRig(), hosts = { a: "fake:1", alias: "fake:1" };
  let running = ["p"], history = [], logs = { entries: [{ t: 1, m: "0/10" }], size: 1 }, finishes = 0;
  const jobs = new Jobs({ hosts, setTimer: r.timer, clearTimer: r.clear, onFinish: () => finishes++,
    client: () => ({ progressSocket: r.open, objectInfo: async () => info,
      queue: async () => ({ running, pending: [], prompts: new Map([["p", { graph, outputs: ["3"] }]]) }),
      history: async () => history, logs: async () => logs }) });
  jobs.start(); assertEquals(r.sockets.length, 1); r.sockets[0].onopen();
  await jobs.tick();
  logs = { entries: [{ t: 1, m: "0/10" }, { t: 1, m: "1/10" }], size: 2 }; await jobs.tick();
  assertEquals(jobs.snapshot("a").progressBasis, "log");
  r.sockets[0].message(JSON.stringify(state({ "2": node("running", 1, 4) })));
  r.sockets[0].message(JSON.stringify({ type: "progress", data: { prompt_id: "p", node: "2", value: 2, max: 4 } }));
  assertEquals(jobs.snapshot("a").progressBasis, "exact");
  assertEquals(jobs.snapshot("a").progress.fraction, .5);
  await jobs.tick(); assertEquals(jobs.snapshot("a").progress.fraction, .5, "log flight cannot overwrite exact");
  assertEquals(jobs.snapshot("alias"), jobs.snapshot("a"));
  const copy = jobs.snapshot("a"); copy.workflow.fraction = 42;
  assert(jobs.snapshot("a").workflow.fraction < 1);
  r.sockets[0].close();
  assertEquals(jobs.snapshot("a").state, "running"); assertEquals(jobs.snapshot("a").workflow, null);
  assertEquals(jobs.snapshot("a").progressBasis, "log");
  running = []; history = [{ id: "p", terminal: true, outcome: "success" }];
  await jobs.tick(); assertEquals(finishes, 1); assertEquals(jobs.snapshot("a").state, "idle");
  assertEquals(jobs.snapshot("a").workflow, null);
  delete hosts.a; jobs.reconcile(); delete hosts.alias; jobs.reconcile();
  await jobs.stop(); assertEquals(r.timers.size, 0);
});

Deno.test("workflow backing: lazy flags use the same cached object_info and queue graph stays private", async () => {
  let calls = 0;
  const client = comfyClient("fake:1", { fetcher: async url => {
    calls++;
    return Response.json(url.endsWith("object_info")
      ? { Switch: { input: { required: { image: ["IMAGE", { lazy: true }] } } } }
      : { queue_running: [[0, "p", graph, { client_id: "secret-tab-id" }, ["3"]]], queue_pending: [] });
  } });
  const a = await client.objectInfo(); await client.objectInfo(); assertEquals(calls, 1);
  assertEquals([...a.lazyInputs.get("Switch")], ["image"]);
  const queue = await client.queue(); assertEquals(queue.prompts.get("p").outputs, ["3"]);
  assert(!JSON.stringify([...queue.prompts]).includes("secret-tab-id"));
  await client.disposeInventory();
});

Deno.test("workflow source stream: additive group validates atomically, rejecting stale, inconsistent or unlabelled data", () => {
  const activity = { state: "running", runningCount: 1, runningPromptId: "p", progress: null,
    progressBasis: null, workflowReason: "unavailable",
    workflow: { promptId: "p", done: 1.5, total: 3, fraction: .5, basis: "graph+events" } };
  assert(validateSourceSnapshot(sourceFrame({ a: { activity } })));
  for (const change of [w => w.workflow.promptId = "old", w => w.workflow.total = 0,
    w => w.workflow.fraction = 1, w => w.workflow.done = 2, w => w.workflow.basis = "exact",
    w => delete w.progressBasis, w => w.progressBasis = "log", w => w.state = "idle"]) {
    const invalid = structuredClone(activity); change(invalid);
    assertThrows(() => validateSourceSnapshot(sourceFrame({ a: { activity: invalid } })));
  }
});

Deno.test("Jobs: a held object_info cannot delay finish publication or stop", async () => {
  const r = socketRig(); let running = ["p"], history = [], finished = 0;
  const jobs = new Jobs({ hosts: { a: "mock:1" }, setTimer: r.timer, clearTimer: r.clear,
    onFinish: () => finished++, client: () => ({
      queue: async () => ({ running, pending: [], prompts: new Map([["p", { graph, outputs: ["3"] }]]) }),
      history: async () => history, logs: async () => ({ entries: [], size: 0 }),
      objectInfo: () => new Promise(() => {}),
    }) });
  await jobs.tick();
  running = []; history = [{ id: "p", terminal: true, outcome: "success" }];
  await jobs.tick(); assertEquals(finished, 1); assertEquals(jobs.snapshot("a").workflow, null);
  await jobs.stop();
});
