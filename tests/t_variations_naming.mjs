import { assert, assertEquals } from "jsr:@std/assert";
import { register } from "../src/features/variations/server.mjs";
import { acknowledgedFields } from "../src/features/variations/shared.mjs";
import { makeCollectionLifecycle } from "../src/backings/index.mjs";
import { makeVariationEditor } from "../client-solid/features/variations/editor.js";

// Sanitized from source-00330-prompt.json: retain the complete output dependency
// path and both switch branches, plus the two unrelated output nodes.
const fixture = JSON.parse(await Deno.readTextFile(new URL("./fixtures/variation-naming-dependency.json", import.meta.url)));
const outputClasses = new Set(["SaveImageAdvanced", "PreviewAny", "ImageCompare"]);
const files = ["StyleMix_01733_.png", "StyleMix_01739_.png", "StyleMix_01778_.png", "_0.75__00001_.png", "_0.75__00003_.png"];
const editedText = "Edited literal prompt\n\nKeep the reference style.\n";

async function rig(graph = fixture, filename = "Qwen_image_2.1_00330.png", outputs = outputClasses) {
  const routes = new Map(), jobs = [], requests = [], replies = [];
  const lifecycle = makeCollectionLifecycle({ comfyui: "in-memory:8188" });
  const token = lifecycle.capture("comfyui");
  const origin = { source: "comfyui", address: token.address, kind: "comfy", epoch: "naming-test", incarnation: token.incarnation };
  register({ store: { hashFor: () => "a".repeat(64) }, ingest: { graph: async () => structuredClone(graph) },
    backings: { accepting: () => true, capture: lifecycle.capture, isCurrent: lifecycle.isCurrent,
      source: () => ({ ...origin, sourceVersion: origin }), comfy: () => ({
        objectInfo: async () => ({ types: new Map(), enums: new Map(), outputClasses: outputs }),
        enqueue: async job => { jobs.push(job); return { ok: true, acceptance: "confirmed", promptId: `naming-${jobs.length}` }; },
      }) }, route: (method, path, handler) => routes.set(method + path, handler) });
  const target = { id: `comfyui:${filename}`, host: "comfyui", filename, origin };
  const probe = await routes.get("GET/probe/<id>")(new Request("http://x/probe"), { id: target.id });
  assertEquals(probe.status, 200);
  const catalogue = await probe.json();
  const run = async request => {
    requests.push(request);
    const response = await routes.get("POST/run")(new Request("http://x/run", { method: "POST", body: JSON.stringify(request) }));
    const data = await response.json(); replies.push(data);
    return { ok: response.ok, status: response.status, data };
  };
  const request = () => ({ id: target.id, host: target.host, filename, context: catalogue.context,
    ranges: {}, imageParams: { "475.image": { enabled: true, values: files }, "502.value": { enabled: true, values: [editedText] } },
    prefix: "", suffix: "_{475.image}", acknowledgement: { version: 2, runId: crypto.randomUUID(), requestId: crypto.randomUUID() } });
  return { target, catalogue, jobs, requests, replies, run, request };
}

Deno.test("naming proof: dependency output without filename_prefix never blocks the producer suffix", async () => {
  const r = await rig(), request = r.request(), { data, status } = await r.run(request);
  assertEquals(status, 200); assertEquals(data.submitted, 5); assertEquals(data.errors, []);
  assertEquals(r.jobs.length, 5);
  for (const [index, { prompt }] of r.jobs.entries()) {
    assertEquals(prompt["475"].inputs.image, files[index]);
    assertEquals(prompt["502"].inputs.value, editedText);
    assertEquals(prompt["461"].inputs.filename_prefix, `Qwen_image_2.1_00330_${files[index]}`);
    assertEquals(prompt["459:480"], fixture["459:480"]);
    assert(!Object.hasOwn(prompt, "472")); assert(!Object.hasOwn(prompt, "503"));
  }
  assertEquals(data.acknowledgement.accepted.map(item => item.naming), files.map(() => ["prefix", "suffix"]));
  assertEquals(acknowledgedFields(request, data).naming, ["prefix", "suffix"]);
});

Deno.test("naming proof: registered run consumes the local-file editor work through the real acknowledgement validator", async () => {
  const r = await rig(), uploads = [], timers = [];
  const editor = makeVariationEditor({ targets: [r.target], currentOrigin: () => r.target.origin,
    services: { probe: async () => r.catalogue, run: r.run,
      inspectImage: async (_host, _file, _current, _kind, origin) => ({ hash: "b".repeat(64), currentHash: "a".repeat(64), origin }),
      uploadInput: async (_host, form, origin) => { const file = form.get("image"); uploads.push(file.name); return { name: file.name, origin }; } },
    setTimer: callback => { timers.push(callback); return callback; }, clearTimer() {} });
  try {
    editor.installCatalogue(r.catalogue);
    editor.installInputs({ origin: r.target.origin, files: ["original.jpg"] });
    const localFiles = files.map(name => new File(["fixture"], name, { type: "image/png" }));
    editor.edit("images", "475.image", "enabled", true);
    editor.addImages("475.image", localFiles.map(file => ({ kind: "upload", name: file.name, file })));
    editor.edit("texts", "502.value", "enabled", true);
    editor.edit("texts", "502.value", "text", editedText);
    editor.edit("naming", "root", "suffix", "_{475.image}");
    assert(editor.dirty());
    assertEquals((await editor.run()).status, "submitted");
    assertEquals(uploads, files);
    assertEquals(r.requests[0].imageParams["475.image"], { enabled: true, values: files });
    assertEquals(r.requests[0].imageParams["502.value"], { enabled: true, values: [editedText] });
    assertEquals(editor.remaining(), []);
    assertEquals(editor.result().state, "adopted");
    assertEquals(timers.length, 1);
    assert(editor.rows("images")["475.image"].items[0].file === localFiles[0]);
  } finally { editor.dispose(); }
});

Deno.test("naming proof: fallback certifies every actual naming write and preserves unresolved-template rejection", async () => {
  const r = await rig(fixture, "unmatched.png"), request = r.request();
  request.prefix = "pre_";
  const { data } = await r.run(request);
  assertEquals(data.submitted, 5); assertEquals(data.errors, []);
  for (const [index, { prompt }] of r.jobs.entries()) {
    for (const id of ["461", "472", "503", "459:480"]) {
      const middle = fixture[id].inputs.filename_prefix ?? "";
      assertEquals(prompt[id].inputs.filename_prefix, `pre_${middle}_${files[index]}`);
    }
    assert(!Object.hasOwn(prompt["475"].inputs, "filename_prefix"));
  }
  assertEquals(acknowledgedFields(request, data).naming, ["prefix", "suffix"]);
  request.suffix = "_{unknown}";
  const unresolved = await r.run(request);
  assertEquals(acknowledgedFields(request, unresolved.data).naming, ["prefix"]);
});

Deno.test("naming proof: no naming writes cannot acknowledge naming", async () => {
  const r = await rig(fixture, "unmatched.png", new Set()), request = r.request();
  const { data } = await r.run(request);
  assertEquals(data.submitted, 0); assertEquals(r.jobs, []);
  assertEquals(data.acknowledgement.accepted, []);
  assertEquals(acknowledgedFields(request, data), null);
});
