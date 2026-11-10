// Shared resource/connection contract matrix. Production-shaped object_info
// (LoadImage listing + upload metadata, Autogrow templates) flows through the
// real backing normalizer, probe, private editor, compiler and /run to a fake
// enqueue consumer. Every case observes transfers, final names and v2 adoption.
import { assert, assertEquals, assertMatch, assertRejects } from "jsr:@std/assert";
import { register, mutateGraph } from "../src/features/variations/server.mjs";
import { objectInfo, objectInfoView } from "../src/backings/comfy.mjs";
import { makeCollectionLifecycle } from "../src/backings/index.mjs";
import { inputContract, paramId, resourceReferenceProblem, resourceReference, graphParameters } from "../src/parameters.mjs";
import { admitResourceTransfer, validateParameterValue, validateFinalGraph } from "../src/features/variations/compile.mjs";
import { uploadCandidate } from "../src/features/variations/shared.mjs";
import { makeVariationEditor } from "../client-solid/features/variations/editor.js";
import { editorDomain } from "../client-solid/features/variations/graph.mjs";
import { inputDeclaration } from "../src/graph.mjs";
import { loadImage, loadImageOutput, batchImagesNode, textEncodeQwenImage21, checkpointLoader, saveImage } from "./helpers/comfy-object-info.mjs";

const hex = async bytes => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes)))].map(b => b.toString(16).padStart(2, "0")).join("");

function backend({ inputs = { "origin.png": "origin bytes", "next.png": "next bytes" }, listing = null } = {}) {
  const files = new Map(Object.entries(inputs)), disk = new Map([["/images/disk.png", "disk bytes"]]);
  const listed = () => listing ?? [...files.keys()];
  const raw = () => ({ LoadImage: loadImage(listed()), LoadImageOutput: loadImageOutput(), BatchImagesNode: batchImagesNode(),
    TextEncodeQwenImage21: textEncodeQwenImage21(), CheckpointLoaderSimple: checkpointLoader(), SaveImage: saveImage(),
    KSampler: { input: { required: { model: ["MODEL", {}], seed: ["INT", { default: 0, min: 0, max: 18446744073709551615n }],
      sampler_name: [["euler", "dpmpp_2m"], {}] } }, output: ["LATENT"], output_name: ["LATENT"] } });
  const serialize = value => JSON.stringify(value, (_key, v) => typeof v === "bigint" ? JSON.rawJSON(String(v)) : v);
  const fetches = [];
  const fetcher = async url => { fetches.push(String(url)); return new Response(serialize(raw())); };
  // Stock upload: equal bytes reuse the name; otherwise "stem (n).ext".
  const store = (name, bytes) => {
    for (let index = 0; ; index++) {
      const candidate = uploadCandidate(name, index);
      if (!files.has(candidate) || files.get(candidate) === bytes) { files.set(candidate, bytes); return candidate; }
    }
  };
  return { files, disk, fetcher, fetches, store, cache: new Map() };
}

async function rig({ graph, current = "origin.png", inputs, listing, foreign = null } = {}) {
  graph ??= { image: { class_type: "LoadImage", inputs: { image: current } },
    k: { class_type: "KSampler", inputs: { seed: 1, sampler_name: "euler", model: ["ckpt", 0] } },
    ckpt: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "model.safetensors" } },
    out: { class_type: "SaveImage", inputs: { filename_prefix: "source", images: ["image", 0] } } };
  const b = backend({ inputs, listing });
  const hosts = { fake: "fake:8188", other: "other:8188" }, lifecycle = makeCollectionLifecycle(hosts), routes = new Map();
  const jobs = [], requests = [], transfers = { reads: [], uploads: [], paths: [], inspections: [] };
  const comfy = { objectInfo: options => objectInfo("fake:8188", b.cache, { fetcher: b.fetcher, ...options }),
    enqueue: async job => { jobs.push(structuredClone(job)); return { ok: true, status: 200, acceptance: "confirmed", promptId: `job-${jobs.length}`, nodeErrors: {} }; } };
  register({ hosts, store: { hashFor: () => "a".repeat(64) }, ingest: { graph: async () => structuredClone(graph) },
    backings: { capture: lifecycle.capture, isCurrent: lifecycle.isCurrent, comfy: () => comfy, accepting: () => true,
      source: id => { const token = lifecycle.capture(id); return { address: token.address, kind: "comfy", incarnation: token.incarnation,
        sourceVersion: { epoch: "test", incarnation: token.incarnation } }; } },
    route: (method, path, handler) => routes.set(method + path, handler) });
  const id = "fake:source.png", response = await routes.get("GET/probe/<id>")(new Request("http://x/probe/" + encodeURIComponent(id)), { id });
  assertEquals(response.status, 200);
  const catalogue = await response.json(), origin = catalogue.context.origin;
  const origins = { fake: origin, other: foreign?.origin ?? { ...origin, source: "other", address: "other:8188" } };
  const bytesOf = async resource => typeof resource === "string" ? b.disk.get(resource) : await resource.text();
  const inspect = async (_host, resource, name, _kind, expected, family = []) => {
    transfers.inspections.push(typeof resource === "string" ? resource : resource.name);
    const existing = await Promise.all(family.filter(candidate => b.files.has(candidate)).map(async candidate => ({ name: candidate, hash: await hex(b.files.get(candidate)) })));
    return { hash: await hex(await bytesOf(resource)), currentHash: await hex(b.files.get(name) ?? "missing current"), existing, origin: expected };
  };
  const services = { inspectImage: inspect, inspectPath: inspect,
    uploadInput: async (_host, form, expected) => { const file = form.get("image"); transfers.uploads.push(file.name);
      return { name: b.store(file.name, await file.text()), origin: { ...expected } }; },
    uploadPath: async (_host, path, _hash, expected) => { transfers.paths.push(path);
      return { name: b.store(path.split("/").at(-1), b.disk.get(path)), origin: { ...expected } }; },
    inputList: async source => ({ origin: origins[source], files: source === "other" ? Object.keys(foreign?.files ?? {}) : [...b.files.keys()] }),
    readInput: async (source, name) => { transfers.reads.push([source.source, name]); return new File([foreign.files[name]], name); },
    run: async request => {
      requests.push(structuredClone(request));
      const response = await routes.get("POST/run")(new Request("http://x/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) }));
      return { ok: response.ok, status: response.status, data: await response.json() };
    } };
  const editor = makeVariationEditor({ targets: [{ id, host: "fake", filename: "source.png", origin }], currentOrigin: source => origins[source],
    setTimer: () => 0, clearTimer() {}, services });
  editor.installCatalogue(catalogue);
  editor.installInputs({ origin, files: [...b.files.keys()] });
  return { editor, catalogue, origin, origins, b, jobs, requests, transfers, services, routes };
}

const IMAGE = paramId("image", "image");

Deno.test("contract: declarations project resource, listing, closed choice, connection and unknown facts", () => {
  const image = inputContract({ type: "COMBO", options: ["a.png"], image_upload: true, section: "required" });
  assertEquals([image.role, image.choices.evidence, image.resource], ["resource", "listing", { media: "image", upload: true, root: "input", provider: "listing" }]);
  const output = inputContract({ type: "COMBO", image_upload: true, image_folder: "output", remote: { route: "/internal/files/output" } });
  assertEquals(output.resource, { media: "image", upload: true, root: "output", provider: "remote", route: "/internal/files/output" });
  assertEquals(inputContract({ type: "COMBO", options: ["clip.mp4"], audio_upload: true }).resource.media, "audio");
  const closed = inputContract({ type: "COMBO", options: ["euler"] });
  assertEquals([closed.role, closed.choices.evidence, closed.resource], ["value", "closed", null]);
  assertEquals(inputContract({ type: "IMAGE", section: "optional", lazy: true }).role, "connection");
  assertEquals(inputContract({ type: "INT", min: 0, max: 9 }).constraints, { min: 0, max: 9 });
  assertEquals(inputContract(null, { status: "partial", options: ["x"] }).choices.evidence, "unverified");
  assertEquals(inputContract(null).knowledge, "unknown");
  for (const value of ["sub/x.png", "x.png [output]", "nested/a [b].png [input]", "draft [b]", "x.png [temp]"]) assertEquals(resourceReferenceProblem(image, value), null, value);
  for (const value of ["", "../x.png", "a/../../x.png", "/etc/x.png", "C:\\x.png", "..\\x.png [output]", "a\u0000.png", 7]) assertEquals(typeof resourceReferenceProblem(image, value), "string", String(value));
  assertEquals(admitResourceTransfer({ id: "a.b", contract: image }).role, "resource");
  assertEquals(admitResourceTransfer({ id: "a.b", contract: inputContract(null) }).knowledge, "unknown");
  for (const contract of [closed, inputContract({ type: "COMBO", options: [], image_folder: "output" })]) {
    let error = null; try { admitResourceTransfer({ id: "a.b", contract }); } catch (problem) { error = problem.message; }
    assertMatch(error, /not uploaded files|does not accept uploaded files/);
  }
});

Deno.test("contract: Autogrow prefix and named templates resolve child declarations with inherited section/lazy", async () => {
  const b = backend();
  const graph = { a: { class_type: "BatchImagesNode", inputs: {} }, q: { class_type: "TextEncodeQwenImage21", inputs: {} } };
  const view = await objectInfo("fake:8188", b.cache, { fetcher: b.fetcher, graph });
  assertEquals(view.schemaError, null);
  assertEquals(view.declarations.get("BatchImagesNode.images.image0"), { type: "IMAGE", section: "required" });
  assertEquals(view.declarations.get("BatchImagesNode.images.image1").section, "optional");
  assertEquals(view.declarations.has("BatchImagesNode.images.image49"), true);
  assertEquals(view.declarations.has("BatchImagesNode.images.image50"), false);
  assertEquals(view.declarations.get("TextEncodeQwenImage21.images.image_1"), { type: "IMAGE", section: "optional" });
  assertEquals(view.declarations.has("TextEncodeQwenImage21.images.image_17"), false);
  const lazy = await objectInfo("lazy:8188", new Map(), { graph: { l: { class_type: "Lazy", inputs: {} } }, fetcher: async () => Response.json({ Lazy: { input: { required: {
    images: ["COMFY_AUTOGROW_V3", { template: { input: { optional: { image: ["IMAGE", { lazy: true }] } }, prefix: "image", min: 2, max: 3 } }],
    bad: ["COMFY_AUTOGROW_V3", { template: { input: { required: { x: ["IMAGE", {}] } }, prefix: "x", min: 1, max: 101 } }] } } } }) });
  assertEquals(lazy.declarations.get("Lazy.images.image0"), { type: "IMAGE", section: "optional", lazy: true }, "optional template stays optional below min");
  assertEquals([...lazy.lazyInputs.get("Lazy")].sort(), ["images.image0", "images.image1", "images.image2"]);
  assertEquals(lazy.declarations.has("Lazy.bad.x0"), false, "malformed templates remain unknown, never guessed");
});

// Every acquisition path reaches the same backing with its actual target name.
const paths = [
  { name: "same-host listed input", add: r => r.editor.addImages(IMAGE, [{ kind: "input", name: "next.png" }]), final: "next.png", uploads: 0 },
  { name: "Current output", add: r => r.editor.toggleTargetImage(IMAGE), final: "source.png [output]", uploads: 0 },
  { name: "local File", add: r => r.editor.addImages(IMAGE, [{ kind: "upload", name: "fresh.png", file: new File(["fresh bytes"], "fresh.png") }]), final: "fresh.png", uploads: 1 },
  { name: "local File collision", add: r => r.editor.addImages(IMAGE, [{ kind: "upload", name: "next.png", file: new File(["other bytes"], "next.png") }]), final: "next (1).png", uploads: 1 },
  { name: "equal-bytes dedupe", add: r => r.editor.addImages(IMAGE, [{ kind: "upload", name: "next.png", file: new File(["next bytes"], "next.png") }]), final: "next.png", uploads: 1 },
  { name: "engine folder", add: r => r.editor.addImages(IMAGE, [{ kind: "server-path", name: "disk.png", path: "/images/disk.png" }]), final: "disk.png", paths: 1 },
  { name: "foreign File", foreign: true, add: async r => { await r.editor.loadSourceInputs(r.origins.other); await r.editor.toggleSourceInput(IMAGE, r.origins.other, "far.png"); },
    final: "far.png", uploads: 1, reads: 1 },
];
for (const path of paths) {
  Deno.test(`resource path: ${path.name} previews without literal rejection and runs with its exact target name`, async () => {
    const r = await rig({ foreign: path.foreign ? { files: { "far.png": "far bytes" } } : null });
    try {
      r.editor.setEnabled(IMAGE, true);
      await path.add(r); await r.editor.inspectImages();
      const preview = r.editor.preview();
      assertEquals([preview.status, preview.n], ["ready", 1], preview.message);
      assertEquals(r.requests.length + r.transfers.uploads.length + r.transfers.paths.length, 0, "preview authorizes no transfer");
      const result = await r.editor.run();
      assertEquals(result.adopted, true, r.editor.result()?.text);
      assertEquals(r.transfers.uploads.length, path.uploads ?? 0); assertEquals(r.transfers.paths.length, path.paths ?? 0);
      assertEquals(r.transfers.reads.length, path.reads ?? 0);
      assertEquals(r.requests.length, 1); assertEquals(r.requests[0].imageParams[IMAGE].values, [path.final]);
      assertEquals(r.jobs.map(job => job.prompt.image.inputs.image), [path.final]);
      assert(!r.editor.dirty(), "v2 proof adopted exactly the captured revision");
    } finally { r.editor.dispose(); }
  });
}

Deno.test("resource path: a recorded image missing from the stale listing still varies other inputs", async () => {
  const r = await rig({ current: "gone.png", listing: ["origin.png"] });
  try {
    r.editor.edit("numeric", paramId("k", "seed"), "enabled", true); r.editor.edit("numeric", paramId("k", "seed"), "mode", "value"); r.editor.edit("numeric", paramId("k", "seed"), "value", "7");
    const result = await r.editor.run();
    assertEquals(result.adopted, true, r.editor.result()?.text);
    assertEquals(r.jobs.map(job => [job.prompt.image.inputs.image, job.prompt.k.inputs.seed]), [["gone.png", 7]]);
  } finally { r.editor.dispose(); }
});

Deno.test("resource path: an upload made after the cached listing is accepted by final validation", async () => {
  const r = await rig();
  try {
    r.editor.setEnabled(IMAGE, true);
    r.editor.addImages(IMAGE, [{ kind: "upload", name: "a.png", file: new File(["a"], "a.png") }, { kind: "upload", name: "b.png", file: new File(["b"], "b.png") }]);
    await r.editor.inspectImages();
    const result = await r.editor.run();
    assertEquals(result.adopted, true, r.editor.result()?.text);
    assertEquals(r.b.fetches.length, 1, "run reused the probe-time listing, which predates both uploads");
    assertEquals(r.jobs.map(job => job.prompt.image.inputs.image), ["a.png", "b.png"]);
    assertEquals([...r.b.files.keys()].filter(name => ["a.png", "b.png"].includes(name)).map(name => r.b.files.get(name)), ["a", "b"]);
  } finally { r.editor.dispose(); }
});

Deno.test("resource path: partial upload failure and uncertain Run keep the whole draft and never retry", async () => {
  const r = await rig();
  try {
    let calls = 0;
    r.services.uploadInput = async (_host, form, expected) => { calls++; if (calls === 2) throw new Error("disk full");
      return { name: r.b.store(form.get("image").name, await form.get("image").text()), origin: { ...expected } }; };
    r.editor.setEnabled(IMAGE, true);
    const files = [new File(["a"], "a.png"), new File(["b"], "b.png")];
    r.editor.addImages(IMAGE, files.map(file => ({ kind: "upload", name: file.name, file })));
    await r.editor.inspectImages();
    const failed = await r.editor.run();
    assertEquals([failed.adopted, r.requests.length, r.jobs.length, calls], [false, 0, 0, 2]);
    assertEquals(r.editor.result().effects.uploads.map(receipt => receipt.name), ["a.png"]);
    assert(r.editor.dirty()); assertEquals(r.editor.rows("images")[IMAGE].items.map(item => item.file), files);
    r.services.uploadInput = async (_host, form, expected) => ({ name: r.b.store(form.get("image").name, await form.get("image").text()), origin: { ...expected } });
    r.services.run = async () => { throw new Error("connection reset"); };
    const uncertain = await r.editor.run();
    assertEquals([uncertain.adopted, r.editor.result().outcome, r.jobs.length], [false, "uncertain-effects", 0]);
    assert(r.editor.dirty()); assertEquals(r.editor.rows("images")[IMAGE].items.map(item => item.file), files);
  } finally { r.editor.dispose(); }
});

Deno.test("resource path: source retirement after inspection authorizes no transfer or Run", async () => {
  const r = await rig();
  try {
    r.editor.setEnabled(IMAGE, true);
    r.editor.addImages(IMAGE, [{ kind: "upload", name: "fresh.png", file: new File(["fresh"], "fresh.png") }]);
    await r.editor.inspectImages();
    r.origins.fake = { ...r.origin, incarnation: "replacement" };
    const result = await r.editor.run();
    assertEquals([result.status, r.transfers.uploads.length, r.requests.length, r.jobs.length], ["stale", 0, 0, 0]);
    assert(r.editor.dirty());
  } finally { r.editor.dispose(); }
});

Deno.test("closed choices: an undeclared ordinary enum value still rejects before enqueue", async () => {
  const r = await rig();
  try {
    const request = { id: "fake:source.png", host: "fake", filename: "source.png", ranges: {}, context: r.catalogue.context,
      imageParams: { [paramId("k", "sampler_name")]: { enabled: true, values: ["not-a-sampler"] } },
      acknowledgement: { version: 2, runId: crypto.randomUUID(), requestId: crypto.randomUUID() } };
    const response = await r.services.run(request);
    assertEquals(response.status, 400); assertMatch(response.data.error, /not a declared option/); assertEquals(r.jobs.length, 0);
    const resource = { ...request, imageParams: { [IMAGE]: { enabled: true, values: ["../escape.png"] } } };
    const shaped = await r.services.run(resource);
    assertEquals(shaped.status, 400); assertMatch(shaped.data.error, /invalid resource path/); assertEquals(r.jobs.length, 0);
  } finally { r.editor.dispose(); }
});

const autogrowGraph = second => ({ image: { class_type: "LoadImage", inputs: { image: "origin.png" } },
  ckpt: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "model.safetensors" } },
  batch: { class_type: "BatchImagesNode", inputs: { "images.image0": ["image", 0], "images.image1": second } },
  k: { class_type: "KSampler", inputs: { seed: 1, sampler_name: "euler", model: ["ckpt", 0] } },
  out: { class_type: "SaveImage", inputs: { filename_prefix: "source", images: ["batch", 0] } } });

for (const [name, second, accepted] of [["valid IMAGE", ["image", 0], true], ["invalid CLIP", ["ckpt", 1], false]]) {
  Deno.test(`autogrow: ${name} link ${accepted ? "reaches" : "rejects before"} the backing`, async () => {
    const r = await rig({ graph: autogrowGraph(second) });
    try {
      const child = r.catalogue.parameters.find(parameter => parameter.id === paramId("batch", "images.image1"));
      assertEquals([child.schema.status, child.schema.type, child.contract.role], ["known", "IMAGE", "connection"]);
      r.editor.edit("numeric", paramId("k", "seed"), "enabled", true); r.editor.edit("numeric", paramId("k", "seed"), "mode", "value"); r.editor.edit("numeric", paramId("k", "seed"), "value", "2");
      const result = await r.editor.run();
      assertEquals(result.adopted, accepted, r.editor.result()?.text);
      assertEquals(r.jobs.length, accepted ? 1 : 0);
      if (!accepted) assertMatch(r.editor.result().text, /Incompatible link type: batch\.images\.image1 expects IMAGE, received CLIP/);
      else assertEquals(r.jobs[0].prompt.batch.inputs["images.image1"], ["image", 0]);
    } finally { r.editor.dispose(); }
  });
}

Deno.test("autogrow: the editor rejects a known-incompatible connection candidate before Run", async () => {
  const r = await rig({ graph: autogrowGraph(["image", 0]) });
  try {
    const id = paramId("batch", "images.image1");
    r.editor.setEnabled(id, true); r.editor.connection(id, 0, "ckpt", "1");
    assertEquals(r.editor.preview().status, "invalid");
    await assertRejects(async () => { const result = await r.editor.run(); if (!result.adopted) throw new Error(r.editor.result().text); }, Error, "expects IMAGE");
    assertEquals([r.requests.length, r.jobs.length], [0, 0]);
  } finally { r.editor.dispose(); }
});

// --- review corrections: provider vs file resource, nested slot branches, image ownership ---

Deno.test("contract: a remote option provider is listing evidence, not a file resource", () => {
  const remote = inputContract({ type: "COMBO", options: [1, 2], remote: { route: "/options/numbers" }, section: "required" });
  assertEquals([remote.role, remote.resource, remote.choices.evidence, remote.choices.provider, remote.choices.route], ["value", null, "listing", "remote", "/options/numbers"]);
  const graph = n => ({ x: { class_type: "Remote", inputs: { pick: n } } }), parameter = { id: "x.pick", key: "pick", nodeIds: ["x"] };
  const schema = { declarations: new Map([["Remote.pick", { type: "COMBO", options: [1, 2], remote: { route: "/options/numbers" }, section: "required" }]]) };
  validateParameterValue(graph(3), parameter, schema);
  validateParameterValue(graph(1), parameter, schema);
  let error = null; try { admitResourceTransfer({ id: "x.pick", contract: remote }); } catch (problem) { error = problem.message; }
  assertMatch(error, /not uploaded files/);
  // Real file pickers keep their resource contract, with the provider retained.
  const output = inputContract({ type: "COMBO", image_upload: true, image_folder: "output", remote: { route: "/internal/files/output" } });
  assertEquals([output.role, output.resource.media, output.resource.root, output.resource.provider, output.choices.provider], ["resource", "image", "output", "remote", "remote"]);
  assertEquals(inputContract({ type: "COMBO", options: [], image_folder: "temp" }).resource, { media: "image", upload: false, root: "temp", provider: "listing" });
  // Ordinary closed enums stay strict.
  const closed = { declarations: new Map([["Remote.pick", { type: "COMBO", options: [1, 2], section: "required" }]]) };
  let strict = null; try { validateParameterValue(graph(3), parameter, closed); } catch (problem) { strict = problem.message; }
  assertMatch(strict, /not a declared option/);
});

Deno.test("contract: DynamicSlot keeps its nested DynamicCombo branches, defaults and selected declarations", () => {
  const schema = objectInfoView({ Control: { input: { required: { slot: ["COMFY_DYNAMICSLOT_V3", { slotType: "IMAGE", inputs: { required: {
    mode: ["COMFY_DYNAMICCOMBO_V3", { options: [{ key: "on", inputs: { required: { gain: ["FLOAT", { default: 0.5, min: 0, max: 1 }] } } },
      { key: "off", inputs: { required: { level: ["INT", { default: 3, lazy: true }] } } }] }],
  } } }] } }, output: ["IMAGE"] }, Source: { input: {}, output: ["IMAGE"] } });
  assertEquals(schema.schemaError, null);
  const branches = schema.dynamicCombos.get("Control.slot.mode");
  assertEquals([...branches.keys()], ["on", "off"]);
  assertEquals([...branches.get("off").defaults], [["Control.slot.mode.level", 3]]);
  const graph = { control: { class_type: "Control", inputs: { slot: ["source", 0], "slot.mode": "on", "slot.mode.gain": 0.5 } },
    source: { class_type: "Source", inputs: {} }, out: { class_type: "SaveImage", inputs: { images: ["control", 0], filename_prefix: "x" } } };
  const parameters = graphParameters(graph, schema), gain = parameters.find(p => p.key === "slot.mode.gain");
  assertEquals([gain.schema.status, gain.schema.type, gain.schema.max, gain.contract.role], ["known", "FLOAT", 1, "value"]);
  let error = null; try { validateFinalGraph({ ...graph, control: { ...graph.control, inputs: { ...graph.control.inputs, "slot.mode.gain": 2 } } }, parameters, schema); } catch (problem) { error = problem.message; }
  assertMatch(error, /slot%2Emode%2Egain|slot\.mode\.gain/); assertMatch(error, /above the declared maximum/);
  // Switching the nested branch writes only that branch's real defaults; the selected declaration validates it.
  const mode = parameters.find(p => p.key === "slot.mode");
  const { graph: switched } = mutateGraph(graph, { [mode.id]: "off" }, parameters, schema.dynamicCombos);
  assertEquals(switched.control.inputs, { slot: ["source", 0], "slot.mode": "off", "slot.mode.level": 3 });
  validateFinalGraph(switched, parameters, schema);
  assertEquals(inputDeclaration(switched.control, "slot.mode.level", schema), { type: "INT", section: "required", default: 3, lazy: true });
  assertEquals(mode.contract.role, "value", "the nested selector is a widget, not a connection");
});

Deno.test("contract: a known image resource owns the image editor whatever its recorded spelling", () => {
  const schema = objectInfoView({ CustomImage: { input: { required: { reference: [["frame.dat"], { image_upload: true }] } } } });
  for (const [recorded, current, fromOutput] of [["frame.dat", "frame.dat", false], ["", "", false], ["photo [draft]", "photo [draft]", false],
    ["nested/a [b].png [output]", "nested/a [b].png", true], ["shot.png [temp]", "shot.png", false], ["x[output]", "", true]]) {
    const [image] = graphParameters({ r: { class_type: "CustomImage", inputs: { reference: recorded } } }, schema);
    assertEquals([image.kind, image.current, image.currentValue, image.fromOutput, editorDomain(image)], ["image", current, recorded, fromOutput, "images"], recorded);
  }
  assertEquals(resourceReference("photo [draft]"), { name: "photo [draft]", root: "input", annotated: false });
  assertEquals(resourceReference("a.png [input]"), { name: "a.png", root: "input", annotated: true });
  // Without declarations, the legacy class/extension discovery is unchanged.
  const [offline] = graphParameters({ r: { class_type: "LoadImage", inputs: { image: "frame.dat" } } });
  assertEquals([offline.kind, offline.legacyEditable], ["string", false]);
  const [legacy] = graphParameters({ r: { class_type: "LoadImage", inputs: { image: "a.png [output]" } } });
  assertEquals([legacy.kind, legacy.current, legacy.fromOutput], ["image", "a.png", true]);
});

Deno.test("contract: literal values under a socket-typed declaration stay literal editors", () => {
  const schema = objectInfoView({ Typed: { input: { required: { custom: ["CUSTOM", {}], image: ["IMAGE", {}] } } } });
  const parameters = graphParameters({ t: { class_type: "Typed", inputs: { custom: { a: 1 }, image: "literal" } }, s: { class_type: "Typed", inputs: { custom: null, image: ["t", 0] } } }, schema);
  const domains = Object.fromEntries(parameters.map(p => [p.id, [p.contract.role, p.valueKind, editorDomain(p)]]));
  assertEquals(domains, { "t.custom": ["connection", "object", "candidates"], "t.image": ["connection", "string", "texts"],
    "s.custom": ["connection", "null", "candidates"], "s.image": ["connection", "connection", "candidates"] });
});
