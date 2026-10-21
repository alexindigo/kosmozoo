import { assert, assertEquals } from "jsr:@std/assert";
import * as comfy from "../src/backings/comfy.mjs";
import { register, mutateGraph, narrowToOneOutputNode, parameterCatalogue } from "../src/features/variations/server.mjs";
import { catalogueParams } from "../src/features/variations/shared.mjs";
import { makeCollectionLifecycle } from "../src/backings/index.mjs";

// Synthetic job99 equivalent: both reference branches, flat nested IDs, fixed
// model/text/seed, plus custom input/metadata that must never be recursively scrubbed.
const fixture = JSON.parse(await Deno.readTextFile(new URL("./fixtures/replayed-graph.json", import.meta.url)));
const withoutFingerprints = graph => Object.fromEntries(Object.entries(graph).map(([id, node]) => {
  const { is_changed: _executionOnly, ...descriptor } = node;
  return [id, descriptor];
}));
const descriptorCount = graph => Object.values(graph).filter(node => Object.hasOwn(node, "is_changed")).length;

Deno.test("submission: clone and strip descriptors only, with no cache-busting or nested data loss", () => {
  const source = structuredClone(fixture), before = structuredClone(source);
  const first = comfy.freshSubmissionGraph(source), second = comfy.freshSubmissionGraph(source);
  assertEquals(descriptorCount(first), 0);
  assertEquals(first, withoutFingerprints(before));
  assertEquals(second, first);
  first["92:105"].inputs.is_changed.is_changed.push("private");
  first["76"]._meta.title = "private";
  first["92:112:116"].inputs.pixels[0] = "private";
  assertEquals(source, before);
  assertEquals(second, withoutFingerprints(before));
});

Deno.test("submission: mutation and output narrowing own their clones across sibling variants", () => {
  const source = structuredClone(fixture), before = structuredClone(source);
  const params = catalogueParams(parameterCatalogue(source));
  const variants = ["a.jpg", "b.jpg", "c.jpg"].map(image => {
    const { graph } = mutateGraph(source, { "76.image": image }, params);
    narrowToOneOutputNode(graph, "94", "Flux2-Klein_00057_", "v_", `_${image}`, new Set(["SaveImage"]));
    return graph;
  });
  assertEquals(source, before);
  for (const [index, image] of ["a.jpg", "b.jpg", "c.jpg"].entries()) {
    const expected = structuredClone(before);
    expected["76"].inputs.image = image;
    expected["94"].inputs.filename_prefix = `v_Flux2-Klein_00057__${image}`;
    delete expected["95"];
    assertEquals(variants[index], expected);
  }
  variants[0]["92:105"].inputs.is_changed.is_changed.push("private");
  variants[0]["92:112:116"].inputs.vae[0] = "private";
  assertEquals(variants[1]["92:105"], before["92:105"]);
  assertEquals(variants[2]["92:112:116"], before["92:112:116"]);
  assertEquals(source, before);
});

Deno.test("submission: direct and bound enqueue let fake Comfy recompute same-name bytes and reuse unchanged inputs", async () => {
  const source = structuredClone(fixture), before = structuredClone(source), jobs = [], observations = [];
  let bytes = "original bytes", previous = null;
  const fake = Deno.serve({ hostname: "127.0.0.1", port: 0 }, async req => {
    const job = await req.json(); jobs.push(job);
    const node = job.prompt["76"];
    const supplied = Object.hasOwn(node, "is_changed");
    const fingerprint = supplied ? node.is_changed : bytes;
    const signature = JSON.stringify([node.inputs, fingerprint]);
    observations.push({ supplied, cached: signature === previous }); previous = signature;
    return Response.json({ prompt_id: `captured-${jobs.length}`, node_errors: {} });
  });
  const addr = `127.0.0.1:${fake.addr.port}`, binding = comfy.createBinding(addr);
  const job = { prompt: source, extra_data: { extra_pnginfo: { kz: { v: 1, source: "fake:parent.png", params: { "76.image": "content.jpg" } } } }, client_id: "retained" };
  try {
    assertEquals((await comfy.enqueue(addr, job)).acceptance, "confirmed");
    bytes = "replacement bytes under the same filename";
    assertEquals((await binding.enqueue(job)).acceptance, "confirmed");
    assertEquals((await binding.enqueue(job)).acceptance, "confirmed");
    assertEquals(observations, [{ supplied: false, cached: false }, { supplied: false, cached: false }, { supplied: false, cached: true }]);
    for (const captured of jobs) assertEquals(captured, { ...job, prompt: withoutFingerprints(before) });
    assertEquals(source, before);
  } finally { await binding.disposeInventory(); await fake.shutdown(); }
});

Deno.test("submission: real variations run sends every batch permutation through the Comfy boundary", async () => {
  const source = structuredClone(fixture), before = structuredClone(source), jobs = [], routes = new Map();
  const fake = Deno.serve({ hostname: "127.0.0.1", port: 0 }, async req => {
    assertEquals(new URL(req.url).pathname, "/api/prompt");
    jobs.push(await req.json());
    return Response.json({ prompt_id: `variant-${jobs.length}`, node_errors: {} });
  });
  const addr = `127.0.0.1:${fake.addr.port}`, binding = comfy.createBinding(addr);
  const lifecycle = makeCollectionLifecycle({ fake: addr });
  const token = lifecycle.capture("fake");
  const origin = { source: "fake", address: addr, kind: "comfy", epoch: "test", incarnation: token.incarnation };
  register({ store: { hashFor: () => "a".repeat(64) }, ingest: { graph: async () => source },
    backings: { accepting: () => true, capture: lifecycle.capture, isCurrent: lifecycle.isCurrent,
      source: () => ({ ...origin, sourceVersion: origin }), comfy: () => ({
        objectInfo: async () => ({ types: new Map(), enums: new Map(), outputClasses: new Set(["SaveImage"]) }),
        enqueue: binding.enqueue,
      }) }, route: (method, path, handler) => routes.set(method + path, handler) });
  try {
    const filename = "Flux2-Klein_00057_.png", id = `fake:${filename}`;
    const probe = await routes.get("GET/probe/<id>")(new Request("http://x/probe"), { id });
    assertEquals(probe.status, 200);
    const body = { id, host: "fake", filename, ranges: {}, prefix: "v_", suffix: "_{76.image}",
      imageParams: { "76.image": { enabled: true, values: ["a.jpg", "b.jpg", "c.jpg"] } },
      context: (await probe.json()).context,
      acknowledgement: { version: 2, runId: crypto.randomUUID(), requestId: crypto.randomUUID() } };
    const response = await routes.get("POST/run")(new Request("http://x/run", { method: "POST", body: JSON.stringify(body) }));
    assertEquals(response.status, 200);
    const result = await response.json();
    assertEquals(result.submitted, 3); assertEquals(result.errors, []);
    assertEquals(result.acknowledgement.accepted.length, 3);
    assertEquals(jobs.length, 3);
    for (const [index, image] of ["a.jpg", "b.jpg", "c.jpg"].entries()) {
      const expected = structuredClone(before);
      expected["76"].inputs.image = image;
      expected["94"].inputs.filename_prefix = `v_Flux2-Klein_00057__${image}`;
      delete expected["95"];
      assertEquals(descriptorCount(jobs[index].prompt), 0);
      assertEquals(jobs[index], { prompt: withoutFingerprints(expected),
        extra_data: { extra_pnginfo: { kz: { v: 1, source: id, params: { "76.image": image } } } } });
    }
    assertEquals(source, before);
    assert(descriptorCount(source) > 1);
  } finally { lifecycle.stop(); await binding.disposeInventory(); await fake.shutdown(); }
});
