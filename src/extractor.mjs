// src/extractor.mjs — per-image metadata extraction from ComfyUI graphs.
//
// ONE module shared by the engine and the browser (no node: imports here).
// ~20 empirical class_type probes are field data, not architecture — port
// them verbatim, do not re-derive them.

// Bump when the extraction shape changes; content rows with an older ext
// are stale and re-extract on their next ingest (decided in src/ingest.mjs,
// the one place staleness lives).
export const EXTRACTOR_VERSION = 4;

// --- graph walking helpers -------------------------------------------------

// Follow positive/negative input links until a node with string text.
// A ConditioningZeroOut on the path means an intentionally empty prompt.
// Graph inputs arrive as arrays when they are links (harvest #9); ≤8 hops,
// zeroout on the path ⇒ empty string (harvest #10).
export function walkText(graph, startLink) {
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
export function firstNode(nodes, ...bits) {
  for (const n of nodes) {
    const ct = String(n.class_type ?? "").toLowerCase();
    if (bits.some((b) => ct.includes(b))) return n;
  }
  return null;
}

// First present scalar (str/int/float) input — links arrive as lists.
export function scalarInput(node, ...keys) {
  if (!node) return null;
  for (const k of keys) {
    const v = node.inputs?.[k];
    if (typeof v === "number" || typeof v === "string") return v;
  }
  return null;
}

export function basename(v) {
  return v ? String(v).replace(/\\/g, "/").split("/").pop() : v;
}

// Generic scan of a prompt graph: every node's scalar inputs, no node names
// involved. Links (arrays) are skipped; strings are capped; class_type is the
// node name, _meta.title (when present) is its display title. This feeds the
// registry: node types and their fields are discovered from graphs.
// (The class_type probes BELOW, by contrast, are empirical field data ported
// verbatim from real fleets — spec §4 #15. Different rule on purpose.)
export function collectNodes(graph, { stringCap = 4096 } = {}) {
  const out = [];
  for (const [id, n] of Object.entries(graph ?? {})) {
    const inputs = {};
    for (const [k, v] of Object.entries(n.inputs ?? {})) {
      if (typeof v === "number" || typeof v === "boolean") inputs[k] = v;
      else if (typeof v === "string") inputs[k] = v.length > stringCap ? v.slice(0, stringCap) + "…" : v;
    }
    if (!Object.keys(inputs).length) continue;
    const title = n._meta?.title;
    out.push(title && title !== n.class_type
      ? { id, type: String(n.class_type ?? ""), title: String(title), inputs }
      : { id, type: String(n.class_type ?? ""), inputs });
  }
  return out;
}

// Linked seed input [node_id, slot] -> the target node's scalar seed, when
// it has one (rgthree 'Seed' does; widget-only custom nodes don't).
export function followSeed(graph, link) {
  const node = Array.isArray(link) && link.length ? graph[String(link[0])] : null;
  const v = node?.inputs?.seed;
  return typeof v === "number" ? v : null;
}

// --- the extractor ---------------------------------------------------------

// Per-image metadata from one /api/history entry's prompt graph.
export function extractMeta(entry) {
  const prompt = entry?.prompt;
  if (!Array.isArray(prompt) || prompt.length < 3) return null;
  const meta = extractMetaFromGraph(prompt[2]);
  if (meta && typeof prompt[0] === "number") meta.q = prompt[0]; // queue order
  return meta;
}

// The core: per-image metadata from an API-format prompt graph. PNG text
// chunks carry exactly this shape, so the PNG path calls this directly —
// no history entry is faked and no queue index is invented.
export function extractMetaFromGraph(graph) {
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

  if (ks) {
    for (const k of ["seed", "steps", "cfg", "sampler_name", "scheduler", "denoise"]) {
      let v = ks.inputs?.[k];
      if (Array.isArray(v) && k === "seed") v = followSeed(graph, v);
      if (typeof v === "number" || typeof v === "string") meta[k] = v;
    }
    // Fallback for KSampler graphs where seed is a widget on a custom node
    // that followSeed can't unpack — probe the standard seed carriers.
    if (meta.seed === undefined) {
      let v = scalarInput(firstNode(nodes, "randomnoise"), "noise_seed");
      if (v === null) v = scalarInput(firstNode(nodes, "seed"), "seed");
      if (v !== null) meta.seed = v;
    }
    // If we still have no seed but the KSampler input links to a node,
    // record its class_type as the seed source so the metadata surface
    // can show e.g. "seed: ⇒ DomovoySeed" instead of dropping the field.
    if (meta.seed === undefined && Array.isArray(ks.inputs?.seed) && ks.inputs.seed.length) {
      const linked = graph[String(ks.inputs.seed[0])];
      if (linked?.class_type) meta.seed_source = String(linked.class_type);
    }
    meta.prompt = walkText(graph, ks.inputs?.positive).trim();
    meta.negPrompt = walkText(graph, ks.inputs?.negative).trim();
  } else {
    // SamplerCustomAdvanced-style pipelines: fields live on helper nodes
    // (verified against real fleet graphs)
    let v = scalarInput(firstNode(nodes, "randomnoise"), "noise_seed");
    if (v === null) v = scalarInput(firstNode(nodes, "seed"), "seed");
    if (v !== null) meta.seed = v;
    // If no scalar seed but a seed-ish node exists, record it as the source
    // so the metadata surface can show "seed: ⇒ <NodeType>".
    if (meta.seed === undefined) {
      const seedish = firstNode(nodes, "randomnoise") ?? firstNode(nodes, "seed");
      if (seedish?.class_type) meta.seed_source = String(seedish.class_type);
    }
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

  // --- extra node-derived fields -----------------------------------------
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

  // Generic scan: every node's scalar fields ride along, backed by the
  // discovered node registry.
  meta.nodes = collectNodes(graph);

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
    off += 12 + length; // advance BEFORE parsing — a bad chunk must not loop
    try {
      if (type === "tEXt") {
        const nul = payload.indexOf(0);
        if (nul < 0) continue; // malformed: no keyword terminator
        const key = new TextDecoder("latin1").decode(payload.subarray(0, nul));
        out[key] = new TextDecoder("latin1").decode(payload.subarray(nul + 1));
      } else if (type === "zTXt") {
        const nul = payload.indexOf(0);
        if (nul < 0) continue;
        const key = new TextDecoder("latin1").decode(payload.subarray(0, nul));
        const rest = payload.subarray(nul + 1);
        if (rest[0] === 0) { // method 0 = zlib
          out[key] = new TextDecoder("utf-8", { fatal: false })
            .decode(await inflateRaw(rest.subarray(1)));
        }
      } else if (type === "iTXt") {
        const nul = payload.indexOf(0);
        if (nul < 0) continue; // malformed: no keyword terminator
        const key = new TextDecoder("latin1").decode(payload.subarray(0, nul));
        let rest = payload.subarray(nul + 1);
        if (rest.length >= 2) {
          const compressed = rest[0];
          rest = rest.subarray(2); // flag + method bytes
          let n2 = rest.indexOf(0);
          if (n2 < 0) continue; // malformed: no lang terminator
          rest = rest.subarray(n2 + 1); // lang
          n2 = rest.indexOf(0);
          if (n2 < 0) continue; // malformed: no translated-keyword terminator
          let text = rest.subarray(n2 + 1); // translated
          if (compressed) text = await inflateRaw(text);
          out[key] = new TextDecoder("utf-8", { fatal: false }).decode(text);
        }
      }
    } catch {
      continue; // zlib.error/UnicodeDecodeError -> skip chunk
    }
  }
  return out;
}

// (meta, hasWorkflow) from PNG bytes; meta is null when the file carries no
// prompt chunk (e.g. edited/re-exported PNGs). A `kz` text chunk (written by
// the variations plugin via extra_pnginfo) survives as meta.lineage.
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
  // the prompt chunk IS the executed API-format graph — extract straight
  // from it (a PNG has no queue order, so no q is invented here)
  const meta = extractMetaFromGraph(graph);
  if (meta && typeof chunks.kz === "string") {
    try {
      const tag = JSON.parse(chunks.kz);
      if (tag && typeof tag.source === "string") meta.lineage = tag;
    } catch { /* a foreign kz chunk is not ours — ignore */ }
  }
  return [meta, hasWorkflow];
}

// --- image dimensions from encoded bytes -------------------------------------
// Pure bytes, no DOM: PNG (IHDR), JPEG (SOF scan), GIF (LSD), WebP
// (VP8/VP8L/VP8X), SVG (viewBox or width/height attrs). Null when the shape
// is unknown — the caller treats that as "measure by decode".

// Content sniffed mime from the magic bytes — never trusted from a filename.
export function sniffMime(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif";
  if (buf[0] === 0x42 && buf[1] === 0x4d) return "image/bmp";
  if (ascii(buf, 0, 4) === "RIFF" && ascii(buf, 8, 4) === "WEBP") return "image/webp";
  const head = new TextDecoder().decode(buf.subarray(0, 256));
  if (head.includes("<svg")) return "image/svg+xml";
  return null;
}

const ascii = (buf, off, n) => String.fromCharCode(...buf.subarray(off, off + n));

export function imageDims(buf) {
  if (buf.length < 10) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // PNG: 8-byte signature, IHDR is the first chunk
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && buf.length >= 24) {
    return { width: dv.getUint32(16), height: dv.getUint32(20) };
  }

  // GIF87a/89a: logical screen descriptor right after the header
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
  }

  // JPEG: walk segments to the first SOF marker
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) { off++; continue; }
      const marker = buf[off + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
      if (off + 4 > buf.length) return null;
      const len = dv.getUint16(off + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: dv.getUint16(off + 7), height: dv.getUint16(off + 5) };
      }
      off += 2 + len;
    }
    return null;
  }

  // WebP: RIFF container, then VP8 (lossy) / VP8L (lossless) / VP8X (extended)
  if (buf.length >= 30 && ascii(buf, 0, 4) === "RIFF" && ascii(buf, 8, 4) === "WEBP") {
    const fourcc = ascii(buf, 12, 4);
    if (fourcc === "VP8X") {
      return { width: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)), height: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16)) };
    }
    if (fourcc === "VP8 " && buf.length >= 30) {
      // frame tag 3 bytes + start code 3 bytes, then 14-bit dims
      const w = dv.getUint16(26, true) & 0x3fff;
      const h = dv.getUint16(28, true) & 0x3fff;
      return w && h ? { width: w, height: h } : null;
    }
    if (fourcc === "VP8L" && buf.length >= 25) {
      const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
      const w = 1 + (((b1 & 0x3f) << 8) | b0);
      const h = 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
      return { width: w, height: h };
    }
    return null;
  }

  // SVG: viewBox preferred, else width/height attributes
  if (buf[0] === 0x3c) { // "<"
    const head = new TextDecoder().decode(buf.subarray(0, Math.min(buf.length, 4096)));
    if (!head.includes("<svg")) return null;
    const vb = /viewBox\s*=\s*["']\s*[\d.+-]+[ ,]+[\d.+-]+[ ,]+([\d.]+)[ ,]+([\d.]+)\s*["']/.exec(head);
    if (vb) return { width: Math.round(Number(vb[1])), height: Math.round(Number(vb[2])) };
    const w = /width\s*=\s*"([\d.]+)(?:px)?"/.exec(head);
    const h = /height\s*=\s*"([\d.]+)(?:px)?"/.exec(head);
    if (w && h) return { width: Math.round(Number(w[1])), height: Math.round(Number(h[1])) };
    return null;
  }

  return null;
}
