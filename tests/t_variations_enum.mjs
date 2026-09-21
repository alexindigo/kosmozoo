// tests/t_variations_enum.mjs — per-node enum sweep axes: the backing's
// enums map, the probe's enumParams, and picks landing on the right node.

import { assert, assertEquals } from "jsr:@std/assert";
import { objectInfo } from "../src/backings/comfy.mjs";
import {
  enumParams, inspectGraph, stringParams, mutateGraph,
} from "../src/features/variations/server.mjs";
import { generatePermutations } from "../src/features/variations/shared.mjs";
import { buildContext } from "../src/context.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIXTURES = new URL("./fixtures", import.meta.url).pathname;

const LORA_OPTIONS = ["detail.safetensors", "style.safetensors", "other.safetensors"];
const SAMPLER_OPTIONS = ["euler", "dpmpp_2m", "uni_pc"];

// object_info with combo widgets (enum specs) beside the scalar types
const OBJECT_INFO = {
  LoraLoader: {
    input: {
      required: {
        lora_name: [LORA_OPTIONS, {}],
        strength_model: ["FLOAT", {}],
        strength_clip: ["FLOAT", {}],
      },
    },
  },
  LoraLoaderModelOnly: {
    input: {
      required: {
        lora_name: [LORA_OPTIONS, {}],
        strength_model: ["FLOAT", {}],
      },
    },
  },
  KSamplerSelect: { input: { required: { sampler_name: [SAMPLER_OPTIONS, {}] } } },
  BasicScheduler: { input: { required: { steps: ["INT", {}], denoise: ["FLOAT", {}] } } },
  // the other combo shape: "COMBO" with the options in the widget config
  // (and a duplicate entry — the host's list is published verbatim)
  ImageScaleToMaxDimension: {
    input: { required: {
      upscale_method: ["COMBO", { multiselect: false, options: ["area", "lanczos", "bilinear", "bilinear"] }],
      largest_size: ["INT", {}],
    } },
  },
  SaveImage: { output_node: true, input: { required: { filename_prefix: ["STRING", {}] } } },
};

// --- backing: objectInfo carries the per-field option lists -------------------

Deno.test("objectInfo: combo widgets surface as per-field enum option lists", async () => {
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1" }, (req) => {
    if (new URL(req.url).pathname === "/api/object_info") return Response.json(OBJECT_INFO);
    return new Response("nf", { status: 404 });
  });
  try {
    const { types, outputClasses, enums } = await objectInfo(`127.0.0.1:${server.addr.port}`);
    assertEquals(enums.get("LoraLoaderModelOnly.lora_name"), LORA_OPTIONS);
    assertEquals(enums.get("LoraLoader.lora_name"), LORA_OPTIONS);
    assertEquals(enums.get("KSamplerSelect.sampler_name"), SAMPLER_OPTIONS);
    // the "COMBO" + widget-config options shape, deduped
    assertEquals(enums.get("ImageScaleToMaxDimension.upscale_method"), ["area", "lanczos", "bilinear"]);
    // scalar types + output classes unchanged
    assertEquals(types.get("LoraLoader.strength_model"), "FLOAT");
    assertEquals(types.get("BasicScheduler.steps"), "INT");
    assert(outputClasses.has("SaveImage"));
    // STRING specs and scalar types are not enums
    assertEquals(enums.get("SaveImage.filename_prefix"), undefined);
    assertEquals(enums.get("BasicScheduler.steps"), undefined);
  } finally {
    await server.shutdown();
  }
});

// --- enumParams: per-node rows, per-field options, LoadImage excluded ---------

Deno.test("enumParams: one row per node instance, options from THAT field only", () => {
  const enums = new Map([
    ["LoraLoader.lora_name", LORA_OPTIONS],
    ["KSamplerSelect.sampler_name", SAMPLER_OPTIONS],
    ["LoadImage.image", ["a.png", "b.png"]], // the imgRows own this field
  ]);
  const graph = {
    "8": { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
    "20": { class_type: "LoraLoader", inputs: {
      lora_name: "detail.safetensors", strength_model: 0.8, model: ["1", 0], clip: ["3", 0],
    } },
    "21": { class_type: "LoraLoader", inputs: {
      lora_name: "style.safetensors", strength_model: 0.5, model: ["20", 0], clip: ["20", 1],
    }, _meta: { title: "style lora" } },
    "30": { class_type: "LoadImage", inputs: { image: "a.png" } },
    "31": { class_type: "CLIPTextEncode", inputs: { text: "fish" } }, // no enum published
  };
  const rows = enumParams(graph, enums);
  assertEquals(rows.length, 3);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  // per-NODE ids (unlike the multi-carrier numeric params)
  assertEquals(byId["LoraLoader#20.lora_name"].current, "detail.safetensors");
  assertEquals(byId["LoraLoader#20.lora_name"].values, LORA_OPTIONS);
  assertEquals(byId["LoraLoader#20.lora_name"].nodeIds, ["20"]);
  assertEquals(byId["LoraLoader#21.lora_name"].current, "style.safetensors");
  assertEquals(byId["LoraLoader#21.lora_name"].title, "style lora");
  assertEquals(byId["KSamplerSelect#8.sampler_name"].values, SAMPLER_OPTIONS);
  // LoadImage.image excluded even though the host lists options for it
  assertEquals(byId["LoadImage#30.image"], undefined);
  // strings without a published option list get no row
  assert(rows.every((r) => r.key !== "text"));
});

Deno.test("enumParams: no enums from the host → no rows", () => {
  const graph = { "20": { class_type: "LoraLoader", inputs: { lora_name: "x.safetensors" } } };
  assertEquals(enumParams(graph, null), []);
  assertEquals(enumParams(graph, new Map()), []);
});

// --- run: picks land on the right node; the all-current combo is excluded -----

Deno.test("run path: a picked lora_name mutates ONLY its own node", () => {
  const enums = new Map([["LoraLoader.lora_name", LORA_OPTIONS]]);
  const graph = {
    "20": { class_type: "LoraLoader", inputs: {
      lora_name: "detail.safetensors", strength_model: 0.8, model: ["1", 0], clip: ["3", 0],
    } },
    "21": { class_type: "LoraLoader", inputs: {
      lora_name: "style.safetensors", strength_model: 0.5, model: ["20", 0], clip: ["20", 1],
    } },
  };
  const full = [...inspectGraph(graph), ...stringParams(graph), ...enumParams(graph, enums)];
  const { graph: mutated, applied } = mutateGraph(
    graph, { "LoraLoader#21.lora_name": "other.safetensors" }, full,
  );
  assertEquals(applied, ["LoraLoader#21.lora_name"]);
  assertEquals(mutated["21"].inputs.lora_name, "other.safetensors");
  assertEquals(mutated["20"].inputs.lora_name, "detail.safetensors"); // untouched
  assertEquals(graph["21"].inputs.lora_name, "style.safetensors"); // the source is cloned, not mutated
});

Deno.test("run path: enum axes multiply cartesian-style, all-current combo excluded", () => {
  const currentValues = {
    "LoraLoader#20.lora_name": "detail.safetensors",
    "LoraLoader#21.lora_name": "style.safetensors",
  };
  const perms = generatePermutations({}, currentValues, {
    "LoraLoader#20.lora_name": { enabled: true, values: ["detail.safetensors", "x.safetensors"] },
    "LoraLoader#21.lora_name": { enabled: true, values: ["style.safetensors", "y.safetensors"] },
  });
  // 2 × 2 = 4 minus (detail, style) — the current combo → 3
  assertEquals(perms.length, 3);
  assert(!perms.some((p) =>
    p["LoraLoader#20.lora_name"] === "detail.safetensors" &&
    p["LoraLoader#21.lora_name"] === "style.safetensors"));
  assert(perms.some((p) =>
    p["LoraLoader#20.lora_name"] === "x.safetensors" &&
    p["LoraLoader#21.lora_name"] === "y.safetensors"));
});

// --- route level: the probe returns enumParams; the run enqueues the picks ----

Deno.test("probe + run routes: enumParams from the host's options, picks enqueued on the right node", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-enum-"));
  const enqueued = [];
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1" }, async (req) => {
    const p = new URL(req.url).pathname;
    if (p === "/api/prompt") { enqueued.push(await req.json()); return Response.json({ ok: true }); }
    if (p === "/api/object_info") return Response.json(OBJECT_INFO);
    if (p === "/api/view") {
      return new Response(Deno.readFileSync(join(FIXTURES, "flux-lora.png")), { headers: { ETag: '"e1"' } });
    }
    return new Response("nf", { status: 404 });
  });
  const addr = `127.0.0.1:${server.addr.port}`;
  try {
    const { ctx, router } = await buildContext({
      env: {
        HOME: dir, KOZMOZOO_STATE: dir, KOZMOZOO_CACHE: join(dir, "cache"),
        KOZMOZOO_HOSTS: `fake=${addr}`,
        KOZMOZOO_PLUGINS: join(dir, "no-plugins"),
      },
      start: false,
    });
    await ctx.ingest.ensure("fake", "flux-lora.png");

    // probe: the fixture graph's two LoraLoader nodes + the KSamplerSelect
    // surface with the host's option lists; nothing else
    const pr = await router.handle(new Request(
      "http://x/api/features/variations/probe/" + encodeURIComponent("fake:flux-lora.png"),
    ));
    assertEquals(pr.status, 200);
    const body = await pr.json();
    const byId = Object.fromEntries((body.enumParams ?? []).map((p) => [p.id, p]));
    assertEquals(Object.keys(byId).sort(), [
      "KSamplerSelect#8.sampler_name", "LoraLoader#20.lora_name", "LoraLoader#21.lora_name",
    ]);
    assertEquals(byId["LoraLoader#20.lora_name"].values, LORA_OPTIONS);
    assertEquals(byId["LoraLoader#20.lora_name"].current, "detail.safetensors");
    assertEquals(byId["LoraLoader#21.lora_name"].current, "style.safetensors");
    assertEquals(byId["KSamplerSelect#8.sampler_name"].values, SAMPLER_OPTIONS);

    // run: sweep node 21's lora over [current, other] → only "other" enqueues,
    // on node 21 alone
    const rr = await router.handle(new Request("http://x/api/features/variations/run", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "fake:flux-lora.png", host: "fake", filename: "flux-lora.png",
        ranges: {},
        imageParams: {
          "LoraLoader#21.lora_name": { enabled: true, values: ["style.safetensors", "other.safetensors"] },
        },
        prefix: "v_", suffix: "",
      }),
    }));
    assertEquals(rr.status, 200);
    const rbody = await rr.json();
    assertEquals(rbody.total, 1); // the current combo is excluded
    assertEquals(rbody.submitted, 1);
    assertEquals(enqueued.length, 1);
    const prompt = enqueued[0].prompt;
    assertEquals(prompt["21"].inputs.lora_name, "other.safetensors");
    assertEquals(prompt["20"].inputs.lora_name, "detail.safetensors"); // the other loader untouched

    ctx.prefetch.stop();
  } finally {
    await server.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});
