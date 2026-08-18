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
//   --fixtures <dir>   serve the PNG fixtures found in <dir> (default tests/fixtures)
//   --bulk <N>         additionally serve N synthetic 1x1 images
//   --port <n>         listen port (default 8188)
//
// Quirk reproduced on purpose: the real /internal/files/output listing
// appends " [123]" (a size suffix) to each entry; the engine strips it via
// clean_file_name. If the fake omitted the suffix the port would never
// exercise the stripping and a real fleet would break it.

import { parseArgs } from "node:util";
import { readdir, readFile } from "node:fs/promises";
import { join, basename } from "node:path";

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

// A 1x1 transparent PNG, used for synthetic bulk images.
const BULK_PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

const { values } = parseArgs({
  options: {
    fixtures: { type: "string", default: new URL("./fixtures", import.meta.url).pathname },
    bulk: { type: "string", default: "0" },
    port: { type: "string", default: "8188" },
  },
});

const fixtureDir = values.fixtures;
const bulkCount = parseInt(values.bulk, 10);
const port = parseInt(values.port, 10);

// Load fixtures once at startup: filename -> { bytes, promptGraph|null }
const fixtures = new Map();
try {
  for (const f of await readdir(fixtureDir)) {
    if (!f.endsWith(".png")) continue;
    const bytes = await readFile(join(fixtureDir, f));
    const text = readPngText(bytes);
    let promptGraph = null;
    if (text.prompt) {
      try {
        promptGraph = JSON.parse(text.prompt);
      } catch {
        // fixture with unparseable prompt chunk — serves as a negative
      }
    }
    fixtures.set(f, { bytes, promptGraph });
  }
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}

// One filename that must 404, to drive the permanent-failure path.
const MISSING = "missing-404.png";

function fileList() {
  const names = [...fixtures.keys()];
  for (let i = 0; i < bulkCount; i++) {
    names.push("bulk-" + String(i).padStart(5, "0") + ".png");
  }
  names.push(MISSING);
  // Real ComfyUI suffixes each entry with " [size]"; the engine strips it.
  return names.map((n) => n + " [" + n.length * 137 + "]");
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
    };
  }
  return out;
}

export const server = Deno.serve({ port }, (req) => {
  const url = new URL(req.url);
  const p = url.pathname;

  if (p === "/api/system_stats") {
    // Only the status code is inspected (drives the online/offline dot).
    return Response.json({ system: { os: "fake" }, devices: [] });
  }

  if (p === "/internal/files/output") {
    return Response.json(fileList());
  }

  if (p === "/api/view") {
    const filename = url.searchParams.get("filename") ?? "";
    const name = basename(filename);
    if (name === MISSING) return new Response("not found", { status: 404 });
    if (fixtures.has(name)) {
      const bytes = fixtures.get(name).bytes;
      return new Response(bytes, {
        headers: { "Content-Type": "image/png", "Content-Length": String(bytes.length) },
      });
    }
    if (/^bulk-\d{5}\.png$/.test(name)) {
      return new Response(BULK_PNG, {
        headers: { "Content-Type": "image/png", "Content-Length": String(BULK_PNG.length) },
      });
    }
    return new Response("not found", { status: 404 });
  }

  if (p === "/api/history") {
    return Response.json(history());
  }

  return new Response("not found", { status: 404 });
});

console.log(
  `fake-comfy on :${port} — ${fixtures.size} fixtures, ${bulkCount} bulk, ` +
    "history entries derived from embedded graphs",
);
