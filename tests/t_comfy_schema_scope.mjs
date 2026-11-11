import { assert, assertEquals } from "jsr:@std/assert";
import { objectInfo } from "../src/backings/comfy.mjs";
import { parseExactJson } from "../src/parameters.mjs";
import { Jobs } from "../src/jobs.mjs";
import { typedRunRig } from "./helpers/typed-run.mjs";

const graph = {
  sampler: { class_type: "Sampler", inputs: { seed: 0 } },
  save: { class_type: "SaveImageAdvanced", inputs: { images: ["sampler", 0], filename_prefix: "source" } },
};
const normal = {
  Sampler: { input: { required: { seed: ["INT", { default: 0 }] } }, output: ["IMAGE"] },
  SaveImageAdvanced: { output_node: true, input: { required: { images: ["IMAGE"], filename_prefix: ["STRING"] } }, output: [] },
};
function oversized() {
  return { input: { required: { items: [Array.from({ length: 100_001 }, (_, i) => "option" + i)] } } };
}
function tooDeep() {
  let input = { required: { n: ["INT"] } };
  for (let i = 0; i < 40; i++) input = { required: { mode: ["COMFY_DYNAMICCOMBO_V3", { options: [{ key: "on", inputs: input }] }] } };
  return { input };
}

Deno.test("schema scope: unrelated oversized and malformed classes cannot erase graph evidence", async () => {
  const info = await objectInfo("fixture", new Map(), { graph, fetcher: () => Response.json({ Huge: oversized(), Deep: tooDeep(), ...normal }) });
  assert(info.outputClasses?.has("SaveImageAdvanced"));
  assertEquals(info.types.get("Sampler.seed"), "INT");
  assertEquals(info.declarations.size, 3);
  assertEquals([...info.lazyInputs.keys()], ["Sampler", "SaveImageAdvanced"]);
});

Deno.test("schema scope: cached raw catalogue survives failed views and changing graph classes", async () => {
  let calls = 0;
  const cache = new Map(), fetcher = () => { calls++; return Response.json({ Huge: oversized(), ...normal }); };
  const full = await objectInfo("fixture", cache, { fetcher });
  assertEquals(full.outputClasses, null);
  const scoped = await objectInfo("fixture", cache, { fetcher, graph });
  assert(scoped.outputClasses?.has("SaveImageAdvanced"));
  const reordered = { b: graph.save, a: graph.sampler, repeated: graph.sampler };
  assertEquals(await objectInfo("fixture", cache, { fetcher, graph: reordered }), scoped);
  const other = await objectInfo("fixture", cache, { fetcher, graph: { a: graph.sampler } });
  assertEquals([...other.lazyInputs.keys()], ["Sampler"]);
  assertEquals((await objectInfo("fixture", cache, { fetcher })).types, null);
  assertEquals(calls, 1, "all views share the address catalogue, including failures");
});

Deno.test("schema scope: requested views still enforce atomic aggregate and depth limits", async () => {
  for (const [type, def, reason] of [["Huge", oversized(), "budget"], ["Deep", tooDeep(), "nesting"]]) {
    const result = await objectInfo("fixture", new Map(), { graph: { normal: graph.save, bad: { class_type: type } }, fetcher: () => Response.json({ ...normal, [type]: def }) });
    assertEquals(result.outputClasses, null);
    assertEquals(result.declarations, null);
    assert(result.schemaError?.includes(reason), "actual failure remains distinguishable from no output");
  }
});

Deno.test("schema scope: empty and missing class views never materialize unrelated declarations", async () => {
  for (const selected of [{}, { missing: { class_type: "Missing" } }]) {
    const info = await objectInfo("fixture", new Map(), { graph: selected, fetcher: () => Response.json(normal) });
    assertEquals(info.outputClasses.size, 0);
    assertEquals(info.lazyInputs.size, 0);
    assertEquals(info.declarations.size, 0);
  }
});

Deno.test("schema scope: catalogue TTL refreshes views and failed HTTP reads retain their reason", async () => {
  const cache = new Map(); let calls = 0;
  const fetcher = () => { calls++; return calls === 2 ? new Response("offline", { status: 503 }) : Response.json(normal); };
  const first = await objectInfo("fixture", cache, { graph, fetcher });
  assert(first.outputClasses.has("SaveImageAdvanced"));
  cache.get("fixture").t = Date.now() - 60_001;
  const unavailable = await objectInfo("fixture", cache, { graph, fetcher });
  assertEquals(unavailable.outputClasses, null); assert(unavailable.schemaError.includes("503"));
  const recovered = await objectInfo("fixture", cache, { graph, fetcher });
  assert(recovered.outputClasses.has("SaveImageAdvanced"));
  assertEquals(calls, 3, "failed acquisition cannot replace a successful catalogue for the TTL");
});

Deno.test("schema scope: cancellation, transport and malformed replies never poison other consumers", async () => {
  for (const fail of [
    signal => { signal.throwIfAborted(); },
    () => { throw new TypeError("network unavailable"); },
    () => new Response("not JSON"),
    () => Response.json([]),
  ]) {
    const cache = new Map(), controller = new AbortController();
    controller.abort();
    const unavailable = await objectInfo("fixture", cache, { graph, signal: controller.signal,
      fetcher: (_url, { signal }) => fail(signal) });
    assertEquals(unavailable.outputClasses, null); assert(unavailable.schemaError);
    assertEquals(cache.size, 0);
    const recovered = await objectInfo("fixture", cache, { graph, fetcher: () => Response.json(normal) });
    assert(recovered.outputClasses.has("SaveImageAdvanced"));
  }
  const cache = new Map(); let release;
  const pending = objectInfo("fixture", cache, { graph, fetcher: () => new Promise(resolve => { release = resolve; }) });
  const accepted = await objectInfo("fixture", cache, { graph, fetcher: () => Response.json(normal) });
  release(new Response("offline", { status: 503 }));
  assertEquals((await pending).outputClasses, null);
  assertEquals(await objectInfo("fixture", cache, { graph, fetcher: () => { throw new Error("must reuse success"); } }), accepted);
});

Deno.test("schema scope: Variations passes its graph and submits all 21 fake final prompts", async () => {
  const cache = new Map(); let calls = 0;
  const rig = typedRunRig({ graph, objectInfo: options => {
    assertEquals(options?.graph, graph, "probe and Run must supply the actual original graph");
    return objectInfo("fixture", cache, { ...options, fetcher: () => { calls++; return Response.json({ Huge: oversized(), ...normal }); } });
  } });
  const request = await rig.request({}, { "sampler.seed": { enabled: true, min: 1, max: 21, increment: 1 } });
  const { status, data } = await rig.run(request);
  assertEquals(status, 200); assertEquals(data.submitted, 21); assertEquals(data.acknowledgement.accepted.length, 21);
  assertEquals(calls, 1);
  assertEquals(rig.bytes.map(body => parseExactJson(body).prompt.sampler.inputs.seed), Array.from({ length: 21 }, (_, i) => i + 1));
  for (const body of rig.bytes) assertEquals(parseExactJson(body).prompt.save.inputs.filename_prefix, "manual_source_00001_");
});

Deno.test("schema scope: unavailable output evidence reports the real reason before enqueue", async () => {
  const rig = typedRunRig({ graph, schema: { outputClasses: null, schemaError: "ComfyUI object_info expansion budget exceeded" } });
  const { status, data } = await rig.run(await rig.request({}, { "sampler.seed": { enabled: true, min: 1, max: 1, increment: 1 } }));
  assertEquals(status, 502); assert(data.error.includes("node information")); assert(data.error.includes("budget"));
  assertEquals(rig.bytes.length, 0);
});

Deno.test("schema scope: workflow reads capture graph and reject old prompt schema", async () => {
  const scopes = [], releases = [];
  let prompt = "first";
  const second = { next: { class_type: "Next", inputs: {} } };
  const jobs = new Jobs({ hosts: { test: "fixture" }, setTimer: () => 1, clearTimer() {}, client: () => ({
    queue: async () => ({ running: [prompt], pending: [], prompts: new Map([[prompt, { graph: prompt === "first" ? graph : second, outputs: [prompt === "first" ? "save" : "next"] }]]) }),
    history: async () => [], logs: async () => ({ entries: [], size: 0 }),
    objectInfo: options => { scopes.push(options?.graph); return new Promise(resolve => releases.push(resolve)); },
  }) });
  try {
    await jobs.tick(); assertEquals(scopes[0], graph);
    prompt = "second"; await jobs.tick();
    assertEquals(jobs.monitors.get("fixture").live.info, null);
    releases[0]({ lazyInputs: new Map([["Sampler", new Set()]]) });
    await jobs.monitors.get("fixture").infoTask;
    assertEquals(jobs.monitors.get("fixture").live.info, null, "old graph's view cannot decorate a new prompt");
    await jobs.tick(); assertEquals(scopes.at(-1), second);
    releases.at(-1)({ lazyInputs: new Map([["Next", new Set()]]) });
    await jobs.monitors.get("fixture").infoTask;
    assert(jobs.monitors.get("fixture").live.info.lazyInputs.has("Next"));
  } finally { for (const release of releases) release({}); await jobs.stop(); }
});
