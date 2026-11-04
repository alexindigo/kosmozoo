import { assert, assertEquals } from "jsr:@std/assert";
import { WorkflowProgress } from "../src/workflow-progress.mjs";
import { dependencyClosure } from "../src/graph.mjs";
import { ProgressLog } from "../src/jobs.mjs";
import { Prefetch } from "../src/prefetch.mjs";

Deno.test("deepscan B workflow: all observed ancestors share linear graph work", () => {
  const count = 200, graph = {}; let reads = 0;
  for (let i = 0; i < count; i++) graph[i] = { class_type: "Node", get inputs() { reads++; return i ? { input: [String(i - 1), 0] } : {}; } };
  const m = new WorkflowProgress(); m.configure("p", { graph, outputs: [String(count - 1)] });
  m.info = { lazyInputs: new Map([["Node", new Set()]]) };
  m.receive({ type: "progress_state", data: { prompt_id: "p", nodes: Object.fromEntries(Object.keys(graph).map(id => [id, { state: "running", value: 0, max: 1 }])) } });
  reads = 0; assertEquals(m.workflow().done, count - 1);
  assert(reads <= count * 4, `ancestor inference read ${reads} node inputs`);
});

Deno.test("deepscan B workflow: union inference preserves lazy links, shared ancestors and cycles", () => {
  for (const graph of [
    { a: { inputs: {} }, b: { inputs: { x: ["a", 0] } }, c: { inputs: { x: ["a", 0], lazy: ["b", 0] } } },
    { a: { inputs: { x: ["b", 0] } }, b: { inputs: { x: ["a", 0] } }, c: { inputs: { x: ["b", 0] } } },
  ]) for (const roots of [["a"], ["b"], ["a", "b"], ["b", "c"]]) {
    for (const node of Object.values(graph)) node.class_type = "Node";
    const expected = new Set();
    for (const root of roots) { const ancestors = dependencyClosure(graph, root, (_, key) => key !== "lazy"); ancestors.delete(root); for (const id of ancestors) expected.add(id); }
    const m = new WorkflowProgress(); m.configure("p", { graph, outputs: ["a", "b", "c"] }); m.info = { lazyInputs: new Map([["Node", new Set(["lazy"])]]) };
    m.receive({ type: "progress_state", data: { prompt_id: "p", nodes: Object.fromEntries(roots.map(id => [id, { state: "running", value: 0, max: 1 }])) } });
    assertEquals(m.workflow().done, Math.min(3 * (1 - Number.EPSILON), expected.size));
  }
});

Deno.test("deepscan B logs: non-overlapping snapshots do not allocate quadratic suffix copies", () => {
  const count = 1000, log = new ProgressLog();
  log.sample({ entries: Array.from({ length: count }, (_, i) => ({ t: "old-" + i, m: "old" })) }, "p");
  const native = Array.prototype.slice; let copied = 0;
  Array.prototype.slice = function(start, ...args) { if (start < 0 && typeof this[0] === "string" && this[0].startsWith('["old-')) copied += Math.min(this.length, -start); return native.call(this, start, ...args); };
  try {
    assertEquals(log.sample({ entries: Array.from({ length: count }, (_, i) => ({ t: "new-" + i, m: "new" })) }, "p"), null);
    assert(copied <= count * 2, `allocated ${copied} suffix references`);
  } finally { Array.prototype.slice = native; }
});

Deno.test("deepscan B logs: longest repeated overlap and discontinuity retain existing progress rules", () => {
  const log = new ProgressLog(), sample = messages => log.sample({ entries: messages.map(m => ({ t: 1, m })) }, "p");
  sample(["a", "b", "a", "b", "a"]);
  assertEquals(sample(["a", "b", "a", "2/10"]), { value: 2, max: 10, fraction: .2 });
  assertEquals(sample(["a", "b", "a", "2/10"]), { value: 2, max: 10, fraction: .2 });
  assertEquals(sample(["other"]), null);
});

Deno.test("deepscan B prefetch: foreground batches compact each background lane once", () => {
  const pf = new Prefetch({ hosts: { c: "fake:1" }, store: { metaFresh: () => new Set(), dimsKnown: () => new Set() } });
  const names = Array.from({ length: 1000 }, (_, i) => `${i}.png`);
  pf.feed("c", names); const native = Array.prototype.filter; let visits = 0;
  Array.prototype.filter = function(callback, ...args) {
    if (this.length && typeof this[0] === "string" && this[0].endsWith(".png")) visits += this.length;
    return native.call(this, callback, ...args);
  };
  try {
    pf.feed("c", [...names.slice(0, 900).reverse(), ...names.slice(0, 10)], true);
    const w = pf.workers.get("c");
    assertEquals(w.walk, names.slice(900)); assertEquals(w.dimsWalk, names.slice(900));
    assertEquals(w.prio, names.slice(0, 900).reverse()); assertEquals(w.dimsPrio, w.prio);
    assertEquals(pf.pending("c"), 1000); assert(visits <= names.length * 2, `${visits} background queue visits`);
  } finally { Array.prototype.filter = native; }
});
