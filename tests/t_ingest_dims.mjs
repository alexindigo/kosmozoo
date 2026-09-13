// tests/t_ingest_dims.mjs — the §4.2 dims pass: Ingest.dims parses width/
// height from a 64 KB head read — no hash, no cache write, no extract. A
// head that yields nothing leaves the dims null (the full ingest is the
// pass-2 fallback). A server that ignores Range gets the full-read fallback
// (200-without-206). Known dims short-circuit the backing read.

import { assert, assertEquals } from "jsr:@std/assert";
import { Ingest } from "../src/ingest.mjs";
import { Cache } from "../src/cache.mjs";
import { Store } from "../src/store.mjs";
import { imageDims } from "../src/extractor.mjs";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- synthetic images: just enough header for imageDims ---------------------

function jpegBytes(width = 320, height = 200) {
  const out = new Uint8Array(64);
  const dv = new DataView(out.buffer);
  out[0] = 0xff; out[1] = 0xd8; // SOI
  out[2] = 0xff; out[3] = 0xe0; // APP0
  dv.setUint16(4, 16);          // APP0 length → next marker at 20
  out[20] = 0xff; out[21] = 0xc0; // SOF0
  dv.setUint16(22, 11);
  out[24] = 8;                  // precision
  dv.setUint16(25, height);
  dv.setUint16(27, width);
  return out;
}

// a JPEG whose SOF sits PAST the 64 KB head (a giant APP1 segment) — the
// head read yields null; only the full bytes carry the dims
function deepSofJpegBytes(width = 640, height = 480) {
  const sofAt = 2 + 2 + 65535; // SOI + APP1 marker + APP1 length field+payload
  const out = new Uint8Array(sofAt + 13);
  const dv = new DataView(out.buffer);
  out[0] = 0xff; out[1] = 0xd8; // SOI
  out[2] = 0xff; out[3] = 0xe1; // APP1
  dv.setUint16(4, 65535);
  out[sofAt] = 0xff; out[sofAt + 1] = 0xc0; // SOF0
  dv.setUint16(sofAt + 2, 11);
  out[sofAt + 4] = 8;
  dv.setUint16(sofAt + 5, height);
  dv.setUint16(sofAt + 7, width);
  return out;
}

function webpBytes(width = 160, height = 90) {
  const out = new Uint8Array(30);
  const td = new TextEncoder();
  out.set(td.encode("RIFF"), 0);
  out.set(td.encode("WEBP"), 8);
  out.set(td.encode("VP8X"), 12);
  out[24] = (width - 1) & 0xff;
  out[25] = ((width - 1) >> 8) & 0xff;
  out[26] = ((width - 1) >> 16) & 0xff;
  out[27] = (height - 1) & 0xff;
  out[28] = ((height - 1) >> 8) & 0xff;
  out[29] = ((height - 1) >> 16) & 0xff;
  return out;
}

// --- a comfy-shaped fake that honors Range like aiohttp's FileResponse ------

function rangeComfy(bytesByName) {
  const state = { reads: [] }; // { name, range, served }
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1" }, (req) => {
    const url = new URL(req.url);
    if (url.pathname !== "/api/view") return new Response("nf", { status: 404 });
    const name = url.searchParams.get("filename");
    const bytes = bytesByName[name];
    if (!bytes) return new Response("nf", { status: 404 });
    const range = req.headers.get("range");
    if (range) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(range);
      const start = Number(m[1]);
      const end = m[2] === "" ? bytes.length - 1 : Math.min(Number(m[2]), bytes.length - 1);
      const slice = bytes.subarray(start, end + 1);
      state.reads.push({ name, range, served: slice.length });
      return new Response(slice, {
        status: 206,
        headers: {
          "Content-Type": "image/png",
          "Content-Range": `bytes ${start}-${end}/${bytes.length}`,
        },
      });
    }
    state.reads.push({ name, range: null, served: bytes.length });
    return new Response(bytes, { headers: { "Content-Type": "image/png" } });
  });
  return { state, server, addr: `127.0.0.1:${server.addr.port}` };
}

async function mk(dir, hosts) {
  const store = await Store.open(dir);
  const ingest = new Ingest(store, hosts, { cache: new Cache(join(dir, "cache")) });
  return { store, ingest };
}

Deno.test("dims: PNG head read over Range — dims stored, no hash, no extract", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-dims-"));
  const png = await readFile(new URL("./fixtures/flux-basic.png", import.meta.url).pathname);
  // pad past 64 KB so the head slice is provably a slice
  const big = new Uint8Array(100_000);
  big.set(png, 0);
  const { state, server, addr } = rangeComfy({ "big.png": big });
  const { store, ingest } = await mk(dir, { c: addr });

  const r = await ingest.dims("c", "big.png");
  assertEquals(r.dims, imageDims(png));
  assertEquals(state.reads.length, 1);
  assertEquals(state.reads[0].range, "bytes=0-65535");
  assertEquals(state.reads[0].served, 65536); // the head, not the 100 KB file

  // stored on the entry; NO hash, NO cache write, NO extract
  assertEquals(store.entryDims("c", "big.png"), imageDims(png));
  assertEquals(store.entryGet("c", "big.png").state, "seen");
  assertEquals(store.hashFor("c", "big.png"), null);
  assertEquals(store.metaState("c", "big.png").extracted, false);

  // known dims short-circuit: a second call never touches the backing
  const again = await ingest.dims("c", "big.png");
  assertEquals(again.dims, imageDims(png));
  assertEquals(state.reads.length, 1);

  // a name the source lost reports 404 (the prefetch marks it gone)
  const nf = await ingest.dims("c", "nope.png");
  assertEquals(nf.status, 404);
  assertEquals(nf.dims, null);

  await server.shutdown();
  await rm(dir, { recursive: true });
});

Deno.test("dims: a server that ignores Range falls back to the full read", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-dims-fb-"));
  const png = await readFile(new URL("./fixtures/flux-basic.png", import.meta.url).pathname);
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1" }, (req) => {
    const url = new URL(req.url);
    if (url.pathname !== "/api/view") return new Response("nf", { status: 404 });
    if (url.searchParams.get("filename") !== "a.png") return new Response("nf", { status: 404 });
    // no Range handling — 200 with the full body
    return new Response(png, { headers: { "Content-Type": "image/png" } });
  });
  const addr = `127.0.0.1:${server.addr.port}`;
  const { store, ingest } = await mk(dir, { c: addr });

  const r = await ingest.dims("c", "a.png");
  assertEquals(r.status, 200);
  assertEquals(r.dims, imageDims(png));
  assertEquals(store.entryDims("c", "a.png"), imageDims(png));

  await server.shutdown();
  await rm(dir, { recursive: true });
});

Deno.test("dims: JPEG and WebP yield dims from a folder head read", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-dims-folder-"));
  const imgDir = join(dir, "imgs");
  await mkdir(imgDir, { recursive: true });
  await writeFile(join(imgDir, "x.jpg"), jpegBytes(320, 200));
  await writeFile(join(imgDir, "y.webp"), webpBytes(160, 90));
  const { store, ingest } = await mk(dir, { f: `folder:${imgDir}` });

  assertEquals((await ingest.dims("f", "x.jpg")).dims, { width: 320, height: 200 });
  assertEquals((await ingest.dims("f", "y.webp")).dims, { width: 160, height: 90 });
  assertEquals(store.entryDims("f", "x.jpg"), { width: 320, height: 200 });
  assertEquals(store.entryDims("f", "y.webp"), { width: 160, height: 90 });

  await rm(dir, { recursive: true });
});

Deno.test("dims: a head that yields nothing falls to the full ingest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-dims-deep-"));
  const jpeg = deepSofJpegBytes(640, 480);
  const { state, server, addr } = rangeComfy({ "deep.jpg": jpeg });
  const { store, ingest } = await mk(dir, { c: addr });

  // the 64 KB head cuts before the SOF — no dims, nothing stored
  const r = await ingest.dims("c", "deep.jpg");
  assertEquals(r.dims, null);
  assertEquals(store.entryDims("c", "deep.jpg"), null);
  assertEquals(state.reads[0].served, 65536);

  // pass 2 derives the dims from the full bytes and the entry follows
  await ingest.ingest("c", "deep.jpg", "output", { bytes: jpeg });
  assertEquals(store.entryDims("c", "deep.jpg"), { width: 640, height: 480 });

  await server.shutdown();
  await rm(dir, { recursive: true });
});
