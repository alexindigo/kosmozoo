// tests/t_variations_text.mjs — per-node text sweep axes: prompts and other
// free-text inputs surface as user-valued axes; enums, LoadImage.image and
// the output nodes' filename_prefix stay with their own machinery.

import { assert, assertEquals } from "jsr:@std/assert";
import {
  textParams, inspectGraph, stringParams, mutateGraph,
} from "../src/features/variations/server.mjs";
import { generatePermutations } from "../src/features/variations/shared.mjs";
import { buildContext } from "../src/context.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIXTURES = new URL("./fixtures", import.meta.url).pathname;

// object_info mirroring a real host: every loader string is a combo (enum),
// only CLIPTextEncode.text and the output prefix remain free text
const OBJECT_INFO = {
  UNETLoader: { input: { required: { unet_name: [["flux1-dev.safetensors"], {}], weight_dtype: [["default"], {}] } } },
  CLIPLoader: { input: { required: { clip_name: [["t5xxl_fp16.safetensors"], {}], type: [["flux"], {}] } } },
  VAELoader: { input: { required: { vae_name: [["ae.safetensors"], {}] } } },
  KSamplerSelect: { input: { required: { sampler_name: [["euler"], {}] } } },
  BasicScheduler: { input: { required: { steps: ["INT", {}], denoise: ["FLOAT", {}], scheduler: [["simple"], {}] } } },
  SaveImage: { output_node: true, input: { required: { filename_prefix: ["STRING", {}] } } },
};

// --- textParams: discovery + exclusions ---------------------------------------

Deno.test("textParams: free-text inputs surface per node; enums, LoadImage, output prefix excluded", () => {
  const enums = new Map([
    ["LoraLoader.lora_name", ["a.safetensors"]],
    ["LoadImage.image", ["a.png", "b.png"]],
  ]);
  const out = new Set(["SaveImage"]);
  const graph = {
    "2": { class_type: "CLIPTextEncode", inputs: { text: "a portrait" } },
    "3": { class_type: "CLIPTextEncode", inputs: { text: "negative" }, _meta: { title: "neg prompt" } },
    "9": { class_type: "LoadImage", inputs: { image: "a.png" } },
    "11": { class_type: "SaveImage", inputs: { filename_prefix: "flux" } },
    "20": { class_type: "LoraLoader", inputs: { lora_name: "a.safetensors" } },
  };
  const rows = textParams(graph, enums, out);
  assertEquals(rows.length, 2);
  assertEquals(rows[0].id, "CLIPTextEncode#2.text");
  assertEquals(rows[0].current, "a portrait");
  assertEquals(rows[0].nodeIds, ["2"]);
  assertEquals(rows[1].id, "CLIPTextEncode#3.text");
  assertEquals(rows[1].title, "neg prompt");
});

Deno.test("textParams: without host context only LoadImage.image is excluded", () => {
  const graph = {
    "11": { class_type: "SaveImage", inputs: { filename_prefix: "flux" } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: "x" } },
  };
  // no enums, no outputClasses: filename_prefix can't be attributed to an
  // output node, so it surfaces like any other string
  assertEquals(textParams(graph, null, null).length, 2);
});

// --- run path ------------------------------------------------------------------

Deno.test("run path: a picked prompt lands verbatim on the right node", () => {
  const graph = {
    "2": { class_type: "CLIPTextEncode", inputs: { text: "a portrait" } },
    "3": { class_type: "CLIPTextEncode", inputs: { text: "a landscape" } },
  };
  const full = [...inspectGraph(graph), ...stringParams(graph), ...textParams(graph, null, null)];
  const { graph: mutated, applied } = mutateGraph(
    graph, { "CLIPTextEncode#3.text": "a cyberpunk alley" }, full,
  );
  assertEquals(applied, ["CLIPTextEncode#3.text"]);
  assertEquals(mutated["3"].inputs.text, "a cyberpunk alley");
  assertEquals(mutated["2"].inputs.text, "a portrait");
  assertEquals(graph["3"].inputs.text, "a landscape"); // the source is cloned, not mutated
});

Deno.test("run path: text axes multiply and exclude the all-current combo", () => {
  const perms = generatePermutations({}, { "CLIPTextEncode#2.text": "a portrait" }, {
    "CLIPTextEncode#2.text": { enabled: true, values: ["a portrait", "a cyberpunk alley"] },
  });
  assertEquals(perms.length, 1);
  assertEquals(perms[0]["CLIPTextEncode#2.text"], "a cyberpunk alley");
});

// --- route level: the probe returns textParams; the run enqueues the picks ----

Deno.test("probe + run routes: textParams from the graph, picks enqueued verbatim", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-text-"));
  const enqueued = [];
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1" }, async (req) => {
    const p = new URL(req.url).pathname;
    if (p === "/api/prompt") { enqueued.push(await req.json()); return Response.json({ ok: true }); }
    if (p === "/api/object_info") return Response.json(OBJECT_INFO);
    if (p === "/api/view") {
      return new Response(Deno.readFileSync(join(FIXTURES, "flux-basic.png")), { headers: { ETag: '"e1"' } });
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
    await ctx.ingest.ensure("fake", "flux-basic.png");

    // probe: the prompt text is the ONLY text row — the loader strings are
    // enums here, and the SaveImage prefix is the run's own machinery
    const pr = await router.handle(new Request(
      "http://x/api/features/variations/probe/" + encodeURIComponent("fake:flux-basic.png"),
    ));
    assertEquals(pr.status, 200);
    const body = await pr.json();
    assertEquals((body.textParams ?? []).map((p) => p.id), ["CLIPTextEncode#2.text"]);
    assertEquals(body.textParams[0].current, "a portrait, studio light");

    // run: sweep the prompt over [current, new] → only the new one enqueues,
    // verbatim, on node 2
    const rr = await router.handle(new Request("http://x/api/features/variations/run", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "fake:flux-basic.png", host: "fake", filename: "flux-basic.png",
        ranges: {},
        imageParams: {
          "CLIPTextEncode#2.text": { enabled: true, values: ["a portrait, studio light", "a cyberpunk alley, rain"] },
        },
        prefix: "v_", suffix: "",
      }),
    }));
    assertEquals(rr.status, 200);
    const rbody = await rr.json();
    assertEquals(rbody.total, 1); // the current combo is excluded
    assertEquals(rbody.submitted, 1);
    assertEquals(enqueued.length, 1);
    assertEquals(enqueued[0].prompt["2"].inputs.text, "a cyberpunk alley, rain");

    ctx.prefetch.stop();
  } finally {
    await server.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});
