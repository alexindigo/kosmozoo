import { assert, assertEquals, assertThrows } from "jsr:@std/assert";
import * as naming from "../src/features/variations/shared.mjs";
import { register, narrowToOneOutputNode, wrapAllOutputPrefixes } from "../src/features/variations/server.mjs";
import { makeCollectionLifecycle } from "../src/backings/index.mjs";
import { makeVariationEditor } from "../client-solid/features/variations/editor.js";
import { typedRunRig } from "./helpers/typed-run.mjs";
import { parseExactJson, parameterCurrent, parameterAliases } from "../src/parameters.mjs";
import { objectInfoView } from "../src/backings/comfy.mjs";
import { saveImage } from "./helpers/comfy-object-info.mjs";

Deno.test("selected output name: stable producer composes every candidate, preserves manual text and exact v2 proof", async () => {
  const graph = { node: { class_type: "Custom", inputs: { value: false } },
    save: { class_type: "SaveImage", inputs: { filename_prefix: "source", images: ["node", 0] } },
    other: { class_type: "SaveImage", inputs: { filename_prefix: "chosen", images: ["node", 0] } } };
  const before = structuredClone(graph), rig = typedRunRig({ graph });
  const catalogue = await rig.probe();
  const body = await rig.request({ "save.filename_prefix": { enabled: true, values: ["chosen", "other"] } });
  body.prefix = "v_"; body.suffix = "_s";
  const result = await rig.run(body);
  assertEquals(result.status, 200, JSON.stringify(result.data)); assertEquals(rig.bytes.length, 2);
  assertEquals(catalogue.outputNaming.nodeId, "save");
  const current = Object.fromEntries(catalogue.parameters.map(p => [p.id, parameterCurrent(p)]));
  for (const [index, candidate] of ["chosen", "other"].entries()) {
    const actual = parseExactJson(rig.bytes[index]);
    assertEquals(actual.prompt.save.inputs.filename_prefix, `v_${candidate}_s`);
    assert(!Object.hasOwn(actual.prompt, "other"));
    const preview = naming.variationOutputName(catalogue.outputNaming, body, { "save.filename_prefix": candidate }, current,
      parameterAliases(catalogue.parameters), catalogue.parameters);
    assertEquals(preview.value, actual.prompt.save.inputs.filename_prefix);
    assertEquals(actual.extra_data.extra_pnginfo.kz.params["save.filename_prefix"], candidate);
    const directory = Deno.env.get("KZ_TYPED_EVIDENCE");
    if (directory) { await Deno.mkdir(`${directory}/naming`, { recursive: true }); await Deno.writeTextFile(`${directory}/naming/prompt-${index + 1}.json`, rig.bytes[index]); }
  }
  assert(naming.acknowledgedFields(body, result.data));
  assertEquals(result.data.acknowledgement.accepted.map(a => a.applied.imageParams), [["save.filename_prefix"], ["save.filename_prefix"]]);
  assertEquals([body.prefix, body.suffix], ["v_", "_s"]); assertEquals(graph, before);
});

Deno.test("selected output name: retained dependency writes stay exact; selected pruned outputs reject all candidates", async () => {
  const graph = { node: { class_type: "Custom", inputs: {} },
    ancestor: { class_type: "SaveImageAndPass", inputs: { filename_prefix: "ancestor", images: ["node", 0] } },
    save: { class_type: "SaveImage", inputs: { filename_prefix: "source", images: ["ancestor", 0] } },
    other: { class_type: "SaveImage", inputs: { filename_prefix: "other", images: ["node", 0] } } };
  const schema = objectInfoView({ Custom: { output: ["IMAGE"] }, SaveImage: saveImage(),
    SaveImageAndPass: { ...saveImage(), output: ["IMAGE"] } });
  const rig = typedRunRig({ graph, schema });
  const body = await rig.request({ "save.filename_prefix": { enabled: true, values: ["chosen"] }, "ancestor.filename_prefix": { enabled: true, values: ["retained"] } });
  body.prefix = "v_"; body.suffix = "_s";
  const result = await rig.run(body); assertEquals(result.status, 200);
  const actual = parseExactJson(rig.bytes[0]).prompt;
  assertEquals(actual.save.inputs.filename_prefix, "v_chosen_s");
  assertEquals(actual.ancestor.inputs.filename_prefix, "retained");
  assert(!Object.hasOwn(actual, "other")); assert(naming.acknowledgedFields(body, result.data));
  const rejected = typedRunRig({ graph, schema });
  body.imageParams["other.filename_prefix"] = { enabled: true, values: ["one", "two"] };
  body.context = (await rejected.probe()).context;
  const failure = await rejected.run(body);
  assertEquals(failure.status, 400); assertEquals(rejected.bytes, []); assert(failure.data.error.includes("pruned"));
});

Deno.test("selected output name: late unsupported types, paths or lossy names enqueue nothing", async () => {
  const graph = { node: { class_type: "Custom", inputs: {} }, save: { class_type: "SaveImage", inputs: { filename_prefix: "source", images: ["node", 0] } } };
  for (const invalid of [null, false, .5, {}, [], "other/chosen", "../escape", "/absolute", "a\\b", "a\u0000b", "x".repeat(201)]) {
    const rig = typedRunRig({ graph });
    const body = await rig.request({ "save.filename_prefix": { enabled: true, values: ["chosen", invalid] } });
    body.prefix = "v_"; body.suffix = "_s";
    const result = await rig.run(body);
    assertEquals(result.status, 400, String(invalid)); assertEquals(rig.bytes, []); assertEquals(result.data.acknowledgement.accepted, []);
  }
  const nested = structuredClone(graph); nested.save.inputs.filename_prefix = "folder/source";
  const rig = typedRunRig({ graph: nested, filename: "folder/source_00001_.png" });
  const body = await rig.request({ "save.filename_prefix": { enabled: true, values: ["folder/chosen"] } });
  body.prefix = "v_"; body.suffix = "_s";
  assertEquals((await rig.run(body)).status, 200);
  assertEquals(parseExactJson(rig.bytes[0]).prompt.save.inputs.filename_prefix, "folder/v_chosen_s");
});

Deno.test("selected output name: fallback composes each original output independently with the same preview owner", async () => {
  const graph = { node: { class_type: "Custom", inputs: {} },
    first: { class_type: "SaveImage", inputs: { filename_prefix: "alpha", images: ["node", 0] } },
    second: { class_type: "SaveImage", inputs: { filename_prefix: "beta", images: ["node", 0] } } };
  const rig = typedRunRig({ graph }), catalogue = await rig.probe();
  const body = await rig.request({ "first.filename_prefix": { enabled: true, values: ["chosen", "beta"] } });
  body.prefix = "v_"; body.suffix = "_s";
  const result = await rig.run(body);
  assertEquals(result.status, 200); assert(naming.acknowledgedFields(body, result.data));
  const current = Object.fromEntries(catalogue.parameters.map(p => [p.id, parameterCurrent(p)]));
  for (const [index, candidate] of ["chosen", "beta"].entries()) {
    const actual = parseExactJson(rig.bytes[index]).prompt;
    assertEquals(Object.keys(actual), ["node", "first", "second"]);
    assertEquals(actual.first.inputs.filename_prefix, `v_${candidate}_s`);
    assertEquals(actual.second.inputs.filename_prefix, "v_beta_s");
    for (const target of catalogue.outputNamingTargets) {
      const preview = naming.variationOutputName(target, body, { "first.filename_prefix": candidate }, current, {}, catalogue.parameters);
      assertEquals(preview.value, actual[target.nodeId].inputs.filename_prefix);
    }
  }
});

Deno.test("selected output name: automatic contributions remain separate from fixed base and exact manual text", async () => {
  const graph = { node: { class_type: "Custom", inputs: { flag: null } },
    save: { class_type: "SaveImage", inputs: { filename_prefix: "source", images: ["node", 0] } } };
  const rig = typedRunRig({ graph }), catalogue = await rig.probe();
  const body = await rig.request({ "save.filename_prefix": { enabled: true, values: ["chosen"] },
    "node.flag": { enabled: true, values: [false, true, true] } });
  body.prefix = "v_"; body.suffix = "_manual_{node.flag}"; body.automaticNaming = true;
  const before = structuredClone(body), current = Object.fromEntries(catalogue.parameters.map(p => [p.id, parameterCurrent(p)]));
  assertEquals(naming.automaticNaming({}, current, body.imageParams), { ids: ["node.flag"], suffix: "_{node.flag}" });
  const result = await rig.run(body);
  assertEquals(result.status, 200); assert(naming.acknowledgedFields(body, result.data));
  for (const [index, flag] of [false, true].entries()) {
    const actual = parseExactJson(rig.bytes[index]).prompt;
    assertEquals(actual.save.inputs.filename_prefix, `v_chosen_manual_${flag}_${flag}`);
    assertEquals(naming.variationOutputName(catalogue.outputNaming, body, { "save.filename_prefix": "chosen", "node.flag": flag }, current, {}, catalogue.parameters).value,
      actual.save.inputs.filename_prefix);
  }
  assertEquals(body, before);
});

Deno.test("selected output name: supported empty and whitespace candidates remain exact", async () => {
  const graph = { node: { class_type: "Custom", inputs: {} },
    save: { class_type: "SaveImage", inputs: { filename_prefix: "source", images: ["node", 0] } } };
  const rig = typedRunRig({ graph });
  const body = await rig.request({ "save.filename_prefix": { enabled: true, values: ["", "  chosen  "] } });
  body.prefix = "v_"; body.suffix = "_s";
  const result = await rig.run(body);
  assertEquals(result.status, 200); assert(naming.acknowledgedFields(body, result.data));
  assertEquals(rig.bytes.map(text => parseExactJson(text).prompt.save.inputs.filename_prefix), ["v__s", "v_  chosen  _s"]);
});

const bytes = value => new TextEncoder().encode(value).length;
const exact = "Qwen_image_2.1_00500_athena_alisa_seed_2.png_00001_alisa_style_donor.png_00001_amaterasu_seed_00_6.png_00001.png";
const outputs = new Set(["SaveImage"]);

async function rig(filename = exact, sourcePrefix = "Qwen_image_2.1", prefix = "pre_", suffix = "_{image.image}_{sampler.seed}_done", imageNames = [exact]) {
  const graph = {
    image: { class_type: "LoadImage", inputs: { image: "original.png" } },
    sampler: { class_type: "Sampler", inputs: { seed: 0, image: ["image", 0] } },
    output: { class_type: "SaveImage", inputs: { filename_prefix: sourcePrefix, images: ["sampler", 0] } },
  };
  const lifecycle = makeCollectionLifecycle({ fake: "in-memory:8188" }), token = lifecycle.capture("fake");
  const origin = { source: "fake", address: token.address, kind: "comfy", epoch: "output-names", incarnation: token.incarnation };
  const routes = new Map(), jobs = [];
  register({ store: { hashFor: () => "a".repeat(64) }, ingest: { graph: async () => structuredClone(graph) },
    backings: { accepting: () => true, capture: lifecycle.capture, isCurrent: lifecycle.isCurrent, source: () => ({ ...origin, sourceVersion: origin }),
      comfy: () => ({ objectInfo: async () => ({ types: new Map(), enums: new Map(), outputClasses: outputs }),
        enqueue: async job => { jobs.push(job); return { ok: true, acceptance: "confirmed", promptId: `name-${jobs.length}` }; } }) },
    route: (method, path, handler) => routes.set(method + path, handler) });
  const target = { id: `fake:${filename}`, host: "fake", filename, origin };
  const catalogue = await (await routes.get("GET/probe/<id>")(new Request("http://x/probe"), { id: target.id })).json();
  const request = { ...target, context: catalogue.context, prefix, suffix,
    ranges: { "sampler.seed": { enabled: true, min: 1, max: 2, increment: 1 } },
    imageParams: { "image.image": { enabled: true, values: imageNames } },
    acknowledgement: { version: 2, runId: crypto.randomUUID(), requestId: crypto.randomUUID() } };
  const run = async () => {
    const response = await routes.get("POST/run")(new Request("http://x/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) }));
    return { status: response.status, data: await response.json() };
  };
  return { target, catalogue, jobs, request, run };
}

Deno.test("output naming: whole long affixes, only the source stem folds", () => {
  const prefix = "p".repeat(110), suffix = "s".repeat(70);
  const name = naming.outputName({ prefix, sourceStem: "x".repeat(300), suffix, budget: 200 });
  assertEquals(name, prefix + "x".repeat(10) + "~" + "x".repeat(9) + suffix);
  assertEquals(bytes(name), 200);
});

Deno.test("output naming: UTF-8 budgets never split a code point, including tiny remaining budgets", () => {
  for (const prefix of ["префикс_", "🦊".repeat(20)]) for (const suffix of ["_хвост", "🌌".repeat(20)]) {
    const affixes = bytes(prefix + suffix);
    for (const room of [0, 1, 2, 3, 4, 9, 37]) {
      const name = naming.outputName({ prefix, sourceStem: "дракон🐉".repeat(80), suffix, budget: affixes + room });
      assert(name.startsWith(prefix) && name.endsWith(suffix));
      assert(bytes(name) <= affixes + room); assert(!/[\uD800-\uDFFF]/u.test(name));
    }
  }
});

Deno.test("output naming: only affixes alone over budget reject with actual byte lengths", () => {
  assertThrows(() => naming.outputName({ prefix: "п".repeat(100), sourceStem: "x", suffix: "s".repeat(10), budget: 185 }), Error,
    "Prefix and suffix are 210 bytes; the limit is 185 bytes");
  assertEquals(naming.outputName({ prefix: "p", sourceStem: "x".repeat(10000), suffix: "s", budget: 2 }), "ps");
});

Deno.test("output naming: every token kind is bounded to 40 UTF-8 bytes, images lose only their extension", () => {
  const params = ["image", "text", "enum", "numeric"].map(kind => ({ id: `${kind}.value`, kind }));
  const aliases = { "image.value": ["image", "LoadImage.image"] };
  for (const kind of ["image", "text", "enum", "numeric"]) {
    const value = "я🐉".repeat(30) + "_00042_" + (kind === "image" ? ".png" : "");
    const result = naming.templateReplace(`{${kind}.value}`, { [`${kind}.value`]: value }, {}, aliases, params);
    assert(bytes(result) <= 40); assert(result.includes("~")); assert(result.endsWith("_00042_"));
    assert(!/[\uD800-\uDFFF]/u.test(result));
  }
  assertEquals(naming.templateReplace("{image}_{LoadImage.image}", { "image.value": "dragon.png" }, {}, aliases, params), "dragon_dragon");
  assertEquals(naming.templateReplace("{numeric.value}", { "numeric.value": .65 }, {}, {}, params), "0.65");
  const a = "a".repeat(80) + "_00001_.png", b = "a".repeat(80) + "_00002_.png";
  assert(naming.templateReplace("{image.value}", { "image.value": a }, {}, {}, params) !==
    naming.templateReplace("{image.value}", { "image.value": b }, {}, {}, params));
});

Deno.test("output naming: both graph writers use the same byte-budgeted affix contract", () => {
  const prefix = "пре".repeat(20), suffix = "🐉".repeat(10), sourceStem = "source".repeat(100);
  const expected = naming.outputName({ prefix, sourceStem, suffix });
  const graph = { output: { class_type: "SaveImage", inputs: { filename_prefix: "folder/" + sourceStem } } };
  const narrow = structuredClone(graph), wrap = structuredClone(graph);
  narrowToOneOutputNode(narrow, "output", sourceStem, prefix, suffix, outputs);
  wrapAllOutputPrefixes(wrap, prefix, suffix, outputs);
  assertEquals(narrow.output.inputs.filename_prefix, "folder/" + expected);
  assertEquals(wrap.output.inputs.filename_prefix, "folder/" + expected);
  assert(bytes(expected) <= 200);
});

Deno.test("output naming: the user's exact source and image-token name are accepted in both output paths", async () => {
  for (const sourcePrefix of ["Qwen_image_2.1", "unmatched"]) {
    const r = await rig(exact, sourcePrefix), { status, data } = await r.run();
    assertEquals(status, 200); assertEquals(data.submitted, 2);
    for (const [index, job] of r.jobs.entries()) {
      const name = job.prompt.output.inputs.filename_prefix;
      assert(name.startsWith("pre_") && name.endsWith(`_${index + 1}_done`));
      assert(!name.endsWith(`.png_${index + 1}_done`)); assert(bytes(name) <= 200);
    }
  }
});

Deno.test("output naming: 12 generations remain admitted, whole-affixed, byte-bounded and permutation-distinct", async () => {
  let filename = "ComfyUI_00001_.png", producer = "ComfyUI";
  for (let generation = 0; generation < 12; generation++) {
    const r = await rig(filename, producer, "v_", "_{image.image}_seed_{sampler.seed}", [filename]);
    const { status, data } = await r.run(); assertEquals(status, 200, JSON.stringify(data)); assertEquals(data.submitted, 2);
    const names = r.jobs.map(job => job.prompt.output.inputs.filename_prefix);
    assertEquals(new Set(names).size, 2);
    for (const [index, name] of names.entries()) {
      const token = naming.templateReplace("{image.image}", { "image.image": filename }, {}, {}, [{ id: "image.image", kind: "image" }]);
      assert(name.startsWith("v_") && name.endsWith(`_${token}_seed_${index + 1}`)); assert(bytes(name) <= 200);
    }
    producer = names[0]; filename = producer + "_00001_.png";
  }
});

Deno.test("output naming: real client example equals the server's written prefix including folded stem", async () => {
  const prefix = "pre_".repeat(30), suffix = "_{image.image}_{sampler.seed}_done";
  for (const [filename, sourcePrefix] of [[exact, "Qwen_image_2.1"], [exact, "fallback-".repeat(30)], ["folder/" + exact, "folder/Qwen_image_2.1"]]) {
  const r = await rig(filename, sourcePrefix, prefix, suffix);
  const editor = makeVariationEditor({ targets: [r.target], currentOrigin: () => r.target.origin, services: {} });
  try {
    editor.installCatalogue(r.catalogue);
    editor.edit("numeric", "sampler.seed", "enabled", true);
    editor.edit("numeric", "sampler.seed", "min", "1"); editor.edit("numeric", "sampler.seed", "max", "2");
    editor.edit("numeric", "sampler.seed", "rawIncrement", "1");
    editor.edit("naming", "root", "prefix", prefix); editor.edit("naming", "root", "suffix", suffix);
    // Current image value is sufficient here: the same tuple is sent by both consumers.
    r.request.imageParams = {}; r.request.suffix = suffix;
    r.request.automaticNaming = true;
    const preview = editor.preview();
    const { status, data } = await r.run(); assertEquals(status, 200, JSON.stringify(data));
    assertEquals(preview.naming.example, r.jobs[0].prompt.output.inputs.filename_prefix);
    assert(preview.naming.example.includes("~"));
  } finally { editor.dispose(); }
  }
});
