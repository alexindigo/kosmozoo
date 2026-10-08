// tests/fake-comfy.mjs — thin ComfyUI-compatible API for offline testing.
//
// Serves the four GET endpoints the kosmozoo engine calls, nothing else.
// Fixture PNGs live in tests/fixtures/; each fixture carries an embedded
// ComfyUI prompt/workflow graph, and this host *derives* its /api/history
// response from those embedded graphs so both ingestion paths (live history
// merge and PNG scrape) are driven from one source of truth — which is also
// how the real system behaves.
//
// Modes:
//   --fixtures <dir>     serve the PNG fixtures found in <dir> (default tests/fixtures)
//   --bulk <N>           additionally serve N synthetic 1x1 images
//   --port <n>           listen port (default 8188)
//   --mutable-dir <dir>  serve any file found in <dir> straight from disk,
//                        with a stat-derived ETag — the reused-filename
//                        revalidation e2e rewrites one in place
//
// Quirk reproduced on purpose: the real /internal/files/output listing
// appends " [123]" (a size suffix) to each entry; the engine strips it via
// clean_file_name. If the fake omitted the suffix the port would never
// exercise the stripping and a real fleet would break it.
//
// Another real-ComfyUI trait: /api/view always carries an aiohttp-style
// ETag ("<mtime_ns_hex>-<size_hex>") — the engine's revalidation stamp.

import { parseArgs } from "node:util";
import { readdir, readFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join, basename } from "node:path";
import { isEntryPath, splitEntryPath } from "../src/entry-path.mjs";
import { testPng } from "./helpers/png.mjs";

// ---------------------------------------------------------------------------
// Minimal PNG tEXt chunk reader — just enough to pull the embedded
// `prompt` / `workflow` JSON out of a fixture. Mirrors the engine's parser:
// stops at the first IDAT, caps the scan at 256 KB.

const PNG_SIG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function readPngText(buf) {
  const out = {};
  if (buf.length < 8) return out;
  for (let i = 0; i < 8; i++) if (buf[i] !== PNG_SIG[i]) return out;
  let off = 8;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const cap = Math.min(buf.length, 256 * 1024);
  while (off + 12 <= cap) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7]);
    if (type === "IDAT") break;
    if (type === "tEXt") {
      const data = buf.subarray(off + 8, off + 8 + len);
      const nul = data.indexOf(0);
      if (nul > 0) {
        const key = new TextDecoder("latin1").decode(data.subarray(0, nul));
        const val = new TextDecoder("utf-8").decode(data.subarray(nul + 1));
        out[key] = val;
      }
    }
    off += 12 + len; // length + type + data + crc
  }
  return out;
}

// A 640x360 solid PNG, used for synthetic bulk images. Real pixels at a real
// size — the client never upscales past natural size, so the substrate's
// images must be honest about their dimensions.
const BULK_PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAoAAAAFoCAYAAADHMkpRAAAGoUlEQVR4nO3WIQEAIADAMHKhCED/OtACxCfmLz/m2gcAgI7xOwAAgLcMIABAjAEEAIgxgAAAMQYQACDGAAIAxBhAAIAYAwgAEGMAAQBiDCAAQIwBBACIMYAAADEGEAAgxgACAMQYQACAGAMIABBjAAEAYgwgAECMAQQAiDGAAAAxBhAAIMYAAgDEGEAAgBgDCAAQYwABAGIMIABAjAEEAIgxgAAAMQYQACDGAAIAxBhAAIAYAwgAEGMAAQBiDCAAQIwBBACIMYAAADEGEAAgxgACAMQYQACAGAMIABBjAAEAYgwgAECMAQQAiDGAAAAxBhAAIMYAAgDEGEAAgBgDCAAQYwABAGIMIABAjAEEAIgxgAAAMQYQACDGAAIAxBhAAIAYAwgAEGMAAQBiDCAAQIwBBACIMYAAADEGEAAgxgACAMQYQACAGAMIABBjAAEAYgwgAECMAQQAiDGAAAAxBhAAIMYAAgDEGEAAgBgDCAAQYwABAGIMIABAjAEEAIgxgAAAMQYQACDGAAIAxBhAAIAYAwgAEGMAAQBiDCAAQIwBBACIMYAAADEGEAAgxgACAMQYQACAGAMIABBjAAEAYgwgAECMAQQAiDGAAAAxBhAAIMYAAgDEGEAAgBgDCAAQYwABAGIMIABAjAEEAIgxgAAAMQYQACDGAAIAxBhAAIAYAwgAEGMAAQBiDCAAQIwBBACIMYAAADEGEAAgxgACAMQYQACAGAMIABBjAAEAYgwgAECMAQQAiDGAAAAxBhAAIMYAAgDEGEAAgBgDCAAQYwABAGIMIABAjAEEAIgxgAAAMQYQACDGAAIAxBhAAIAYAwgAEGMAAQBiDCAAQIwBBACIMYAAADEGEAAgxgACAMQYQACAGAMIABBjAAEAYgwgAECMAQQAiDGAAAAxBhAAIMYAAgDEGEAAgBgDCAAQYwABAGIMIABAjAEEAIgxgAAAMQYQACDGAAIAxBhAAIAYAwgAEGMAAQBiDCAAQIwBBACIMYAAADEGEAAgxgACAMQYQACAGAMIABBjAAEAYgwgAECMAQQAiDGAAAAxBhAAIMYAAgDEGEAAgBgDCAAQYwABAGIMIABAjAEEAIgxgAAAMQYQACDGAAIAxBhAAIAYAwgAEGMAAQBiDCAAQIwBBACIMYAAADEGEAAgxgACAMQYQACAGAMIABBjAAEAYgwgAECMAQQAiDGAAAAxBhAAIMYAAgDEGEAAgBgDCAAQYwABAGIMIABAjAEEAIgxgAAAMQYQACDGAAIAxBhAAIAYAwgAEGMAAQBiDCAAQIwBBACIMYAAADEGEAAgxgACAMQYQACAGAMIABBjAAEAYgwgAECMAQQAiDGAAAAxBhAAIMYAAgDEGEAAgBgDCAAQYwABAGIMIABAjAEEAIgxgAAAMQYQACDGAAIAxBhAAIAYAwgAEGMAAQBiDCAAQIwBBACIMYAAADEGEAAgxgACAMQYQACAGAMIABBjAAEAYgwgAECMAQQAiDGAAAAxBhAAIMYAAgDEGEAAgBgDCAAQYwABAGIMIABAjAEEAIgxgAAAMQYQACDGAAIAxBhAAIAYAwgAEGMAAQBiDCAAQIwBBACIMYAAADEGEAAgxgACAMQYQACAGAMIABBjAAEAYgwgAECMAQQAiDGAAAAxBhAAIMYAAgDEGEAAgBgDCAAQYwABAGIMIABAjAEEAIgxgAAAMQYQACDGAAIAxBhAAIAYAwgAEGMAAQBiDCAAQIwBBACIMYAAADEGEAAgxgACAMQYQACAGAMIABBjAAEAYgwgAECMAQQAiDGAAAAxBhAAIMYAAgDEGEAAgBgDCAAQYwABAGIMIABAjAEEAIgxgAAAMQYQACDGAAIAxBhAAIAYAwgAEGMAAQBiDCAAQIwBBACIMYAAADEGEAAgxgACAMQYQACAGAMIABBjAAEAYgwgAECMAQQAiDGAAAAxBhAAIMYAAgDEGEAAgBgDCAAQYwABAGIMIABAjAEEAIgxgAAAMQYQACDGAAIAxBhAAIAYAwgAEGMAAQBiDCAAQIwBBACIMYAAADEGEAAgxgACAMQYQACAGAMIABBjAAEAYgwgAECMAQQAiDGAAAAxBhAAIMYAAgDEGEAAgBgDCAAQYwABAGIMIABAjAEEAIgxgAAAMQYQACDGAAIAxBhAAIAYAwgAEGMAAQBiDCAAQIwBBACIMYAAADEGEAAgxgACAMQYQACAGAMIABBjAAEAYgwgAECMAQQAiDGAAAAxBhAAIMYAAgDEGEAAgJgLPB/xSa0K3n4AAAAASUVORK5CYII=",
  ),
  (c) => c.charCodeAt(0),
);

const { values } = parseArgs({
  options: {
    fixtures: { type: "string", default: new URL("./fixtures", import.meta.url).pathname },
    bulk: { type: "string", default: "0" },
    port: { type: "string", default: "8188" },
    "mutable-dir": { type: "string", default: "" },
  },
});

const fixtureDir = values.fixtures;
const bulkCount = parseInt(values.bulk, 10);
const port = parseInt(values.port, 10);
const mutableDir = values["mutable-dir"];

// Load fixtures once at startup: filename -> { bytes, promptGraph|null }
const fixtures = new Map();
try {
  for (const f of await readdir(fixtureDir)) {
    if (!f.endsWith(".png") && !f.endsWith(".svg")) continue;
    const bytes = await readFile(join(fixtureDir, f));
    let promptGraph = null;
    if (f.endsWith(".png")) {
      const text = readPngText(bytes);
      if (text.prompt) {
        try {
          promptGraph = JSON.parse(text.prompt);
        } catch {
          // fixture with unparseable prompt chunk — serves as a negative
        }
      }
    }
    fixtures.set(f, { bytes, promptGraph });
  }
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}

// One filename that must 404, to drive the permanent-failure path.
const MISSING = "missing-404.png";
const fixtureTimes = new Map([...fixtures.keys()].map((name, i) => [name, (1_900_000_000 - i) * 1000]));

// One stable per-file model, independent of enumeration/arrival order.
function fileMetadata(name) {
  if (mutableDir) {
    try {
      const s = statSync(join(mutableDir, name));
      if (s.isFile()) return { timeMs: s.mtimeMs, size: s.size };
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const publishedFile = published.get(name);
  const bulk = /^bulk-(\d{5})\.png$/.exec(name);
  return {
    timeMs: publishedFile ? publishedFile.mtime * 1000 : fixtureTimes.get(name) ??
      (bulk ? (1_800_000_000 - Number(bulk[1])) * 1000 : 1_700_000_000_000),
    size: (publishedFile ?? fixtures.get(name))?.bytes.length ?? (name === MISSING ? 0 : BULK_PNG.length),
  };
}

function sourceHeaders(name, type = "image/png") {
  const { timeMs, size } = fileMetadata(name);
  const ns = BigInt(Math.trunc(timeMs)) * 1_000_000n;
  return { "Content-Type": type, "Content-Length": String(size),
    "Last-Modified": new Date(timeMs).toUTCString(), ETag: `"${ns.toString(16)}-${size.toString(16)}"` };
}

// full-read order for tests that assert drain priority (dims head reads are
// excluded — they exercise the same file with a Range header)
const readOrder = [];

// aiohttp's FileResponse honors Range and answers 206; the dims pass's head
// reads exercise the real path (a server that ignores it answers 200 with
// the full body — callers accept both)
function ranged(req, bytes, headers) {
  const range = req.headers.get("range");
  const m = range && /^bytes=(\d+)-(\d+)$/.exec(range);
  if (!m) return new Response(bytes, { headers });
  const start = Number(m[1]);
  const end = Math.min(Number(m[2]) + 1, bytes.length);
  const h = new Headers(headers);
  h.set("Content-Range", `bytes ${start}-${end - 1}/${bytes.length}`);
  h.set("Content-Length", String(end - start));
  return new Response(bytes.subarray(start, end), { status: 206, headers: h });
}

function fileNames() {
  const names = [...published.keys(), ...fixtures.keys()];
  for (let i = 0; i < bulkCount; i++) {
    names.push("bulk-" + String(i).padStart(5, "0") + ".png");
  }
  names.push(MISSING);
  return names.filter((name) => !removed.has(name));
}

function fileList() {
  // Real ComfyUI suffixes each entry with " [size]"; the engine strips it.
  return fileNames().map((name) => ({ name, ...fileMetadata(name) }))
    .filter(({ name }) => !name.includes("/"))
    .sort((a, b) => b.timeMs - a.timeMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(({ name: n }) => n + " [" +
    ((published.get(n) ?? fixtures.get(n))?.bytes.length ?? (n === MISSING ? 0 : BULK_PNG.length)) + "]");
}

function history() {
  // Synthesise one history entry per fixture that carries a prompt graph.
  const out = {};
  let pid = 0;
  for (const [fname, fx] of fixtures) {
    if (!fx.promptGraph) continue;
    const id = "fixture-" + pid++;
    out[id] = {
      prompt: [2, id, fx.promptGraph],
      outputs: {
        "9": { images: [{ filename: fname, type: "output" }] },
      },
      status: { completed: true, status_str: "success", messages: [["execution_success", {}]] },
    };
  }
  return out;
}

// Explicit test-only external activity. Named output bytes are real fixture
// bytes, acquired by the production engine's ordinary GET/HEAD/range path.
const published = new Map();
const publishedInputs = new Map();
const removed = new Set();
let terminalHistory = history();
let running = [], pending = [], logs = [], failures = {}, delays = {};
let extension = true, listOverride = null, publishRevision = 0;
let captureEnqueue = false, enqueues = [];
let metadataBombs = new Set(), assetsHidden = new Set();
let headOverrides = {}, headDelayMs = 0;
const telemetryRequests = { queue: 0, history: 0, logs: 0 };
const activeLogs = new Set();
let logSequence = 0;

function publication(description) {
  const fixture = description.fixture === "bulk" ? { bytes: BULK_PNG, promptGraph: null }
    : fixtures.get(description.fixture ?? "flux-basic.png");
  if (!fixture) return null;
  if (description.width || description.height || description.color || description.graphPrefix || description.lineage) {
    const width = description.width ?? new DataView(fixture.bytes.buffer, fixture.bytes.byteOffset).getUint32(16);
    const height = description.height ?? new DataView(fixture.bytes.buffer, fixture.bytes.byteOffset).getUint32(20);
    if (![width, height].every((n) => Number.isInteger(n) && n > 0 && n <= 2048)) return null;
    const graph = fixture.promptGraph ? structuredClone(fixture.promptGraph) : null;
    if (description.graphPrefix && graph) {
      for (const node of Object.values(graph)) if (node.class_type === "SaveImage") node.inputs.filename_prefix = description.graphPrefix;
    }
    return { bytes: testPng(width, height, description.color, graph, description.lineage), promptGraph: graph };
  }
  return fixture;
}

function queueRows(ids) {
  return ids.map((id, index) => [index, id, {}, { client_id: "external-fixture-client" }, []]);
}

export const server = Deno.serve({ port }, async (req) => {
  const url = new URL(req.url);
  const p = url.pathname;

  if (p === "/__test/activity" && req.method === "POST") {
    const body = await req.json();
    if (body.reset) {
      published.clear(); terminalHistory = history();
      removed.clear(); publishedInputs.clear(); extension = true; listOverride = null; publishRevision = 0;
      captureEnqueue = false; enqueues = [];
      metadataBombs = new Set(); assetsHidden = new Set();
      headOverrides = {}; headDelayMs = 0;
      telemetryRequests.queue = 0; telemetryRequests.history = 0; telemetryRequests.logs = 0; activeLogs.clear();
      running = []; pending = []; logs = []; failures = {}; delays = {};
    }
    if (body.running) running = [...body.running];
    if (body.pending) pending = [...body.pending];
    if (body.logs) logs = body.logs.map((entry) => ({ ...entry }));
    if (body.appendLogs) logs.push(...body.appendLogs.map((entry) => ({ ...entry })));
    if (body.clearHistory) terminalHistory = {};
    if (body.failures) failures = { ...body.failures };
    if (body.delays) delays = { ...body.delays };
    if (body.extension !== undefined) extension = body.extension;
    if (body.listOverride !== undefined) listOverride = body.listOverride;
    if (body.captureEnqueue !== undefined) captureEnqueue = body.captureEnqueue;
    if (body.metadataBombs) metadataBombs = new Set(body.metadataBombs);
    if (body.assetsHidden) assetsHidden = new Set(body.assetsHidden);
    if (body.headOverrides) headOverrides = body.headOverrides;
    if (body.headDelayMs !== undefined) headDelayMs = body.headDelayMs;
    for (const name of body.remove ?? []) removed.add(name);
    for (const output of body.publish ?? []) {
      const fixture = publication(output);
      if (!fixture || !isEntryPath(output.name)) return new Response("invalid fixture output", { status: 400 });
      removed.delete(output.name);
      published.set(output.name, { ...fixture, mtime: output.mtime ?? 2_000_000_000 + ++publishRevision });
    }
    for (const input of body.publishInputs ?? []) {
      const fixture = publication(input);
      if (!fixture || !isEntryPath(input.name)) return new Response("invalid fixture input", { status: 400 });
      publishedInputs.set(input.name, fixture);
    }
    for (const job of body.finish ?? []) {
      running = running.filter((id) => id !== job.id);
      pending = pending.filter((id) => id !== job.id);
      if (job.output) {
        const fixture = publication(job);
        if (!fixture || !isEntryPath(job.output)) return new Response("invalid fixture output", { status: 400 });
        removed.delete(job.output);
        published.set(job.output, { ...fixture, mtime: job.mtime ?? 2_000_000_000 + ++publishRevision });
      }
      const outcome = job.outcome ?? "success";
      terminalHistory[job.id] = {
        prompt: [0, job.id, {}, { client_id: "external-fixture-client" }],
        outputs: job.output ? { "9": { images: [{ ...splitEntryPath(job.output), type: "output" }] } } : {},
        status: { completed: outcome === "success", status_str: outcome === "success" ? "success" : "error",
          messages: [[outcome === "interrupted" ? "execution_interrupted" : outcome === "error" ? "execution_error" : "execution_success", {}]] },
      };
    }
    return Response.json({ running, pending, published: [...published.keys()] });
  }

  if (p === "/__test/telemetry" && req.method === "GET") {
    return Response.json({ requests: { ...telemetryRequests }, activeLogs: activeLogs.size });
  }

  const channel = p === "/api/queue" ? "queue" : p.startsWith("/api/history") ? "history"
    : p === "/internal/logs/raw" ? "logs"
    : p === "/internal/files/output" || p === "/api/assets_plus/output/list" ? "listing" : null;
  if (channel && req.method === "GET") {
    if (channel in telemetryRequests) telemetryRequests[channel]++;
    const log = channel === "logs" ? ++logSequence : null;
    if (log !== null) activeLogs.add(log);
    try {
      if (delays[channel]) await new Promise((resolve) => setTimeout(resolve, delays[channel]));
    } finally { if (log !== null) activeLogs.delete(log); }
    if (failures[channel]) return new Response("controlled failure", { status: failures[channel] });
  }
  if (p === "/api/queue" && req.method === "GET") return Response.json({ queue_running: queueRows(running), queue_pending: queueRows(pending) });
  if (p === "/__test/enqueues" && req.method === "GET") return Response.json(enqueues);
  if (p === "/api/prompt" && req.method === "POST" && captureEnqueue) {
    enqueues.push(await req.json());
    return Response.json({ prompt_id: `captured-${enqueues.length}` });
  }
  if (p === "/api/assets_plus/config" && req.method === "GET") {
    if (!extension) return new Response("extension unavailable", { status: 404 });
    return Response.json({ allowed_extensions: [".png", ".jpg", ".jpeg", ".webp"],
      recursive: true, scan_depth: null, list_limit: 200 });
  }
  if (p === "/api/assets_plus/output/list" && req.method === "GET") {
    if (!extension) return new Response("extension unavailable", { status: 404 });
    if (listOverride !== null) return Response.json(listOverride);
    const recursive = !["0", "false", "False"].includes(url.searchParams.get("recursive") ?? "1");
    const depth = Number(url.searchParams.get("scan_depth") ?? -1);
    const extensions = new Set((url.searchParams.get("extensions") ?? "png,jpg,jpeg,webp").split(",").map((x) => x.replace(/^\./, "").toLowerCase()));
    let items = fileNames().map((name) => ({ relpath: name, filename: name.split("/").at(-1),
      size: fileMetadata(name).size,
      mtime: Math.floor(fileMetadata(name).timeMs / 1000), type: "image", has_workflow: false,
    })).filter((item) => (recursive || !item.relpath.includes("/")) &&
      (depth < 0 || item.relpath.split("/").length - 1 <= depth) && extensions.has(item.relpath.split(".").pop().toLowerCase()));
    items.sort((a, b) => b.mtime - a.mtime || (a.relpath < b.relpath ? -1 : a.relpath > b.relpath ? 1 : 0));
    // AssetsPlus hides/searches before Image.open(), but paginates afterward.
    const query = url.searchParams.get("query") ?? url.searchParams.get("q");
    items = items.filter((item) => !assetsHidden.has(item.relpath) &&
      (!query || item.relpath.toLowerCase().includes(query.toLowerCase())));
    if (items.some((item) => metadataBombs.has(item.relpath))) {
      return Response.json({ success: false, error: "DecompressionBombError" }, { status: 500 });
    }
    const latest_mtime = items[0]?.mtime ?? 0;
    const since = url.searchParams.get("since"), cursor = url.searchParams.get("cursor");
    if (since !== null) items = items.filter((item) => item.mtime > Number(since));
    else if (cursor) {
      const split = cursor.indexOf(":"), time = Number(split < 0 ? cursor : cursor.slice(0, split));
      const name = split < 0 ? null : cursor.slice(split + 1);
      items = items.filter((item) => item.mtime < time || (name !== null && item.mtime === time && item.relpath > name));
    }
    const limit = Number(url.searchParams.get("limit") ?? 200);
    const has_more = limit !== 0 && items.length > limit;
    if (limit) items = items.slice(0, limit);
    const last = items.at(-1);
    return Response.json({ items, has_more, latest_mtime, cursor: last ? `${last.mtime}:${last.relpath}` : cursor ?? "" });
  }
  if (p === "/internal/logs/raw" && req.method === "GET") return Response.json({ entries: logs, size: { cols: 80, rows: 24 } });
  if (p.startsWith("/api/history/") && req.method === "GET") {
    const id = decodeURIComponent(p.slice("/api/history/".length));
    return Response.json(terminalHistory[id] ? { [id]: terminalHistory[id] } : {});
  }

  if (p === "/api/system_stats") {
    // Only the status code is inspected (drives the online/offline dot).
    return Response.json({ system: { os: "fake" }, devices: [] });
  }

  // Declared input types (INT/FLOAT) for the fixture graph node classes —
  // the variations plugin reads these so float params at integer-looking
  // values (denoise=1, strength=1) are not mistaken for integers. Combo
  // widgets carry their option list (the variations enum sweep axes).
  if (p === "/api/object_info") {
    const INT = ["INT", {}], FLOAT = ["FLOAT", {}];
    // the fixture graphs' loras, plus one the graphs don't use (a pick target)
    const LORAS = [["detail.safetensors", "style.safetensors", "other.safetensors"], {}];
    const SAMPLERS = [["euler", "dpmpp_2m", "uni_pc"], {}];
    // the loader combos a real host publishes — without these the fixture
    // graphs' loader fields would surface as free-text sweep rows
    const UNETS = [["flux1-dev.safetensors"], {}];
    const DTYPES = [["default", "fp8_e4m3fn", "fp8_e5m2"], {}];
    const CLIPS = [["t5xxl_fp16.safetensors", "clip_l.safetensors"], {}];
    const CLIPTYPES = [["flux", "sdxl", "sd3"], {}];
    const VAES = [["ae.safetensors"], {}];
    const SCHEDULERS = [["simple", "sgm_uniform", "karras", "exponential"], {}];
    const def = (inputs) => ({ input: { required: inputs } });
    return Response.json({
      FluxGuidance: def({ guidance: FLOAT }),
      RandomNoise: def({ noise_seed: INT }),
      BasicScheduler: def({ steps: INT, denoise: FLOAT, scheduler: SCHEDULERS }),
      EmptyLatentImage: def({ width: INT, height: INT, batch_size: INT }),
      UNETLoader: def({ unet_name: UNETS, weight_dtype: DTYPES }),
      CLIPLoader: def({ clip_name: CLIPS, type: CLIPTYPES }),
      VAELoader: def({ vae_name: VAES }),
      LoraLoader: def({ lora_name: LORAS, strength_model: FLOAT, strength_clip: FLOAT }),
      LoraLoaderModelOnly: def({ lora_name: LORAS, strength_model: FLOAT }),
      KSamplerSelect: def({ sampler_name: SAMPLERS }),
      KSampler: def({ seed: INT, steps: INT, cfg: FLOAT, denoise: FLOAT }),
      // the feature identifies output nodes by this flag (F4)
      SaveImage: { output_node: true, input: { required: { filename_prefix: ["STRING", {}] } } },
    });
  }

  if (p === "/internal/files/output") {
    return Response.json(fileList());
  }

  // the input dir: the node-referenced images the fixture graphs carry
  // (flux-controlnet's canny.png, flux-ipadapter's ref.png) — the info
  // panel's discovered-images column loads these bytes
  const INPUT_IMAGES = ["canny.png", "ref.png"];

  if (p === "/internal/files/input") {
    return Response.json([...INPUT_IMAGES, ...publishedInputs.keys()].filter((name) => !name.includes("/")).map((n) => n + " [137]"));
  }

  if (p === "/read-order") {
    return Response.json(readOrder);
  }

  if (p === "/api/view") {
    const filename = url.searchParams.get("filename") ?? "";
    const subfolder = url.searchParams.get("subfolder") ?? "";
    if (basename(filename) !== filename) return new Response("bad filename", { status: 400 });
    const name = subfolder ? `${subfolder}/${filename}` : filename;
    if (!isEntryPath(name) || removed.has(name)) return new Response("not found", { status: 404 });
    if (name === MISSING) return new Response("not found", { status: 404 });
    const head = req.method === "HEAD";
    if (head) {
      if (headDelayMs) await new Promise((resolve) => setTimeout(resolve, headDelayMs));
      const override = headOverrides[name];
      if (override?.status && override.status !== 200) return new Response(null, { status: override.status });
      if (override) {
        const headers = new Headers(sourceHeaders(name));
        for (const [key, value] of Object.entries(override.headers ?? {})) {
          if (value === null) headers.delete(key); else headers.set(key, value);
        }
        return new Response(null, { headers });
      }
    }
    if (!head && !req.headers.get("range")) readOrder.push(name);
    // aiohttp-style ETag: "<mtime_ns_hex>-<size_hex>" (the engine's stamp).
    const etag = (mtimeNs, size) => `"${mtimeNs.toString(16)}-${size.toString(16)}"`;
    if (url.searchParams.get("type") === "input" && publishedInputs.has(name)) {
      const bytes = publishedInputs.get(name).bytes;
      const headers = { "Content-Type": "image/png", "Content-Length": String(bytes.length), ETag: etag(0n, BigInt(bytes.length)) };
      return head ? new Response(null, { headers }) : ranged(req, bytes, headers);
    }
    // input-dir node references: served as real images (the fixture bytes
    // stand in — the info panel needs a loadable image, not specific pixels)
    if (url.searchParams.get("type") === "input" && INPUT_IMAGES.includes(name)) {
      const bytes = fixtures.get("flux-basic.png")?.bytes;
      if (bytes) {
        if (head) {
          return new Response(null, {
            headers: {
              "Content-Type": "image/png",
              "Content-Length": String(bytes.length),
              ETag: etag(0n, BigInt(bytes.length)),
            },
          });
        }
        return ranged(req, bytes, {
          "Content-Type": "image/png",
          ETag: etag(0n, BigInt(bytes.length)),
        });
      }
    }
    if (mutableDir) {
      let st = null;
      try {
        st = statSync(join(mutableDir, name), { bigint: true });
      } catch { /* not the mutable file */ }
      if (st?.isFile()) {
        const bytes = head ? null : await readFile(join(mutableDir, name));
        return new Response(bytes, {
          headers: {
            "Content-Type": "image/png",
            "Content-Length": String(st.size),
            ETag: etag(st.mtimeNs, st.size),
            "Last-Modified": new Date(Number(st.mtimeNs / 1000000n)).toUTCString(),
          },
        });
      }
    }
    if (fixtures.has(name) || published.has(name)) {
      const bytes = (published.get(name) ?? fixtures.get(name)).bytes;
      // Real ComfyUI serves SVG (and sometimes everything) as octet-stream.
      const type = name.endsWith(".svg") ? "application/octet-stream" : "image/png";
      if (head) {
        return new Response(null, {
          headers: {
            "Content-Type": type,
            "Content-Length": String(bytes.length),
            ...sourceHeaders(name, type),
          },
        });
      }
      return ranged(req, bytes, {
        "Content-Type": type,
        ...sourceHeaders(name, type),
      });
    }
    if (/^bulk-\d{5}\.png$/.test(name)) {
      if (head) {
        return new Response(null, {
          headers: {
            "Content-Type": "image/png",
            "Content-Length": String(BULK_PNG.length),
            ...sourceHeaders(name),
          },
        });
      }
      return ranged(req, BULK_PNG, {
        "Content-Type": "image/png",
          ...sourceHeaders(name),
      });
    }
    return new Response("not found", { status: 404 });
  }

  if (p === "/api/history" && req.method === "GET") {
    const limit = url.searchParams.has("max_items") ? Number(url.searchParams.get("max_items")) : undefined;
    const entries = Object.entries(terminalHistory);
    return Response.json(Object.fromEntries(limit === undefined ? entries : entries.slice(-limit)));
  }

  return new Response("not found", { status: 404 });
});

console.log(
  `fake-comfy on :${port} — ${fixtures.size} fixtures, ${bulkCount} bulk, ` +
    "history entries derived from embedded graphs",
);
