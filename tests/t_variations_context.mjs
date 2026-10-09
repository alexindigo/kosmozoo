import { assert, assertEquals } from "jsr:@std/assert";
import { buildContext } from "../src/context.mjs";
import { mkStateRig } from "./helpers/rig.mjs";
import { testPng } from "./helpers/png.mjs";
import { sourceOrigin, sameOrigin } from "../src/source-origin.mjs";
import { acknowledgedFields } from "../src/features/variations/shared.mjs";

async function contextRig() {
  const graph = { n: { class_type: "Sampler", inputs: { denoise: 1 } }, out: { class_type: "SaveImage", inputs: { filename_prefix: "file", images: ["n", 0] } } };
  const bytes = testPng(8, 9, undefined, graph), jobs = [], uploaded = [];
  let release = null, holdUpload = false;
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0 }, async req => {
    const path = new URL(req.url).pathname;
    if (path === "/api/object_info") return Response.json({ Sampler: { input: { required: { denoise: ["FLOAT", {}] } } }, SaveImage: { output_node: true, input: { required: { filename_prefix: ["STRING", {}] } } } });
    if (path === "/api/view") return new Response(req.method === "HEAD" ? null : bytes, { headers: { ETag: '"test"', "Content-Length": String(bytes.length) } });
    if (path === "/api/prompt") { jobs.push(await req.json()); return Response.json({ prompt_id: "queued-" + jobs.length, node_errors: {} }); }
    if (path === "/internal/files/input") return Response.json(["input.png [1]"]);
    if (path === "/api/upload/image") {
      const file = (await req.formData()).get("image"); uploaded.push({ name: file.name, bytes: await file.text() });
      if (holdUpload) await new Promise(resolve => release = resolve);
      return Response.json({ name: file.name, type: "input", subfolder: "" });
    }
    return new Response(null, { status: 404 });
  });
  const address = `127.0.0.1:${server.addr.port}`, rig = await mkStateRig("variation-origin", { hosts: { fake: address } });
  const { ctx, router } = await buildContext({ start: false, env: { HOME: rig.dir }, fakes: { ...rig, plugins: { list: () => [] }, prefetch: { requestRelist() {}, stop() {} } } });
  rig.store.collectionAdd("fake", address);
  await rig.ingest.ensure("fake", "file.png");
  const origin = () => sourceOrigin("fake", ctx.sourceActivity.source("fake"));
  const call = (path, options) => router.handle(new Request("http://x" + path, options));
  return { ctx, rig, jobs, uploaded, origin, call,
    replace() { rig.store.collectionRemove("fake"); rig.store.collectionAdd("fake", address); },
    hold() { holdUpload = true; }, release: () => release?.(), pending: () => !!release,
    async close() { release?.(); ctx.sourceActivity.stop(); await ctx.jobs.stop(); await rig.close(); await server.shutdown(); },
  };
}

Deno.test("source-bound v2: probe/context/accepted writes reach matching proof; graph and source preconditions reject unsent effects", async () => {
  const r = await contextRig();
  try {
    const expected = r.origin();
    const catalogue = await (await r.call('/api/features/variations/probe/fake%3Afile.png?origin=' + encodeURIComponent(JSON.stringify(expected)))).json();
    assert(sameOrigin(catalogue.context.origin, expected)); assertEquals(catalogue.context.graphHash.length, 64);
    const body = { id: "fake:file.png", host: "fake", filename: "file.png", context: catalogue.context,
      acknowledgement: { version: 2, runId: crypto.randomUUID(), requestId: crypto.randomUUID() },
      ranges: { "Sampler.denoise": { enabled: true, min: .5, max: .5, increment: .1 } }, prefix: "v_", suffix: "" };
    const run = async value => r.call('/api/features/variations/run', { method: 'POST', body: JSON.stringify(value) });
    const response = await run(body), data = await response.json();
    assertEquals(response.status, 200); assertEquals(data.acknowledgement.context, catalogue.context);
    assertEquals(acknowledgedFields(body, data).ranges, ["Sampler.denoise"]); assertEquals(r.jobs.length, 1);
    assertEquals(r.jobs[0].prompt.n.inputs.denoise, .5);
    const wrongGraph = structuredClone(body); wrongGraph.context.graphHash = "b".repeat(64);
    assertEquals((await run(wrongGraph)).status, 412); assertEquals(r.jobs.length, 1);
    r.replace(); assert(!sameOrigin(expected, r.origin()));
    assertEquals((await run(body)).status, 412); assertEquals(r.jobs.length, 1);
  } finally { await r.close(); }
});

Deno.test("source-bound input IO: legacy shapes remain, expected-origin mismatch writes nothing, accepted receipt records its actual origin", async () => {
  const r = await contextRig();
  try {
    const expected = r.origin(), headers = { "X-Kosmozoo-Origin": JSON.stringify(expected) };
    const legacy = await (await r.call('/api/collections/fake/entries?kind=input')).json(); assert(Array.isArray(legacy));
    const scoped = await (await r.call('/api/collections/fake/entries?kind=input', { headers })).json();
    assert(sameOrigin(scoped.origin, expected)); assert(Array.isArray(scoped.files));
    const upload = (name, header) => { const form = new FormData(); form.append("image", new File(["original"], name)); return r.call('/api/collections/fake/entries', { method: 'POST', headers: header, body: form }); };
    const receipt = await (await upload('accepted.png', headers)).json(); assertEquals(receipt.name, 'accepted.png'); assert(sameOrigin(receipt.origin, expected));
    const old = await (await upload('legacy.png')).json(); assertEquals(old, { name: 'legacy.png' });
    r.replace();
    assertEquals((await upload('must-not-write.png', headers)).status, 412); assertEquals(r.uploaded.length, 2);
    assertEquals((await r.call('/api/collections/fake/entries?kind=input', { headers })).status, 412);
  } finally { await r.close(); }
});

Deno.test("source-bound upload: retirement after actual write reports completed old-origin upload and authorizes no follow-up", async () => {
  const r = await contextRig();
  try {
    const expected = r.origin(), form = new FormData(); form.append('image', new File(['origin-A'], 'same.png'));
    r.hold(); const pending = r.call('/api/collections/fake/entries', { method: 'POST', headers: { 'X-Kosmozoo-Origin': JSON.stringify(expected) }, body: form });
    while (!r.pending()) await new Promise(resolve => setTimeout(resolve, 0));
    r.replace(); r.release(); const response = await pending, data = await response.json();
    assertEquals(response.status, 412); assertEquals(data.uploaded.name, 'same.png'); assert(sameOrigin(data.uploaded.origin, expected));
    assertEquals(r.uploaded, [{ name: 'same.png', bytes: 'origin-A' }]); assertEquals(r.jobs.length, 0);
  } finally { await r.close(); }
});

Deno.test("source-bound operation admission: shutdown retires new uploads/probes/runs before backing IO", async () => {
  const r = await contextRig();
  try {
    const catalogue = await (await r.call('/api/features/variations/probe/fake%3Afile.png')).json();
    const form = new FormData(); form.append('image', new File(['kept'], 'shutdown.png'));
    r.ctx.sourceActivity.stop();
    assertEquals((await r.call('/api/features/variations/probe/fake%3Afile.png')).status, 503);
    assertEquals((await r.call('/api/collections/fake/entries', { method: 'POST', body: form })).status, 503);
    assertEquals((await r.call('/api/features/variations/run', { method: 'POST', body: JSON.stringify({ id: 'fake:file.png', host: 'fake', filename: 'file.png', ranges: {}, context: catalogue.context,
      acknowledgement: { version: 2, runId: crypto.randomUUID(), requestId: crypto.randomUUID() } }) })).status, 503);
    assertEquals(r.uploaded.length, 0); assertEquals(r.jobs.length, 0);
  } finally { await r.close(); }
});
