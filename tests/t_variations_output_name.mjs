import { assert, assertEquals, assertThrows } from "jsr:@std/assert";
import * as naming from "../src/features/variations/shared.mjs";
import { register, narrowToOneOutputNode, wrapAllOutputPrefixes } from "../src/features/variations/server.mjs";
import { makeCollectionLifecycle } from "../src/backings/index.mjs";
import { makeVariationEditor } from "../client-solid/features/variations/editor.js";

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
    const response = await routes.get("POST/run")(new Request("http://x/run", { method: "POST", body: JSON.stringify(request) }));
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
    const preview = editor.preview();
    const { status, data } = await r.run(); assertEquals(status, 200, JSON.stringify(data));
    assertEquals(preview.naming.example, r.jobs[0].prompt.output.inputs.filename_prefix);
    assert(preview.naming.example.includes("~"));
  } finally { editor.dispose(); }
  }
});
