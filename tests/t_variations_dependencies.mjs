import { assert, assertEquals } from "jsr:@std/assert";
import { narrowToOneOutputNode, register } from "../src/features/variations/server.mjs";
import { makeCollectionLifecycle } from "../src/backings/index.mjs";

// The reported graph, with only filenames and prompt text replaced. Both lazy
// branches remain; PreviewAny is an output node AND an upstream dependency.
const fixture = JSON.parse(await Deno.readTextFile(new URL("./fixtures/variation-output-dependency.json", import.meta.url)));
const outputs = new Set(["SaveImageAdvanced", "PreviewAny", "ImageCompare"]);
function assertLinksResolve(graph) {
  for (const [id, node] of Object.entries(graph)) {
    for (const [key, value] of Object.entries(node.inputs ?? {})) {
      if (Array.isArray(value) && value.length === 2 && Number.isInteger(value[1])) {
        assert(Object.hasOwn(graph, value[0]), `${id}.${key} references missing ${value[0]}`);
      }
    }
  }
}

Deno.test("variation dependencies: real PreviewAny ancestor survives, unrelated ImageCompare drops, every link resolves", () => {
  const graph = structuredClone(fixture);
  const result = narrowToOneOutputNode(graph, "461", "Qwen_image_2.1_00036", "v_", "_edit", outputs);
  assertEquals(result, { kept: 2, dropped: 1 });
  assertEquals(graph["459:480"], fixture["459:480"]);
  assert(!Object.hasOwn(graph, "472"));
  assertEquals(graph["459:500"], fixture["459:500"], "inactive lazy branch remains intact");
  assertEquals(graph["461"].inputs.filename_prefix, "v_Qwen_image_2.1_00036_edit");
  assertLinksResolve(graph);
});

Deno.test("variation dependencies: all lazy inputs, transitive output ancestors and cycles are followed, non-outputs stay", () => {
  const graph = {
    producer: { class_type: "SaveImage", inputs: { filename_prefix: "source", images: ["switch", 0] } },
    switch: { class_type: "Switch", inputs: { select: false, on_false: ["active", 0], on_true: ["preview", 0] } },
    active: { class_type: "Image", inputs: {} },
    preview: { class_type: "PreviewAny", inputs: { value: [7, 0] } },
    7: { class_type: "PreviewAny", inputs: { value: ["cycle:8", 1] } },
    "cycle:8": { class_type: "Text", inputs: { back: ["preview", 0] } },
    other: { class_type: "PreviewAny", inputs: {} },
    disconnected: { class_type: "Text", inputs: { value: "kept", pair: ["literal", "text"], nested: { value: ["not-a-link", 0] } } },
  };
  assertEquals(narrowToOneOutputNode(graph, "producer", "source_00001", "v_", "", new Set(["SaveImage", "PreviewAny"])), { kept: 3, dropped: 1 });
  assert(Object.hasOwn(graph, "preview")); assert(Object.hasOwn(graph, "7"));
  assert(Object.hasOwn(graph, "cycle:8")); assert(Object.hasOwn(graph, "disconnected"));
  assert(!Object.hasOwn(graph, "other"));
  assertLinksResolve(graph);
});

function rig(graph, outputClasses = outputs, filename = "Qwen_image_2.1_00036.png") {
  const routes = new Map(), jobs = [], lifecycle = makeCollectionLifecycle({ fake: "in-memory:8188" });
  const token = lifecycle.capture("fake");
  const origin = { source: "fake", address: token.address, kind: "comfy", epoch: "test", incarnation: token.incarnation };
  register({ store: { hashFor: () => "a".repeat(64) }, ingest: { graph: async () => graph },
    backings: { accepting: () => true, capture: lifecycle.capture, isCurrent: lifecycle.isCurrent,
      source: () => ({ ...origin, sourceVersion: origin }), comfy: () => ({
        objectInfo: async () => ({ types: new Map(), enums: new Map(), outputClasses }),
        enqueue: async job => {
          assertLinksResolve(job.prompt);
          jobs.push(job);
          return { ok: true, acceptance: "confirmed", promptId: "accepted-" + jobs.length };
        },
      }) }, route: (method, path, handler) => routes.set(method + path, handler) });
  return { jobs, run: async () => {
    const id = "fake:" + filename;
    const probe = await routes.get("GET/probe/<id>")(new Request("http://x/probe"), { id });
    assertEquals(probe.status, 200);
    const body = { id, host: "fake", filename, context: (await probe.json()).context, ranges: {}, prefix: "v_",
      imageParams: { "470.image": { enabled: true, values: ["first.png", "second.png"] },
        "508.value": { enabled: true, values: ["first edit", "second edit"] } },
      acknowledgement: { version: 2, runId: crypto.randomUUID(), requestId: crypto.randomUUID() } };
    return routes.get("POST/run")(new Request("http://x/run", { method: "POST", body: JSON.stringify(body) }));
  } };
}

Deno.test("variation dependencies: real run submits every image/text permutation with intact output dependencies", async () => {
  const before = structuredClone(fixture), r = rig(fixture);
  const response = await r.run(), result = await response.json();
  assertEquals(response.status, 200); assertEquals(result.total, 4); assertEquals(result.submitted, 4);
  assertEquals(result.errors, []); assertEquals(result.acknowledgement.accepted.length, 4);
  assertEquals(r.jobs.length, 4);
  const pairs = new Set();
  for (const { prompt } of r.jobs) {
    assert(Object.hasOwn(prompt, "459:480")); assert(!Object.hasOwn(prompt, "472"));
    assertLinksResolve(prompt);
    pairs.add(JSON.stringify([prompt["470"].inputs.image, prompt["508"].inputs.value]));
  }
  assertEquals(pairs.size, 4); assertEquals(fixture, before);
});

Deno.test("variation dependencies: dangling links fail before enqueue in producer and fallback paths", async () => {
  for (const filename of ["Qwen_image_2.1_00036.png", "unknown.png"]) {
    const graph = structuredClone(fixture);
    graph["459:474"].inputs.prompt = ["missing:480", 0];
    const r = rig(graph, outputs, filename), response = await r.run(), result = await response.json();
    assertEquals(response.status, 200); assertEquals(result.total, 4); assertEquals(result.submitted, 0);
    assertEquals(r.jobs, []); assertEquals(result.acknowledgement.accepted, []);
    assertEquals(result.errors.length, 4);
    for (const { error } of result.errors) {
      assert(error.includes("459:474.prompt")); assert(error.includes("missing:480"));
    }
  }
});
