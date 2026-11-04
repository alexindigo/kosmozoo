import { assert, assertEquals, assertThrows } from "jsr:@std/assert";
import { generatePermutations, permutationPlan } from "../src/features/variations/shared.mjs";
import { register } from "../src/features/variations/server.mjs";
import { makeCollectionLifecycle } from "../src/backings/index.mjs";

Deno.test("deepscan B permutations: current-tuple exclusion cannot hide excessive raw traversal", () => {
  const ranges = { value: { enabled: true, min: 0, max: 5e-11, increment: 1e-16 } };
  assertEquals(permutationPlan(ranges, { value: 0 }).total, 1);
  assertThrows(() => generatePermutations(ranges, { value: 0 }), Error, "work budget");
});

Deno.test("deepscan B permutations: normal range/image tuples preserve count, order and duplicates", () => {
  const ranges = { value: { enabled: true, min: 0, max: 1, increment: .5 } };
  const images = { image: { enabled: true, values: ["current", "current", "other"] } };
  const result = generatePermutations(ranges, { value: .5, image: "current" }, images);
  assertEquals(result, [
    { value: 0, image: "current" }, { value: 0, image: "current" }, { value: 0, image: "other" },
    { value: .5, image: "other" },
    { value: 1, image: "current" }, { value: 1, image: "current" }, { value: 1, image: "other" },
  ]);
  assertEquals(permutationPlan(ranges, { value: .5, image: "current" }, images).total, result.length);
});

Deno.test("deepscan B variations HTTP: tiny increments reject before any upstream enqueue", async () => {
  const graph = { n: { class_type: "Node", inputs: { value: 0 } }, out: { class_type: "SaveImage", inputs: { images: ["n", 0], filename_prefix: "image" } } };
  const lifecycle = makeCollectionLifecycle({ fake: "fixture.invalid:8188" }), token = lifecycle.capture("fake");
  const origin = { source: "fake", address: token.address, kind: "comfy", epoch: "test", incarnation: token.incarnation };
  const handlers = new Map(), jobs = [];
  register({ store: { hashFor: () => "a".repeat(64) }, ingest: { graph: async () => graph },
    backings: { accepting: () => true, capture: lifecycle.capture, isCurrent: lifecycle.isCurrent,
      source: () => ({ ...origin, sourceVersion: origin }), comfy: () => ({ objectInfo: async () => ({ types: new Map([["Node.value", "FLOAT"]]), outputClasses: new Set(["SaveImage"]) }),
        enqueue: async job => { jobs.push(job); return { ok: true, acceptance: "confirmed", promptId: "accepted" }; } }) },
    route: (method, path, handler) => handlers.set(method + path, handler) });
  const probe = await handlers.get("GET/probe/<id>")(new Request("http://x/probe"), { id: "fake:image.png" });
  const { context } = await probe.json();
  const response = await handlers.get("POST/run")(new Request("http://x/run", { method: "POST", body: JSON.stringify({
    id: "fake:image.png", host: "fake", filename: "image.png", context,
    ranges: { "n.value": { enabled: true, min: 0, max: 5e-11, increment: 1e-16 } }, imageParams: {}, prefix: "v_", suffix: "",
    acknowledgement: { version: 2, runId: crypto.randomUUID(), requestId: crypto.randomUUID() },
  }) }));
  assertEquals(response.status, 400); assert((await response.json()).error.includes("work budget")); assertEquals(jobs, []);
});
