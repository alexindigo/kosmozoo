import { assert, assertEquals } from "jsr:@std/assert";
import { register, mutateGraph } from "../src/features/variations/server.mjs";
import { makeCollectionLifecycle } from "../src/backings/index.mjs";
import { acknowledgedFields } from "../src/features/variations/shared.mjs";
import { editorRig } from "./helpers/variation-editor.mjs";
import { enqueue, write } from "../src/backings/comfy.mjs";

const graph = {
  sampler: { class_type: "Sampler", inputs: { denoise: 1 } },
  text: { class_type: "Text", inputs: { text: "original" } },
  output: { class_type: "SaveImage", inputs: { filename_prefix: "source", images: ["sampler", 0] } },
};
const request = () => ({ id: "fake:source_00001_.png", host: "fake", filename: "source_00001_.png",
  ranges: { "Sampler.denoise": { enabled: true, min: .5, max: .5, increment: .1 } },
  imageParams: { "Text#text.text": { enabled: true, values: ["  first\n\nsecond\n"] } },
  prefix: "v_", suffix: "_{Sampler.denoise}",
  acknowledgement: { version: 1, runId: crypto.randomUUID(), requestId: crypto.randomUUID() } });
function rig({ source = graph, enqueue, inspect } = {}) {
  const hosts = { fake: "old:8188" }, lifecycle = makeCollectionLifecycle(hosts), jobs = [], routes = new Map();
  const backing = { objectInfo: async () => {
    await inspect?.();
    return { types: new Map([["Sampler.denoise", "FLOAT"]]), enums: new Map(), outputClasses: new Set(["SaveImage"]) };
  }, enqueue: async (job) => {
    jobs.push(job);
    return enqueue ? enqueue(job, jobs.length) : { ok: true, status: 200, acceptance: "confirmed", promptId: "prompt-" + jobs.length, nodeErrors: {} };
  } };
  register({ hosts, store: { hashFor: () => "hash" }, ingest: { graph: async () => structuredClone(source) },
    backings: { capture: lifecycle.capture, isCurrent: lifecycle.isCurrent, comfy: () => backing, accepting: () => true,
      source: id => { const token = lifecycle.capture(id); return { address: token.address, kind: "comfy", incarnation: token.incarnation,
        sourceVersion: { epoch: "rig-epoch", incarnation: token.incarnation } }; } },
    route: (method, path, handler) => routes.set(method + path, handler) });
  return { hosts, lifecycle, jobs, run: (body) => routes.get("POST/run")(new Request("http://x/run", { method: "POST", body: JSON.stringify(body) })) };
}

Deno.test("ack: mutation reports actual assignments, not absent descriptors/carriers", () => {
  const result = mutateGraph(graph, { "Missing.value": 1 }, [{ id: "Missing.value", key: "value", nodeIds: ["gone"] }]);
  assertEquals(result.applied, []);
});

Deno.test("ack: real accepted final graph certifies numeric, literal text and output naming", async () => {
  const r = rig(), body = request(), response = await r.run(body), data = await response.json();
  assertEquals(response.status, 200); assertEquals(data.submitted, 1); assertEquals(r.jobs.length, 1);
  assertEquals(r.jobs[0].prompt.text.inputs.text, "  first\n\nsecond\n");
  assertEquals(r.jobs[0].prompt.sampler.inputs.denoise, .5);
  assertEquals(r.jobs[0].prompt.output.inputs.filename_prefix, "v_source_00001__0.5");
  assertEquals(data.acknowledgement, { ...body.acknowledgement,
    target: { id: body.id, host: body.host, filename: body.filename },
    accepted: [{ index: 0, promptId: "prompt-1", applied: { ranges: ["Sampler.denoise"], imageParams: ["Text#text.text"] },
      selections: { ranges: ["Sampler.denoise"], imageParams: ["Text#text.text"] }, naming: ["prefix", "suffix"] }] });
  assertEquals(r.jobs[0].extra_data.extra_pnginfo.kz.source, body.id);
});

Deno.test("ack: counts-only requests retain their compatible response", async () => {
  const r = rig(), body = request(); delete body.acknowledgement;
  const data = await (await r.run(body)).json();
  assertEquals(data, { submitted: 1, total: 1, errors: [] });
});

Deno.test("ack: invalid correlation, wrong target and ambiguous channels reject before enqueue", async () => {
  for (const change of [body => body.acknowledgement.version = 2, body => body.acknowledgement.runId = "old",
    body => body.id = "different:source.png", body => body.imageParams["Sampler.denoise"] = { enabled: true, values: [.6] }]) {
    const r = rig(), body = request(); change(body);
    assertEquals((await r.run(body)).status, 400); assertEquals(r.jobs.length, 0);
  }
});

Deno.test("ack: removed carriers, output rewrites and ambiguous LoadImage IDs cannot be certified", async () => {
  const source = structuredClone(graph);
  source.other = { class_type: "SaveImage", inputs: { filename_prefix: "other", quality: 1, images: ["sampler", 0] } };
  source.output.inputs.quality = 1;
  source.first = { class_type: "LoadImage", inputs: { image: "first.png" } };
  source.second = { class_type: "LoadImage", inputs: { image: "second.png" } };
  const r = rig({ source }), body = request();
  body.ranges["SaveImage.quality"] = { enabled: true, min: .5, max: .5, increment: .1 };
  body.imageParams["LoadImage.image"] = { enabled: true, values: ["new.png"] };
  const data = await (await r.run(body)).json();
  assertEquals(r.jobs.length, 1); assert(!Object.hasOwn(r.jobs[0].prompt, "other"));
  assertEquals(data.acknowledgement.accepted[0].applied, { ranges: ["Sampler.denoise"], imageParams: ["Text#text.text"] });
});

Deno.test("ack: unknown naming tokens remain unacknowledged; recognized directory prefixes survive", async () => {
  const r = rig(), body = request(); body.prefix = "v_{unknown}_";
  const data = await (await r.run(body)).json();
  assertEquals(data.acknowledgement.accepted[0].naming, ["suffix"]);
  body.prefix = "variants/v_";
  const nested = await (await r.run(body)).json();
  assertEquals(nested.acknowledgement.accepted[0].naming, ["prefix", "suffix"]);
  assert(r.jobs[1].prompt.output.inputs.filename_prefix.startsWith("variants/v_"));
});

Deno.test("ack: source replacement during inspection or accepted enqueue fences old ownership", async () => {
  let r = rig({ inspect: () => { delete r.hosts.fake; r.lifecycle.reconcile(); r.hosts.fake = "replacement:8188"; } });
  assertEquals((await r.run(request())).status, 409); assertEquals(r.jobs.length, 0);
  r = rig({ enqueue: () => {
    delete r.hosts.fake; r.lifecycle.reconcile(); r.hosts.fake = "replacement:8188";
    return { ok: true, acceptance: "confirmed", promptId: "old-accepted", nodeErrors: {} };
  } });
  const body = request(); body.ranges["Sampler.denoise"].max = .6;
  const data = await (await r.run(body)).json();
  assertEquals(r.jobs.length, 1); assertEquals(data.submitted, 1); assertEquals(data.total, 2);
  assertEquals(data.acknowledgement.accepted, []); assert(data.errors.length > 0);
});

Deno.test("ack: partial or uncertain upstream acceptance provides no footprint and is not retried", async () => {
  for (const acceptance of ["partial", "uncertain"]) {
    const r = rig({ enqueue: () => ({ ok: true, acceptance, error: "unconfirmed" }) });
    const data = await (await r.run(request())).json();
    assertEquals(r.jobs.length, 1); assertEquals(data.acknowledgement.accepted, []); assertEquals(data.errors.length, 1);
  }
});

Deno.test("ack: consumer rejects incomplete, foreign, duplicate and forged proof before baseline writes", async () => {
  const r = rig(), body = request(), valid = await (await r.run(body)).json();
  assertEquals(acknowledgedFields(body, valid), { ranges: ["Sampler.denoise"], imageParams: ["Text#text.text"], naming: ["prefix", "suffix"],
    rangeSelections: ["Sampler.denoise"], imageSelections: ["Text#text.text"] });
  for (const change of [data => delete data.acknowledgement, data => data.acknowledgement.version = 2,
    data => data.acknowledgement.runId = crypto.randomUUID(), data => data.acknowledgement.requestId = crypto.randomUUID(),
    data => data.acknowledgement.target.host = "another", data => delete data.errors,
    data => data.errors = ["failed"], data => data.submitted = 0, data => data.total = Number.MAX_SAFE_INTEGER + 1,
    data => data.acknowledgement.accepted[0].index = 1, data => data.acknowledgement.accepted[0].promptId = "",
    data => data.acknowledgement.accepted[0].applied.ranges.push("disabled"),
    data => data.acknowledgement.accepted[0].applied.imageParams.push("Text#text.text"),
    data => data.acknowledgement.accepted[0].naming.push("filter"), data => data.acknowledgement.accepted = [],
    data => delete data.acknowledgement.accepted[0].selections,
    data => data.acknowledgement.accepted[0].selections.ranges.push("unrequested"),
    data => data.acknowledgement.accepted[0].applied.ranges = []]) {
    const data = structuredClone(valid); change(data); assertEquals(acknowledgedFields(body, data), null);
  }
  const multi = structuredClone(valid); multi.submitted = multi.total = 2;
  multi.acknowledgement.accepted.push(structuredClone(multi.acknowledgement.accepted[0]));
  assertEquals(acknowledgedFields(body, multi), null);
  multi.acknowledgement.accepted[1].index = 1;
  assertEquals(acknowledgedFields(body, multi), null);
  multi.acknowledgement.accepted[1].promptId = "different";
  multi.acknowledgement.accepted[1].applied.ranges = [];
  multi.acknowledgement.accepted[1].selections.ranges = [];
  assertEquals(acknowledgedFields(body, multi).ranges, []);
});

Deno.test("ack: compiler-owned consumption retains disabled/filter/dormant/inactive fields and native File identity", async () => {
  const a = new File(["a"], "a.png"), b = new File(["b"], "b.png");
  const { editor, requests } = editorRig();
  editor.edit("numeric", "BasicScheduler.denoise", "rawIncrement", "1e-1");
  editor.edit("numeric", "BasicScheduler.steps", "rawIncrement", "1e");
  editor.edit("images", "LoadImage.image", "enabled", true); editor.edit("images", "LoadImage.image", "mode", "files");
  editor.edit("images", "LoadImage.image", "file", "retained.png"); editor.edit("images", "LoadImage.image", "localFiles", [a, b]);
  editor.edit("enums", "Choice#choice.value", "enabled", true); editor.edit("enums", "Choice#choice.value", "picks", ["second", "first"]);
  editor.edit("enums", "Choice#choice.value", "filter", "search");
  editor.edit("texts", "Text#text.text", "enabled", true); editor.edit("texts", "Text#text.text", "text", "one {{used}}\n\ntwo");
  editor.template("Text#text.text", "used", "a; b"); editor.template("Text#text.text", "dormant", "kept");
  editor.edit("naming", "root", "prefix", "v_");
  assertEquals((await editor.run()).status, "submitted");
  const remaining = editor.remaining().map(item => `${item.domain}.${item.id}.${item.field}`);
  assertEquals(remaining.sort(), ["numeric.BasicScheduler.steps.rawIncrement", "images.LoadImage.image.file", "enums.Choice#choice.value.filter", "texts.Text#text.text.tpl"].sort());
  assertEquals(requests[0].ranges["BasicScheduler.denoise"].increment, .1);
  assertEquals(requests[0].imageParams["Text#text.text"].values, ["one a\n\ntwo", "one b\n\ntwo"]);
  assert(editor.rows("images")["LoadImage.image"].localFiles[0] === a && editor.rows("images")["LoadImage.image"].localFiles[1] === b);
  assertEquals(editor.rows("numeric")["BasicScheduler.denoise"].rawIncrement, "1e-1");
  editor.dispose();
});

Deno.test("ack: backing parses confirmed/partial/uncertain replies once and validates returned upload names", async () => {
  let body = { prompt_id: "queued", number: 1, node_errors: {} }, calls = 0;
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0 }, async req => {
    calls++; await req.arrayBuffer(); return typeof body === "string" ? new Response(body) : Response.json(body);
  });
  const addr = `127.0.0.1:${server.addr.port}`;
  try {
    assertEquals((await enqueue(addr, { prompt: graph })).acceptance, "confirmed");
    body = { prompt_id: "partial", node_errors: { dropped: { errors: ["invalid"] } } };
    assertEquals((await enqueue(addr, { prompt: graph })).acceptance, "partial");
    for (const invalid of ["broken-json", {}, { prompt_id: "queued" }, { prompt_id: "", node_errors: {} }]) {
      body = invalid; assertEquals((await enqueue(addr, { prompt: graph })).acceptance, "uncertain");
    }
    assertEquals(calls, 6);
    body = { name: "renamed (1).png", type: "input", subfolder: "" };
    assertEquals(await write(addr, "requested.png", new Uint8Array([1])), { ok: true, name: "renamed (1).png" });
    for (const invalid of [{}, { name: "../unsafe.png" }, { name: "out.png", type: "output" }]) {
      body = invalid; assertEquals((await write(addr, "requested.png", new Uint8Array([1]))).ok, false);
    }
    assertEquals(calls, 10);
  } finally { await server.shutdown(); }
});

Deno.test("ack: off selections are certified without applying or blessing their dormant values", async () => {
  const source = structuredClone(graph); source.other = { class_type: "Text", inputs: { text: "another" } };
  const r = rig({ source }), body = request();
  body.ranges["Sampler.denoise"] = { enabled: false, min: 8, max: 9, increment: null };
  body.imageParams["Text#text.text"] = { enabled: false, values: [] };
  body.ranges["OtherTarget.value"] = { enabled: false, min: 1, max: 2, increment: 1 };
  body.imageParams["Text#other.text"] = { enabled: true, values: ["submitted"] };
  const data = await (await r.run(body)).json();
  const fields = acknowledgedFields(body, data);
  assertEquals(fields.ranges, []); assertEquals(fields.rangeSelections, ["Sampler.denoise", "OtherTarget.value"]);
  assertEquals(r.jobs[0].prompt.sampler.inputs.denoise, 1); assertEquals(data.submitted, 1);
  assertEquals(r.jobs[0].prompt.text.inputs.text, "original"); assertEquals(r.jobs[0].prompt.other.inputs.text, "submitted");
  assertEquals(data.acknowledgement.accepted[0].applied.ranges, []);
});

Deno.test("ack: off selection proof rejects a conflicting on carrier and never invents inert true proof", async () => {
  const r = rig(), body = request();
  body.imageParams["unknown-inert"] = { enabled: true, values: [] };
  body.imageParams["unknown-off"] = { enabled: false, values: [] };
  const data = await (await r.run(body)).json(), fields = acknowledgedFields(body, data);
  assert(fields.imageSelections.includes("unknown-off")); assert(!fields.imageSelections.includes("unknown-inert"));
  const forged = structuredClone(data); forged.acknowledgement.accepted[0].selections.imageParams.push("unknown-inert");
  assertEquals(acknowledgedFields(body, forged), null);
  const collision = request(); collision.ranges["Sampler.denoise"].enabled = false;
  collision.imageParams["Sampler.denoise"] = { enabled: true, values: [.5] };
  const accepted = await (await r.run(collision)).json();
  assertEquals(acknowledgedFields(collision, accepted).rangeSelections, []);
  accepted.acknowledgement.accepted[0].selections.ranges.push("Sampler.denoise");
  assertEquals(acknowledgedFields(collision, accepted), null);
});
