// tests/make-synthetic-fixtures.mjs — generate a small set of synthetic
// fixture PNGs with embedded ComfyUI prompt graphs, so the test substrate is
// runnable before the user supplies real asset PNGs. Each fixture is a 1x1
// PNG with a tEXt "prompt" chunk.
//
// Coverage mirrors the priority list in the plan: FLUX/FluxGuidance, a LoRA
// stack, IPAdapter, ControlNet, PuLID, SamplerCustomAdvanced, plus two
// negatives (no prompt chunk; a filename that 404s — the fake host adds the
// 404 name itself).

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const OUT = new URL("./fixtures", import.meta.url).pathname;
await mkdir(OUT, { recursive: true });

const PNG_SIG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(buf) {
  let c, table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  c = -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ table[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const t = new TextEncoder().encode(type);
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(t, 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function pngWithPrompt(promptObj) {
  const ihdr = new Uint8Array(13);
  const idv = new DataView(ihdr.buffer);
  idv.setUint32(0, 1); // width
  idv.setUint32(4, 1); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const parts = [PNG_SIG, chunk("IHDR", ihdr)];
  if (promptObj !== null) {
    const key = new TextEncoder().encode("prompt");
    const val = new TextEncoder().encode(JSON.stringify(promptObj));
    const data = new Uint8Array(key.length + 1 + val.length);
    data.set(key, 0);
    data[key.length] = 0;
    data.set(val, key.length + 1);
    parts.push(chunk("tEXt", data));
  }
  const idatData = Uint8Array.from([0x78, 0x9c, 0x63, 0x60, 0x60, 0x60, 0x60, 0x00, 0x00, 0x00, 0x04, 0x00, 0x01]);
  parts.push(chunk("IDAT", idatData));
  parts.push(chunk("IEND", new Uint8Array(0)));
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// A minimal FLUX graph: UNETLoader -> BasicGuider(FluxGuidance) ->
// SamplerCustomAdvanced -> SaveImage, with a CLIPTextEncode prompt.
const flux = {
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
  "11": { class_type: "SaveImage", inputs: { images: ["12", 0], filename_prefix: "flux" } },
  "12": { class_type: "VAEDecode", inputs: { samples: ["6", 0], vae: ["13", 0] } },
  "13": { class_type: "VAELoader", inputs: { vae_name: "ae.safetensors" } },
};

// A LoRA stack on top of the FLUX graph.
const lora = JSON.parse(JSON.stringify(flux));
lora["20"] = { class_type: "LoraLoader", inputs: { model: ["1", 0], clip: ["3", 0], lora_name: "detail.safetensors", strength_model: 0.8, strength_clip: 0.8 } };
lora["21"] = { class_type: "LoraLoader", inputs: { model: ["20", 0], clip: ["20", 1], lora_name: "style.safetensors", strength_model: 0.5, strength_clip: 0.5 } };
lora["4"].inputs.model = ["21", 0];
lora["2"].inputs.clip = ["21", 1];

// IPAdapter variant.
const ipad = JSON.parse(JSON.stringify(flux));
ipad["30"] = { class_type: "IPAdapterModelLoader", inputs: { ipadapter_file: "ip-plus.safetensors" } };
ipad["31"] = { class_type: "IPAdapterAdvanced", inputs: { model: ["1", 0], ipadapter: ["30", 0], image: ["32", 0], weight: 0.6, start_at: 0.0, end_at: 0.8 } };
ipad["32"] = { class_type: "LoadImage", inputs: { image: "ref.png", upload: "image" } };
ipad["4"].inputs.model = ["31", 0];

// ControlNet variant.
const cnet = JSON.parse(JSON.stringify(flux));
cnet["40"] = { class_type: "ControlNetLoader", inputs: { control_net_name: "canny.safetensors" } };
cnet["41"] = { class_type: "ControlNetApplyAdvanced", inputs: { positive: ["2", 0], negative: ["42", 0], control_net: ["40", 0], image: ["43", 0], strength: 0.7, start_percent: 0.0, end_percent: 0.9 } };
cnet["42"] = { class_type: "CLIPTextEncode", inputs: { clip: ["3", 0], text: "bad quality" } };
cnet["43"] = { class_type: "LoadImage", inputs: { image: "canny.png", upload: "image" } };
cnet["5"].inputs.conditioning = ["41", 0];

// PuLID variant.
const pulid = JSON.parse(JSON.stringify(flux));
pulid["50"] = { class_type: "PulidFluxModelLoader", inputs: { pulid_file: "pulid_flux_v0.9.1.safetensors" } };
pulid["51"] = { class_type: "PulidFluxEvaClipLoader", inputs: {} };
pulid["52"] = { class_type: "ApplyPulidFlux", inputs: { model: ["1", 0], pulid_flux: ["50", 0], eva_clip: ["51", 0], face_analysis: ["53", 0], image: ["54", 0], weight: 1.0, start_at: 0.0, end_at: 1.0 } };
pulid["53"] = { class_type: "PulidFluxInsightFaceLoader", inputs: { provider: "CUDA" } };
pulid["54"] = { class_type: "LoadImage", inputs: { image: "face.png", upload: "image" } };
pulid["4"].inputs.model = ["52", 0];

const fixtures = {
  "flux-basic.png": flux,
  "flux-lora.png": lora,
  "flux-ipadapter.png": ipad,
  "flux-controlnet.png": cnet,
  "flux-pulid.png": pulid,
  "no-prompt-chunk.png": null, // negative: parses, drives meta_mark_nopng
};

for (const [name, graph] of Object.entries(fixtures)) {
  const bytes = pngWithPrompt(graph);
  await writeFile(join(OUT, name), bytes);
  console.log(`${name}: ${bytes.length} bytes${graph ? "" : " (no prompt chunk)"}`);
}
console.log(`wrote ${Object.keys(fixtures).length} synthetic fixtures to tests/fixtures/`);
