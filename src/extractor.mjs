// src/extractor.mjs — per-image metadata extraction from ComfyUI graphs.
//
// ONE module shared by the engine and the browser (no node: imports here).
// ~20 empirical class_type probes are field data, not architecture — port
// them verbatim, do not re-derive them.
import { mediaKind, mediaExtension } from "./backings/mime.mjs";

// Bump when the extraction shape changes; content rows with an older ext
// are stale and re-extract on their next ingest (decided in src/ingest.mjs,
// the one place staleness lives).
export const EXTRACTOR_VERSION = 5;

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
// verbatim from real fleets — spec #15. Different rule on purpose.)
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
// By default stop at first IDAT and cap chunk starts at 256 KB (harvest #11).
// Recognized text payloads are read in full; allChunks also reads late metadata.
// Pure JS — no
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
export async function parsePngTextChunks(buf, { allChunks = false } = {}) {
  if (buf.length < 8) return null;
  for (let i = 0; i < 8; i++) if (buf[i] !== PNG_SIG[i]) return null;
  const out = {};
  let off = 8;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  while (off + 12 <= (allChunks ? buf.length : Math.min(buf.length, PNG_READ_CAP))) {
    const length = dv.getUint32(off);
    const type = String.fromCharCode(buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7]);
    if (type === "IDAT" && !allChunks) break;
    if (length > buf.length - off - 12) break;
    const payload = buf.subarray(off + 8, off + 8 + length);
    off += 12 + length; // advance BEFORE parsing — a bad chunk must not loop
    if (type === "IEND") break;
    if (!["tEXt", "zTXt", "iTXt", "comf"].includes(type)) continue;
    try {
      if (type === "tEXt" || type === "comf") {
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
  return (await metaFromBytes(buf, "image.png")).slice(0, 2);
}

const jsonValue = value => {
  try { return typeof value === "string" ? JSON.parse(value) : value; } catch { return null; }
};

// One dispatcher for ingestion, raw graph reads and plugins. The third result
// is the executed graph, not the editor workflow. Hash-only cache readers have
// no filename, so use the same readers selected by the container signature.
export async function metaFromBytes(buf, name) {
  const mime = sniffMime(buf);
  const ext = name == null ? ({ "image/png": "png", "image/webp": "webp",
    "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm",
    "audio/flac": "flac", "audio/ogg": "opus", "audio/mpeg": "mp3", "audio/wav": "wav" })[mime] : mediaExtension(name);
  const kind = mediaKind(`media.${ext}`);
  let tags = null;
  if (kind === "image" && ext === "png") tags = await parsePngTextChunks(buf, { allChunks: true });
  else if (kind === "image" && ext === "webp") tags = webpTags(buf);
  else if (kind === "video" && (ext === "mp4" || ext === "mov")) tags = quickTime(buf).tags;
  else if (kind === "video" && ext === "webm") tags = matroska(buf).tags;
  else if (kind === "audio" && ext === "flac") tags = flacTags(buf);
  else if (kind === "audio" && ext === "opus") tags = opusTags(buf);
  else if (kind === "audio" && ext === "mp3") tags = id3Tags(buf);
  else if (kind === "audio" && ext === "wav") tags = waveTags(buf);
  const hasWorkflow = tags != null && Object.hasOwn(tags, "workflow");
  const graph = jsonValue(tags?.prompt);
  if (!graph || typeof graph !== "object" || Array.isArray(graph)) return [null, hasWorkflow, null];
  const meta = extractMetaFromGraph(graph);
  const lineage = jsonValue(tags?.kz);
  if (meta && lineage && typeof lineage.source === "string") meta.lineage = lineage;
  return [meta, hasWorkflow, graph];
}

// --- image dimensions from encoded bytes -------------------------------------
// Pure bytes, no DOM: PNG (IHDR), JPEG (SOF scan), GIF (LSD), WebP
// (VP8/VP8L/VP8X), SVG (viewBox or width/height attrs). Null when the shape
// is unknown — the caller treats that as "measure by decode".

// Content sniffed mime from the magic bytes — never trusted from a filename.
export function sniffMime(buf) {
  if (buf.length < 4) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif";
  if (buf[0] === 0x42 && buf[1] === 0x4d) return "image/bmp";
  if (ascii(buf, 0, 4) === "RIFF" && ascii(buf, 8, 4) === "WEBP") return "image/webp";
  if (ascii(buf, 4, 4) === "ftyp") {
    const brand = ascii(buf, 8, 4);
    if (brand === "avif" || brand === "avis") return "image/avif";
    return brand === "qt  " ? "video/quicktime" : "video/mp4";
  }
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return "video/webm";
  if (ascii(buf, 0, 4) === "fLaC") return "audio/flac";
  if (ascii(buf, 0, 4) === "OggS") return "audio/ogg";
  if (ascii(buf, 0, 3) === "ID3" || (buf[0] === 0xff && (buf[1] & 0xe6) === 0xe2)) return "audio/mpeg";
  if (ascii(buf, 0, 4) === "RIFF" && ascii(buf, 8, 4) === "WAVE") return "audio/wav";
  const head = new TextDecoder().decode(buf.subarray(0, 256));
  if (head.includes("<svg")) return "image/svg+xml";
  return null;
}

const ascii = (buf, off, n) => String.fromCharCode(...buf.subarray(off, off + n));

export function imageDims(buf) {
  if (buf.length < 10) return null;
  if (ascii(buf, 4, 4) === "ftyp" && sniffMime(buf)?.startsWith("video/")) return quickTime(buf).dims;
  if (sniffMime(buf) === "video/webm") return matroska(buf).dims;
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

// --- container readers -----------------------------------------------------
// Bounds come from container records, never string-search through compressed
// media. Truncated/foreign metadata is absent, not an ingestion failure.
const utf8 = bytes => new TextDecoder().decode(bytes).replace(/\0+$/, "");
const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
function putTag(tags, key, value) {
  key = key.toLowerCase();
  if (["prompt", "workflow", "kz"].includes(key)) tags[key] = value;
  else if (key === "comment") {
    const comment = jsonValue(value);
    if (comment && typeof comment === "object" && !Array.isArray(comment)) {
      for (const field of ["prompt", "workflow", "kz"]) {
        if (Object.hasOwn(comment, field) && !Object.hasOwn(tags, field)) tags[field] = comment[field];
      }
    }
  }
}

// Vorbis comments are shared by native FLAC metadata block 4 and OpusTags.
// Every length is checked before decoding; unrelated audio payloads are skipped.
function vorbisTags(buf, tags) {
  const dv = view(buf);
  if (buf.length < 8) return;
  let at = 4 + dv.getUint32(0, true);
  if (at > buf.length - 4) return;
  const count = dv.getUint32(at, true); at += 4;
  for (let i = 0; i < count && at + 4 <= buf.length; i++) {
    const length = dv.getUint32(at, true); at += 4;
    if (length > buf.length - at) break;
    if (length <= PNG_READ_CAP) {
      const text = utf8(buf.subarray(at, at + length)), split = text.indexOf("=");
      if (split > 0) putTag(tags, text.slice(0, split), text.slice(split + 1));
    }
    at += length;
  }
}

function flacTags(buf) {
  const tags = Object.create(null);
  if (ascii(buf, 0, 4) !== "fLaC") return tags;
  for (let at = 4; at + 4 <= buf.length;) {
    const header = buf[at], length = buf[at + 1] * 65536 + buf[at + 2] * 256 + buf[at + 3];
    at += 4;
    if (length > buf.length - at) break;
    if ((header & 127) === 4) vorbisTags(buf.subarray(at, at + length), tags);
    at += length;
    if (header & 128) break;
  }
  return tags;
}

function opusTags(buf) {
  const tags = Object.create(null), dv = view(buf);
  let serial = null, sequence = null, parts = [], length = 0, packets = 0;
  for (let at = 0; at + 27 <= buf.length && packets < 2;) {
    if (ascii(buf, at, 4) !== "OggS" || buf[at + 4] !== 0) break;
    const count = buf[at + 26], start = at + 27 + count;
    if (start > buf.length) break;
    const id = dv.getUint32(at + 14, true), seq = dv.getUint32(at + 18, true);
    let end = start;
    for (let i = 0; i < count; i++) end += buf[at + 27 + i];
    if (end > buf.length) break;
    if (serial == null) serial = id;
    if (id === serial) {
      if ((sequence != null && seq !== ((sequence + 1) >>> 0)) || !!(buf[at + 5] & 1) !== (length > 0)) break;
      sequence = seq;
      let pos = start;
      for (let i = 0; i < count && packets < 2; i++) {
        const size = buf[at + 27 + i];
        length += size;
        if (length > PNG_READ_CAP) return tags;
        parts.push(buf.subarray(pos, pos + size)); pos += size;
        if (size === 255) continue;
        const packet = new Uint8Array(length); let offset = 0;
        for (const part of parts) { packet.set(part, offset); offset += part.length; }
        if (packets === 0 && ascii(packet, 0, 8) !== "OpusHead") return tags;
        if (packets === 1 && ascii(packet, 0, 8) === "OpusTags") vorbisTags(packet.subarray(8), tags);
        packets++; parts = []; length = 0;
      }
    }
    at = end;
  }
  return tags;
}

const synchsafe = (buf, at) => {
  if (at + 4 > buf.length || buf.subarray(at, at + 4).some(byte => byte & 128)) return null;
  return buf[at] * 2097152 + buf[at + 1] * 16384 + buf[at + 2] * 128 + buf[at + 3];
};
const deunsync = buf => buf.filter((byte, i) => !(byte === 0 && i > 0 && buf[i - 1] === 255));
function id3Tags(buf) {
  const tags = Object.create(null), version = buf[3];
  if (buf.length < 10 || ascii(buf, 0, 3) !== "ID3" || ![3, 4].includes(version)) return tags;
  const size = synchsafe(buf, 6);
  if (size == null || size > buf.length - 10) return tags;
  let data = buf.subarray(10, 10 + size);
  if (version === 3 && (buf[5] & 128)) data = deunsync(data);
  const dv = view(data);
  let at = 0;
  if (buf[5] & 64) { // extended header sizes differ between ID3v2.3 and 2.4
    if (data.length < 4) return tags;
    at = version === 4 ? synchsafe(data, 0) : 4 + dv.getUint32(0);
    if (at == null || at < 4 || at > data.length) return tags;
  }
  for (; at + 10 <= data.length;) {
    const id = ascii(data, at, 4), n = version === 4 ? synchsafe(data, at + 4) : dv.getUint32(at + 4);
    const flags = data[at + 9]; at += 10;
    if (n == null || n > data.length - at) break;
    let frame = data.subarray(at, at + n); at += n;
    if (id !== "TXXX" || n > PNG_READ_CAP || !n || (flags & (version === 4 ? 0x0c : 0xc0))) continue;
    if (version === 4 && ((flags & 2) || (buf[5] & 128))) frame = deunsync(frame);
    if (flags & (version === 4 ? 0x40 : 0x20)) frame = frame.subarray(1); // grouping identity
    if (version === 4 && (flags & 1)) frame = frame.subarray(4); // data length indicator
    const encoding = frame[0], text = frame.subarray(1), wide = encoding === 1 || encoding === 2;
    if (encoding > 3) continue;
    let split = -1;
    for (let i = 0; i < text.length - (wide ? 1 : 0); i += wide ? 2 : 1) {
      if (text[i] === 0 && (!wide || text[i + 1] === 0)) { split = i; break; }
    }
    if (split < 0) continue;
    const label = encoding === 0 ? "latin1" : encoding === 3 ? "utf-8" :
      encoding === 2 || (text[0] === 254 && text[1] === 255) ? "utf-16be" : "utf-16le";
    const decode = bytes => new TextDecoder(label).decode(bytes).replace(/\0+$/, "");
    putTag(tags, decode(text.subarray(0, split)), decode(text.subarray(split + (wide ? 2 : 1))));
  }
  return tags;
}

function waveTags(buf) {
  const tags = Object.create(null);
  if (buf.length < 12 || ascii(buf, 0, 4) !== "RIFF" || ascii(buf, 8, 4) !== "WAVE") return tags;
  const dv = view(buf), end = Math.min(buf.length, dv.getUint32(4, true) + 8);
  for (let at = 12; at + 8 <= end;) {
    const n = dv.getUint32(at + 4, true), start = at + 8;
    if (n > end - start) break;
    if (ascii(buf, at, 4) === "LIST" && n >= 4 && ascii(buf, start, 4) === "INFO") {
      for (let p = start + 4; p + 8 <= start + n;) {
        const length = dv.getUint32(p + 4, true), value = p + 8;
        if (length > start + n - value) break;
        if (ascii(buf, p, 4) === "ICMT" && length <= PNG_READ_CAP) putTag(tags, "comment", utf8(buf.subarray(value, value + length)));
        p = value + length + (length & 1);
      }
    }
    at = start + n + (n & 1);
  }
  return tags;
}

function webpTags(buf) {
  const tags = Object.create(null);
  if (ascii(buf, 0, 4) !== "RIFF" || ascii(buf, 8, 4) !== "WEBP") return tags;
  const dv = view(buf), end = Math.min(buf.length, dv.getUint32(4, true) + 8);
  for (let off = 12; off + 8 <= end;) {
    const length = dv.getUint32(off + 4, true), start = off + 8;
    if (length > end - start) break;
    if (ascii(buf, off, 4) === "EXIF") {
      let tiff = buf.subarray(start, start + length);
      if (ascii(tiff, 0, 6) === "Exif\0\0") tiff = tiff.subarray(6);
      if (tiff.length >= 8) {
        const td = view(tiff), le = ascii(tiff, 0, 2) === "II";
        if ((le || ascii(tiff, 0, 2) === "MM") && td.getUint16(2, le) === 42) {
          const ifd = td.getUint32(4, le);
          if (ifd <= tiff.length - 2) {
            const count = td.getUint16(ifd, le);
            for (let i = 0; i < count && ifd + 2 + (i + 1) * 12 <= tiff.length; i++) {
              const entry = ifd + 2 + i * 12, type = td.getUint16(entry + 2, le);
              if (type !== 2 && type !== 7) continue; // ASCII or UNDEFINED
              const size = td.getUint32(entry + 4, le);
              const at = size <= 4 ? entry + 8 : td.getUint32(entry + 8, le);
              if (size > tiff.length - at) continue;
              const text = utf8(tiff.subarray(at, at + size));
              const match = /^(prompt|workflow|kz):([\s\S]*)$/i.exec(text);
              if (match) putTag(tags, match[1], match[2]);
            }
          }
        }
      }
    }
    off = start + length + (length & 1);
  }
  return tags;
}

// ISO BMFF: size/type boxes, including extended 64-bit and size-to-end boxes.
// A partial parent may expose complete children to the 64KiB dimension pass.
function boxes(buf, start = 0, end = buf.length) {
  const out = [], dv = view(buf);
  for (let off = start; off + 8 <= end;) {
    let size = dv.getUint32(off), header = 8;
    if (size === 1) {
      if (off + 16 > end) break;
      size = Number(dv.getBigUint64(off + 8)); header = 16;
    } else if (size === 0) size = end - off;
    if (!Number.isSafeInteger(size) || size < header) break;
    out.push({ type: ascii(buf, off + 4, 4), id: dv.getUint32(off + 4), start: off + header,
      end: Math.min(end, off + size), complete: size <= end - off });
    off += size;
  }
  return out;
}

function quickTime(buf) {
  const tags = Object.create(null), dv = view(buf);
  let dims = null;
  const children = box => boxes(buf, box.start, box.end);
  const metaTags = box => {
    // meta is a FullBox (version+flags), then hdlr/keys/ilst children.
    const parts = boxes(buf, box.start + 4, box.end), keys = [];
    const keyBox = parts.find(p => p.type === "keys" && p.complete);
    if (keyBox && keyBox.start + 8 <= keyBox.end) {
      const count = dv.getUint32(keyBox.start + 4);
      let at = keyBox.start + 8;
      for (let i = 0; i < count && at + 8 <= keyBox.end; i++) {
        const size = dv.getUint32(at);
        if (size < 8 || size > keyBox.end - at) break;
        keys.push(ascii(buf, at + 4, 4) === "mdta" ? utf8(buf.subarray(at + 8, at + size)) : "");
        at += size;
      }
    }
    for (const ilst of parts.filter(p => p.type === "ilst")) {
      for (const item of children(ilst)) {
        const key = item.type === "©cmt" ? "comment" : keys[item.id - 1];
        if (!key) continue;
        for (const data of children(item)) {
          if (data.type !== "data" || !data.complete || data.start + 8 > data.end) continue;
          // data: 4-byte type indicator (1=UTF-8), 4-byte locale, value.
          if ((dv.getUint32(data.start) & 0xffffff) === 1) putTag(tags, key, utf8(buf.subarray(data.start + 8, data.end)));
        }
      }
    }
  };
  for (const moov of boxes(buf).filter(b => b.type === "moov")) {
    for (const part of children(moov)) {
      if (part.type === "meta") metaTags(part);
      if (part.type === "udta") for (const meta of children(part).filter(b => b.type === "meta")) metaTags(meta);
      if (part.type !== "trak" || dims) continue;
      const track = children(part), tkhd = track.find(b => b.type === "tkhd" && b.complete);
      const mdia = track.find(b => b.type === "mdia");
      const hdlr = mdia && children(mdia).find(b => b.type === "hdlr");
      if (!tkhd || !hdlr || hdlr.start + 12 > hdlr.end || ascii(buf, hdlr.start + 8, 4) !== "vide") continue;
      const version = buf[tkhd.start], widthAt = tkhd.start + (version === 1 ? 88 : 76);
      if ((version !== 0 && version !== 1) || widthAt + 8 > tkhd.end) continue;
      let width = Math.round(dv.getUint32(widthAt) / 65536), height = Math.round(dv.getUint32(widthAt + 4) / 65536);
      // The tkhd matrix carries quarter-turn display rotations.
      const matrix = tkhd.start + (version === 1 ? 52 : 40);
      if (dv.getInt32(matrix) === 0 && Math.abs(dv.getInt32(matrix + 4)) === 65536) [width, height] = [height, width];
      if (width > 0 && height > 0) dims = { width, height };
    }
  }
  return { tags, dims };
}

// EBML variable-length IDs retain their marker; sizes discard it. Unknown
// sizes are accepted for containers (not treated as an enormous allocation).
function vint(buf, at, end, id = false) {
  if (at >= end || buf[at] === 0) return null;
  let length = 1, mask = 0x80;
  while (!(buf[at] & mask)) { length++; mask >>= 1; }
  if (length > (id ? 4 : 8) || length > end - at) return null;
  let value = id ? buf[at] : buf[at] & (mask - 1), unknown = !id && value === mask - 1;
  for (let i = 1; i < length; i++) { value = value * 256 + buf[at + i]; unknown &&= buf[at + i] === 255; }
  return { length, value: unknown ? null : value };
}

function matroska(buf) {
  const tags = Object.create(null);
  let dims = null, budget = 100_000;
  const containers = new Set([0x1a45dfa3, 0x18538067, 0x1654ae6b, 0xae, 0xe0, 0x1254c367, 0x7373, 0x67c8]);
  const uint = (start, end) => {
    if (end - start > 6) return null;
    let n = 0; for (let at = start; at < end; at++) n = n * 256 + buf[at]; return n;
  };
  const walk = (start, end, depth = 0) => {
    const values = new Map();
    if (depth > 16) return values;
    for (let at = start; at < end && budget-- > 0;) {
      const id = vint(buf, at, end, true);
      if (!id) break;
      const size = vint(buf, at + id.length, end);
      if (!size) break;
      const payload = at + id.length + size.length;
      if (size.value != null && !Number.isSafeInteger(size.value)) break;
      const stop = size.value == null ? end : Math.min(end, payload + size.value);
      const complete = size.value == null || size.value <= end - payload;
      if (containers.has(id.value)) {
        const child = walk(payload, stop, depth + 1);
        if (id.value === 0x67c8 && child.has(0x45a3) && child.has(0x4487)) putTag(tags, child.get(0x45a3), child.get(0x4487));
        if (id.value === 0xe0) values.set(id.value, child);
        if (id.value === 0xae && child.get(0x83) === 1) {
          const video = child.get(0xe0), width = video?.get(0xb0), height = video?.get(0xba);
          if (!dims && width > 0 && height > 0) dims = { width, height };
        }
      } else if (complete) {
        if ([0x83, 0xb0, 0xba].includes(id.value)) values.set(id.value, uint(payload, stop));
        if ([0x45a3, 0x4487].includes(id.value)) values.set(id.value, utf8(buf.subarray(payload, stop)));
      }
      at = stop;
    }
    return values;
  };
  if (sniffMime(buf) === "video/webm") walk(0, buf.length);
  return { tags, dims };
}
