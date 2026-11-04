import { assert, assertEquals } from "jsr:@std/assert";
import { objectInfo } from "../src/backings/comfy.mjs";
import { parameterCatalogue, mutateGraph, register } from "../src/features/variations/server.mjs";
import { catalogueParams, paramId } from "../src/features/variations/shared.mjs";
import { makeCollectionLifecycle } from "../src/backings/index.mjs";

const fixture = JSON.parse(await Deno.readTextFile(new URL("./fixtures/dynamic-combos.json", import.meta.url)));
const recorded = JSON.parse(await Deno.readTextFile(new URL("./fixtures/workflow-progress.json", import.meta.url)));
const schema = async (raw = fixture.objectInfo) => await objectInfo("fixture.invalid", new Map(), { fetcher: () => Response.json(raw) });
const mode = paramId("459:500", "sampling_mode"), temperature = paramId("459:500", "sampling_mode.temperature");

function rig(graph, info) {
  const routes = new Map(), jobs = [], lifecycle = makeCollectionLifecycle({ fake: "fixture.invalid:8188" });
  const token = lifecycle.capture("fake"), origin = { source: "fake", address: token.address, kind: "comfy", epoch: "test", incarnation: token.incarnation };
  register({ store: { hashFor: () => "a".repeat(64) }, ingest: { graph: async () => graph },
    backings: { accepting: () => true, capture: lifecycle.capture, isCurrent: lifecycle.isCurrent,
      source: () => ({ ...origin, sourceVersion: origin }), comfy: () => ({ objectInfo: async () => info,
        enqueue: async job => { jobs.push(job); return { ok: true, acceptance: "confirmed", promptId: "accepted-" + jobs.length }; } }) },
    route: (method, path, handler) => routes.set(method + path, handler) });
  return { jobs, probe: async () => (await routes.get("GET/probe/<id>")(new Request("http://x/probe"), { id: "fake:dynamic.png" })).json(),
    run: async (imageParams, ranges = {}) => {
      const probe = await routes.get("GET/probe/<id>")(new Request("http://x/probe"), { id: "fake:dynamic.png" });
      return routes.get("POST/run")(new Request("http://x/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        id: "fake:dynamic.png", host: "fake", filename: "dynamic.png", context: (await probe.json()).context,
        imageParams, ranges, prefix: "v_", suffix: "", acknowledgement: { version: 2, runId: crypto.randomUUID(), requestId: crypto.randomUUID() },
      }) }));
    } };
}

Deno.test("dynamic combo: object_info gives an enum row and declared float sub-inputs, including optional ones", async () => {
  const info = await schema(), r = rig(fixture.graph, info), probe = await r.probe();
  assertEquals(info.enums.get("TextGenerate.sampling_mode"), ["on", "off"]);
  assertEquals(probe.enumParams.find(p => p.id === mode)?.values, ["on", "off"]);
  assert(!probe.textParams.some(p => p.id === mode));
  for (const key of ["temperature", "min_p", "repetition_penalty", "presence_penalty"]) {
    assertEquals(probe.params.find(p => p.key === "sampling_mode." + key)?.integer, false);
  }
  assertEquals(probe.params.find(p => p.key === "sampling_mode.top_k")?.integer, true);
});

Deno.test("dynamic combo: switching off drops all old sub-inputs in the enqueued prompt", async () => {
  const r = rig(fixture.graph, await schema()), before = structuredClone(fixture.graph);
  const response = await r.run({ [mode]: { enabled: true, values: ["on", "off"] } }), result = await response.json();
  assertEquals(response.status, 200); assertEquals(result.submitted, 1); assertEquals(result.acknowledgement.accepted.length, 1);
  assertEquals(r.jobs[0].prompt["459:500"].inputs, { sampling_mode: "off" });
  assertEquals(fixture.graph, before);
});

Deno.test("dynamic combo: switching on installs required and optional defaults, explicit active floats override them", async () => {
  const graph = structuredClone(fixture.graph); graph["459:500"].inputs.sampling_mode = "off";
  // Retained stale input must not be reused as the new branch's default.
  const r = rig(graph, await schema());
  const response = await r.run({ [mode]: { enabled: true, values: ["on"] } }, { [temperature]: { enabled: true, min: .55, max: .55, increment: .01 } });
  assertEquals(response.status, 200);
  assertEquals(r.jobs[0].prompt["459:500"].inputs, { sampling_mode: "on", "sampling_mode.temperature": .55,
    "sampling_mode.top_k": 64, "sampling_mode.top_p": .95, "sampling_mode.min_p": .05,
    "sampling_mode.repetition_penalty": 1.05, "sampling_mode.seed": 0, "sampling_mode.presence_penalty": 0 });
});

Deno.test("dynamic combo: unchanged branch preserves current settings and accepts fractional variations", async () => {
  const r = rig(fixture.graph, await schema());
  const response = await r.run({ [mode]: { enabled: true, values: ["on"] } }, { [temperature]: { enabled: true, min: .55, max: .55, increment: .01 } });
  assertEquals(response.status, 200);
  assertEquals(r.jobs[0].prompt["459:500"].inputs, { ...fixture.graph["459:500"].inputs, "sampling_mode.temperature": .55 });
});

Deno.test("dynamic combo: a prompt with no old children gets every selected-branch default", async () => {
  const graph = structuredClone(fixture.graph); graph["459:500"].inputs = { sampling_mode: "off" };
  const r = rig(graph, await schema()), response = await r.run({ [mode]: { enabled: true, values: ["on"] } });
  assertEquals(response.status, 200);
  assertEquals(r.jobs[0].prompt["459:500"].inputs, { sampling_mode: "on", "sampling_mode.temperature": .7,
    "sampling_mode.top_k": 64, "sampling_mode.top_p": .95, "sampling_mode.min_p": .05,
    "sampling_mode.repetition_penalty": 1.05, "sampling_mode.seed": 0, "sampling_mode.presence_penalty": 0 });
});

Deno.test("dynamic combo: unknown required defaults reject without guessing or enqueuing", async () => {
  const raw = structuredClone(fixture.objectInfo);
  delete raw.TextGenerate.input.required.sampling_mode[1].options[0].inputs.required.temperature[1].default;
  const graph = structuredClone(fixture.graph); graph["459:500"].inputs = { sampling_mode: "off" };
  const r = rig(graph, await schema(raw)), response = await r.run({ [mode]: { enabled: true, values: ["on"] } });
  assertEquals(response.status, 400); assertEquals(r.jobs, []);
  assert((await response.json()).error.includes("No object_info default"));
});

Deno.test("dynamic combo: recorded target_frame branch adds its default and leaving it removes the child only on that node", async () => {
  const info = await schema(recorded.objectInfo), graph = {
    a: { class_type: "ColorTransfer", inputs: { source_stats: "uniform", strength: 1 } },
    b: { class_type: "ColorTransfer", inputs: { source_stats: "target_frame", "source_stats.target_index": 7, strength: 1 } },
  }, params = catalogueParams(parameterCatalogue(graph, info));
  const next = mutateGraph(graph, { "a.source_stats": "target_frame", "b.source_stats": "per_frame" }, params, info.dynamicCombos).graph;
  assertEquals(next.a.inputs, { source_stats: "target_frame", "source_stats.target_index": 0, strength: 1 });
  assertEquals(next.b.inputs, { source_stats: "per_frame", strength: 1 });
  assertEquals(graph.b.inputs["source_stats.target_index"], 7);
});

Deno.test("dynamic combo: an inactive requested child or unknown later option rejects the whole plan before enqueue", async () => {
  for (const values of [["on", "off"], ["off", "missing"]]) {
    const r = rig(fixture.graph, await schema());
    const response = await r.run({ [mode]: { enabled: true, values } }, values[1] === "off"
      ? { [temperature]: { enabled: true, min: .5, max: .5, increment: .1 } } : {});
    assertEquals(response.status, 400); assertEquals(r.jobs, []);
    assertEquals((await response.json()).submitted, 0);
  }
});
