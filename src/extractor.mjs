// src/extractor.mjs — per-image metadata extraction from ComfyUI graphs.
//
// Ported verbatim from the outgoing server.py:466–766 and index.html's
// extractMeta. This is where the mirror dies: ONE module, imported by both
// the engine and the browser. ~20 empirical class_type probes are field
// data, not architecture — do not re-derive, port.
//
// Shared between engine (Deno) and client (browser) — no node: imports here.

// --- graph walking helpers -------------------------------------------------

// Follow positive/negative input links until a node with string text.
// A ConditioningZeroOut on the path means an intentionally empty prompt.
// Graph inputs arrive as arrays when they are links (harvest #9); ≤8 hops,
// zeroout on the path ⇒ empty string (harvest #10).
function walkText(graph, startLink) {
  let node = Array.isArray(startLink) ? graph[startLink[0]] : null;
  for (let i = 0; i < 8; i++) {
    if (!node) return "";
    if (String(node.class_type ?? "").toLowerCase().includes("zeroout")) return "";
    const text = node.inputs?.text;
    if (typeof text === "string") return text;
    const nxt = Object.values(node.inputs ?? {}).find((v) => Array.isArray(v));
    node = nxt ? graph[nxt[0]] : null;
  }
  return "";
}

// First node whose class_type contains any of the bits (lowercase).
function firstNode(nodes, ...bits) {
  for (const n of nodes) {
    const ct = String(n.class_type ?? "").toLowerCase();
    if (bits.some((b) => ct.includes(b))) return n;
  }
  return null;
}

// First present scalar (str/int/float) input — links arrive as lists.
function scalarInput(node, ...keys) {
  if (!node) return null;
  for (const k of keys) {
    const v = node.inputs?.[k];
    if (typeof v === "number" || typeof v === "string") return v;
  }
  return null;
}

function basename(v) {
  return v ? String(v).replace(/\\/g, "/").split("/").pop() : v;
}

// Linked seed input [node_id, slot] -> the target node's scalar seed, when
// it has one (rgthree 'Seed' does; widget-only custom nodes don't).
function followSeed(graph, link) {
  const node = Array.isArray(link) && link.length ? graph[String(link[0])] : null;
  const v = node?.inputs?.seed;
  return typeof v === "number" ? v : null;
}

// --- the extractor ---------------------------------------------------------

// Per-image metadata from one /api/history entry's prompt graph.
export function extractMeta(entry) {
  const prompt = entry?.prompt;
  if (!Array.isArray(prompt) || prompt.length < 3) return null;
  const graph = prompt[2];
  if (graph === null || typeof graph !== "object" || Array.isArray(graph)) return null;
  const nodes = Object.values(graph);

  let ks = nodes.find((n) => n.class_type === "KSampler") ?? null;
  if (ks === null) {
    // KSampler-like variants are identified by their input signature:
    // "sampler" in the name alone also matches KSamplerSelect and
    // SamplerCustomAdvanced, which carry no seed/steps
    ks = nodes.find((n) => {
      const ct = String(n.class_type ?? "").toLowerCase();
      return ct.includes("sampler") && !ct.includes("select")
        && typeof n.inputs?.steps === "number"
        && n.inputs?.seed != null;
    }) ?? null;
  }

  const meta = { loras: [] };
  if (typeof prompt[0] === "number") meta.q = prompt[0]; // queue order

  if (ks) {
    for (const k of ["seed", "steps", "cfg", "sampler_name", "scheduler", "denoise"]) {
      let v = ks.inputs?.[k];
      if (Array.isArray(v) && k === "seed") v = followSeed(graph, v);
      if (typeof v === "number" || typeof v === "string") meta[k] = v;
    }
    meta.prompt = walkText(graph, ks.inputs?.positive).trim();
    meta.negPrompt = walkText(graph, ks.inputs?.negative).trim();
  } else {
    // SamplerCustomAdvanced-style pipelines: fields live on helper nodes
    // (verified against real fleet graphs)
    let v = scalarInput(firstNode(nodes, "randomnoise"), "noise_seed");
    if (v === null) v = scalarInput(firstNode(nodes, "seed"), "seed");
    if (v !== null) meta.seed = v;
    v = scalarInput(firstNode(nodes, "scheduler"), "steps");
    if (v !== null) meta.steps = v;
    const guider = firstNode(nodes, "cfgguider");
    v = scalarInput(guider, "cfg");
    if (v !== null) meta.cfg = v;
    v = scalarInput(firstNode(nodes, "ksamplerselect"), "sampler_name");
    if (v) meta.sampler_name = v;
    const bg = firstNode(nodes, "basicguider");
    let posLink = null;
    if (bg) posLink = bg.inputs?.conditioning;
    else if (guider) posLink = guider.inputs?.positive;
    meta.prompt = walkText(graph, posLink).trim();
    if (guider) meta.negPrompt = walkText(graph, guider.inputs?.negative).trim();
  }

  for (const n of nodes) {
    const ct = String(n.class_type ?? "");
    if (ct.toLowerCase().includes("lora") && ct.toLowerCase().includes("load")) {
      const inp = n.inputs ?? {};
      meta.loras.push({
        name: inp.lora_name ?? inp.lora ?? "?",
        strength: inp.lora_strength ?? inp.strength_model ?? inp.strength,
      });
    }
  }

  const latent = nodes.find((n) => {
    const ct = String(n.class_type ?? "").toLowerCase();
    return ct.includes("latent") && ct.includes("empty");
  }) ?? null;
  if (latent) {
    const w = latent.inputs?.width, h = latent.inputs?.height;
    if (typeof w === "number" && typeof h === "number") {
      meta.width = w; meta.height = h;
    }
  }

  // --- extra node-derived fields (all opt-in in the fields picker) --------
  const g = firstNode(nodes, "fluxguidance");
  let v = scalarInput(g, "guidance");
  if (v !== null) meta.guidance = v;

  let mdl = firstNode(nodes, "unetloader");
  v = scalarInput(mdl, "unet_name");
  if (!v) {
    mdl = firstNode(nodes, "checkpointloader");
    v = scalarInput(mdl, "ckpt_name");
  }
  if (v) meta.model = basename(v);

  const vae = firstNode(nodes, "vaeloader");
  v = scalarInput(vae, "vae_name");
  if (v) meta.vae = basename(v);

  // ipadapter: loader file ("ipadapter_file" on SDXL loaders, "ipadapter" on
  // Flux loaders), apply weight(s), weight type, timing range
  // ("start_at/end_at" on SDXL, "start_percent/end_percent" on Flux)
  let ipaFile = null, ipaType = null, ipaRange = null;
  const ipaWeights = [];
  for (const n of nodes) {
    if (!String(n.class_type ?? "").toLowerCase().includes("ipadapter")) continue;
    const inp = n.inputs ?? {};
    const f = scalarInput(n, "ipadapter_file", "ipadapter");
    if (f && !ipaFile) ipaFile = basename(f);
    if (typeof inp.weight === "number") ipaWeights.push(inp.weight);
    if (!ipaType && typeof inp.weight_type === "string") ipaType = inp.weight_type;
    let st = inp.start_at, en = inp.end_at;
    if (typeof st !== "number") { st = inp.start_percent; en = inp.end_percent; }
    if (typeof st === "number" && typeof en === "number") ipaRange = `${st}–${en}`;
  }
  if (ipaFile) meta.ipa_model = ipaFile;
  if (ipaWeights.length) meta.ipa_weight = ipaWeights.join("+");
  if (ipaType) meta.ipa_type = ipaType;
  if (ipaRange) meta.ipa_range = ipaRange;

  const cv = firstNode(nodes, "clipvision");
  v = scalarInput(cv, "clip_name");
  if (v) meta.clip_vision = basename(v);

  // PuLID (identity adapter): model file + weight + timing range
  const pl = firstNode(nodes, "pulidfluxmodelloader", "pulidmodelloader");
  v = scalarInput(pl, "pulid_file");
  if (v) meta.pulid = basename(v);
  const ap = firstNode(nodes, "applypulid");
  if (ap) {
    const inp = ap.inputs ?? {};
    if (typeof inp.weight === "number") meta.pulid_weight = inp.weight;
    const st = inp.start_at, en = inp.end_at;
    if (typeof st === "number" && typeof en === "number") meta.pulid_range = `${st}–${en}`;
  }

  // controlnet: loader name + apply strengths
  let cnName = null;
  const cnStrengths = [];
  for (const n of nodes) {
    const ct = String(n.class_type ?? "").toLowerCase();
    if (ct.includes("controlnetloader") && !cnName) {
      cnName = basename(scalarInput(n, "control_net_name"));
    }
    if (ct.includes("controlnetapply")) {
      const s = n.inputs?.strength;
      if (typeof s === "number") cnStrengths.push(s);
    }
  }
  if (cnName || cnStrengths.length) {
    meta.controlnet = [cnName, cnStrengths.join("+")].filter((x) => x).join(" ");
  }

  const ms = firstNode(nodes, "modelsampling");
  v = scalarInput(ms, "shift");
  if (v !== null) meta.shift = v;

  const cs = firstNode(nodes, "clipsetlastlayer");
  v = scalarInput(cs, "stop_at_clip_layer");
  if (typeof v === "number") meta.clip_skip = Math.abs(Math.trunc(v));

  return meta;
}

// --- PNG metadata: tEXt/zTXt/iTXt chunks (ComfyUI writes them pre-IDAT) ----
// Stop at first IDAT, cap the scan at 256 KB (harvest #11). Pure JS — no
// node:zlib here so the browser can import this module too; zTXt/iTXt
// decompression uses DecompressionStream, available in both Deno and
// browsers.

const PNG_SIG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_READ_CAP = 256 * 1024;

async function inflateRaw(bytes) {
  const ds = new DecompressionStream("deflate");
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Read PNG text chunks until the first IDAT; returns {keyword: str}, or null
// if the bytes aren't a PNG. Stops early — ComfyUI writes prompt/workflow
// right after IHDR.
export async function parsePngTextChunks(buf) {
  if (buf.length < 8) return null;
  for (let i = 0; i < 8; i++) if (buf[i] !== PNG_SIG[i]) return null;
  const out = {};
  let off = 8;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  while (off + 12 <= Math.min(buf.length, PNG_READ_CAP)) {
    const length = dv.getUint32(off);
    const type = String.fromCharCode(buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7]);
    if (type === "IDAT") break;
    const payload = buf.subarray(off + 8, off + 8 + length);
    try {
      if (type === "tEXt") {
        const nul = payload.indexOf(0);
        const key = new TextDecoder("latin1").decode(payload.subarray(0, nul));
        out[key] = new TextDecoder("latin1").decode(payload.subarray(nul + 1));
      } else if (type === "zTXt") {
        const nul = payload.indexOf(0);
        const key = new TextDecoder("latin1").decode(payload.subarray(0, nul));
        const rest = payload.subarray(nul + 1);
        if (rest[0] === 0) { // method 0 = zlib
          out[key] = new TextDecoder("utf-8", { fatal: false })
            .decode(await inflateRaw(rest.subarray(1)));
        }
      } else if (type === "iTXt") {
        const nul = payload.indexOf(0);
        const key = new TextDecoder("latin1").decode(payload.subarray(0, nul));
        let rest = payload.subarray(nul + 1);
        if (rest.length >= 2) {
          const compressed = rest[0];
          rest = rest.subarray(2); // flag + method bytes
          let n2 = rest.indexOf(0); rest = rest.subarray(n2 + 1); // lang
          n2 = rest.indexOf(0); let text = rest.subarray(n2 + 1); // translated
          if (compressed) text = await inflateRaw(text);
          out[key] = new TextDecoder("utf-8", { fatal: false }).decode(text);
        }
      }
    } catch {
      continue; // ValueError/zlib.error/UnicodeDecodeError -> skip chunk
    }
    off += 12 + length;
  }
  return out;
}

// (meta, hasWorkflow) from PNG bytes; meta is null when the file carries no
// prompt chunk (e.g. edited/re-exported PNGs).
export async function metaFromPngBytes(buf) {
  const chunks = await parsePngTextChunks(buf);
  if (chunks === null) return [null, false];
  const hasWorkflow = "workflow" in chunks;
  let graph;
  try {
    graph = JSON.parse(chunks.prompt);
  } catch {
    return [null, hasWorkflow];
  }
  if (graph === null || typeof graph !== "object" || Array.isArray(graph)) {
    return [null, hasWorkflow];
  }
  // the prompt chunk IS the executed API-format graph — the same shape
  // extractMeta consumes from history entries
  return [extractMeta({ prompt: [0, 0, graph] }), hasWorkflow];
}

// --- directory convenience (engine side; A/B rig calls this) ---------------

export async function extractDir(dir) {
  const { readdir, readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const out = {};
  for (const name of (await readdir(dir)).sort()) {
    if (!name.endsWith(".png")) continue;
    const [meta] = await metaFromPngBytes(new Uint8Array(await readFile(join(dir, name))));
    out[name] = meta ?? { nopng: true };
  }
  return out;
}

// filename -> meta for every output image in a /api/history response.
export function historyOutputMetas(history) {
  const out = {};
  for (const entry of Object.values(history ?? {})) {
    const meta = extractMeta(entry);
    if (!meta) continue;
    for (const output of Object.values(entry.outputs ?? {})) {
      for (const img of output.images ?? []) {
        if (img.type === "output" && img.filename) out[img.filename] = meta;
      }
    }
  }
  return out;
}
