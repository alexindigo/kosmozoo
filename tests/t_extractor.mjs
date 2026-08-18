// tests/t_extractor.mjs — golden tests for the ported extractor, in the
// t_nodefields style: synthetic class_type graph literals in, meta out.
// A/B against the Python engine is handled separately by tests/ab/.

import { assert, assertEquals } from "jsr:@std/assert";
import { extractMeta, metaFromPngBytes, historyOutputMetas } from "../src/extractor.mjs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const FIXTURES = new URL("./fixtures", import.meta.url).pathname;

const fluxGraph = {
  "1": { class_type: "UNETLoader", inputs: { unet_name: "flux1-dev.safetensors", weight_dtype: "default" } },
  "2": { class_type: "CLIPTextEncode", inputs: { clip: ["3", 0], text: "a portrait, studio light" } },
  "3": { class_type: "CLIPLoader", inputs: { clip_name: "t5xxl_fp16.safetensors", type: "flux" } },
  "4": { class_type: "BasicGuider", inputs: { model: ["1", 0], conditioning: ["5", 0] } },
  "5": { class_type: "FluxGuidance", inputs: { conditioning: ["2", 0], guidance: 3.5 } },
  "6": { class_type: "SamplerCustomAdvanced", inputs: { noise: ["7", 0], guider: ["4", 0], sampler: ["8", 0], sigmas: ["9", 0], latent_image: ["10", 0] } },
  "7": { class_type: "RandomNoise", inputs: { noise_seed: 999 } },
  "8": { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
  "9": { class_type: "BasicScheduler", inputs: { model: ["1", 0], scheduler: "simple", steps: 20, denoise: 1.0 } },
  "10": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
  "12": { class_type: "VAEDecode", inputs: { samples: ["6", 0], vae: ["13", 0] } },
  "13": { class_type: "VAELoader", inputs: { vae_name: "ae.safetensors" } },
};

Deno.test("extractor: SamplerCustomAdvanced FLUX graph yields seed/steps/sampler/guidance", () => {
  const meta = extractMeta({ prompt: [2, "id", fluxGraph] });
  assertEquals(meta.seed, 999);
  assertEquals(meta.steps, 20);
  assertEquals(meta.sampler_name, "euler");
  assertEquals(meta.guidance, 3.5);
  assertEquals(meta.model, "flux1-dev.safetensors");
  assertEquals(meta.vae, "ae.safetensors");
  assertEquals(meta.prompt, "a portrait, studio light");
  assertEquals(meta.width, 1024);
  assertEquals(meta.height, 1024);
  assertEquals(meta.q, 2);
});

Deno.test("extractor: classic KSampler graph (seed/steps/cfg direct)", () => {
  const g = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sdxl.safetensors" } },
    "2": { class_type: "CLIPTextEncode", inputs: { clip: ["1", 1], text: "pos" } },
    "3": { class_type: "CLIPTextEncode", inputs: { clip: ["1", 1], text: "neg" } },
    "4": { class_type: "KSampler", inputs: { model: ["1", 0], positive: ["2", 0], negative: ["3", 0], seed: 42, steps: 30, cfg: 7.5, sampler_name: "dpmpp_2m", scheduler: "karras", denoise: 0.9, latent_image: ["5", 0] } },
    "5": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 768, batch_size: 1 } },
  };
  const meta = extractMeta({ prompt: [1, "id", g] });
  assertEquals(meta.seed, 42);
  assertEquals(meta.steps, 30);
  assertEquals(meta.cfg, 7.5);
  assertEquals(meta.sampler_name, "dpmpp_2m");
  assertEquals(meta.prompt, "pos");
  assertEquals(meta.negPrompt, "neg");
  assertEquals(meta.width, 512);
  assertEquals(meta.height, 768);
});

Deno.test("extractor: linked seed resolved via followSeed (rgthree Seed node)", () => {
  const g = {
    "1": { class_type: "KSampler", inputs: { seed: ["9", 0], steps: 20, positive: ["2", 0], negative: ["3", 0], latent_image: ["4", 0] } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: "p" } },
    "3": { class_type: "CLIPTextEncode", inputs: { text: "n" } },
    "4": { class_type: "EmptyLatentImage", inputs: { width: 64, height: 64 } },
    "9": { class_type: "Seed", inputs: { seed: 12345 } },
  };
  const meta = extractMeta({ prompt: [1, "id", g] });
  assertEquals(meta.seed, 12345);
});

Deno.test("extractor: ConditioningZeroOut on prompt path yields empty string", () => {
  const g = {
    "1": { class_type: "KSampler", inputs: { seed: 1, steps: 1, positive: ["8", 0], negative: ["3", 0], latent_image: ["4", 0] } },
    "3": { class_type: "CLIPTextEncode", inputs: { text: "n" } },
    "4": { class_type: "EmptyLatentImage", inputs: { width: 64, height: 64 } },
    "8": { class_type: "ConditioningZeroOut", inputs: { conditioning: ["2", 0] } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: "should not surface" } },
  };
  const meta = extractMeta({ prompt: [1, "id", g] });
  assertEquals(meta.prompt, "");
});

Deno.test("extractor: LoRA stack accumulates name+strength per loader", () => {
  const g = JSON.parse(JSON.stringify(fluxGraph));
  g["20"] = { class_type: "LoraLoader", inputs: { model: ["1", 0], clip: ["3", 0], lora_name: "detail.safetensors", strength_model: 0.8, strength_clip: 0.8 } };
  g["21"] = { class_type: "LoraLoader", inputs: { model: ["20", 0], clip: ["20", 1], lora_name: "style.safetensors", strength_model: 0.5, strength_clip: 0.5 } };
  const meta = extractMeta({ prompt: [1, "id", g] });
  assertEquals(meta.loras, [
    { name: "detail.safetensors", strength: 0.8 },
    { name: "style.safetensors", strength: 0.5 },
  ]);
});

Deno.test("extractor: links arrive as arrays — scalar probes must filter", () => {
  // inputs.guidance as a link (array) must NOT be read as a scalar
  const g = JSON.parse(JSON.stringify(fluxGraph));
  g["5"].inputs.guidance = ["99", 0];
  const meta = extractMeta({ prompt: [1, "id", g] });
  assert(!("guidance" in meta) || typeof meta.guidance === "number");
});

Deno.test("extractor: PNG path parses embedded prompt chunk (history parity)", async () => {
  const bytes = new Uint8Array(await readFile(join(FIXTURES, "flux-basic.png")));
  const [meta, hasWorkflow] = await metaFromPngBytes(bytes);
  assertEquals(hasWorkflow, false);
  assertEquals(meta.seed, 999);
  assertEquals(meta.steps, 20);
  assertEquals(meta.prompt, "a portrait, studio light");
});

Deno.test("extractor: PNG with no prompt chunk yields null meta", async () => {
  const bytes = new Uint8Array(await readFile(join(FIXTURES, "no-prompt-chunk.png")));
  const [meta] = await metaFromPngBytes(bytes);
  assertEquals(meta, null);
});

Deno.test("extractor: historyOutputMetas maps output images to metas", () => {
  const history = {
    a: { prompt: [1, "a", fluxGraph], outputs: { "9": { images: [{ filename: "x.png", type: "output" }, { filename: "tmp.png", type: "temp" }] } } },
  };
  const out = historyOutputMetas(history);
  assertEquals(Object.keys(out), ["x.png"]); // type:"temp" excluded
  assertEquals(out["x.png"].seed, 999);
});
