// tests/t_ingest_dims.mjs — the §4.2 dims pass: Ingest.dims parses width/
// height from a 64 KB head read — no hash, no cache write, no extract. A
// head that yields nothing leaves the dims null (the full ingest is the
// pass-2 fallback). A server that ignores Range gets the full-read fallback
// (200-without-206). Known dims short-circuit the backing read.

import { assert, assertEquals } from "jsr:@std/assert";
import { Ingest } from "../src/ingest.mjs";
import { Cache, sha256 } from "../src/cache.mjs";
import { Store } from "../src/store.mjs";
import { imageDims } from "../src/extractor.mjs";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkStateRig } from "./helpers/rig.mjs";
import { testPng } from "./helpers/png.mjs";
import { Database } from "@db/sqlite";

const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
const roots = ["input", "temp", "output"];
const putHash = (store, kind, hash) => kind === "output" ? store.ingestFile("c", "same.png", hash, 100)
  : store.resourceCachePut("c", "same.png", kind, hash, null, 100);

function assertProjections(store, dims) {
  assertEquals(store.entryDims("c", "same.png"), dims);
  for (const row of [store.entryJoined("c", "same.png"), store.entriesForCollection("c")[0]]) {
    assertEquals([row.width, row.height], [dims?.width ?? null, dims?.height ?? null]);
  }
  assertEquals(store.dimsKnown("c").has("same.png"), !!dims);
  assertEquals(store.dimsForHost("c"), dims ? { "same.png": dims } : {});
  assertEquals(store.metadataFor("c", ["same.png"]).dims, dims ? { "same.png": dims } : {});
  assertEquals(store.metadataSince("c").dims, dims ? { "same.png": dims } : {});
}

for (const kind of roots) for (const readable of [true, false]) Deno.test(`dims: late ${kind} head follows full ingestion (${readable})`, async () => {
  const r = await mkStateRig("late-head", { hosts: { c: "example:1" } });
  const entered = deferred(), release = deferred(), old = testPng(30, 20);
  const ingest = new Ingest(r.store, r.hosts, { cache: r.cache, backingFor: () => ({ read: () => {
    entered.resolve(); return { status: 206, body: new ReadableStream({ async start(controller) {
      await release.promise; controller.enqueue(old); controller.close();
    } }) };
  } }) });
  try {
    const pending = ingest.dims("c", "same.png", kind);
    await entered.promise;
    const next = readable ? testPng(70, 50) : new Uint8Array([1, 2, 3]);
    await ingest.ensureBytes("c", "same.png", next, { kind });
    release.resolve();
    const dims = readable ? { width: 70, height: 50 } : null;
    assertEquals((await pending).dims, dims, "retired head result cannot escape to its caller");
    assertEquals(r.store.entryDims("c", "same.png", kind), dims);
    if (kind === "output") assertProjections(r.store, dims);
  } finally { release.resolve(); await r.close(); }
});

for (const kind of roots) for (const readable of [true, false, null]) Deno.test(`dims: ${kind} hashed gap reads only its exact cache (${readable})`, async () => {
  const r = await mkStateRig("hash-gap", { hosts: { c: "example:1" } });
  const bytes = readable ? testPng(30, 20) : new Uint8Array([1, 2, 3]), hash = await sha256(bytes);
  let reads = 0;
  const ingest = new Ingest(r.store, r.hosts, { cache: r.cache, backingFor: () => ({ read: () => {
    reads++; return { status: 206, body: testPng(70, 50) };
  } }) });
  try {
    if (readable !== null) await r.cache.put(hash, bytes);
    await putHash(r.store, kind, hash);
    const dims = readable ? { width: 30, height: 20 } : null;
    assertEquals((await ingest.dims("c", "same.png", kind)).dims, dims);
    assertEquals(reads, 0, "today's name cannot fill an older hash's facts");
    assertEquals(r.store.entryGet("c", "same.png", kind).hash, hash);
    assertEquals(r.store.entryDims("c", "same.png", kind), dims);
    if (kind === "output") assertProjections(r.store, dims);
  } finally { await r.close(); }
});

for (const kind of roots) for (const phase of ["head", "full", "cache-put"]) Deno.test(`dims: ${kind} ${phase} completion cannot publish after same-source retirement`, async () => {
  const hosts = { c: "example:1", alias: "example:1" }, r = await mkStateRig("dims-retirement", { hosts });
  const bytes = testPng(30, 20), entered = deferred(), release = deferred();
  const ingest = new Ingest(r.store, hosts, {
    capture: r.inventory.capture, isCurrent: r.inventory.isCurrent,
    cache: { async put(hash, value) { entered.resolve(); await release.promise; await r.cache.put(hash, value); } },
    backingFor: () => ({ async read() { entered.resolve(); await release.promise; return { status: phase === "head" ? 206 : 200, body: bytes }; },
      stat: () => ({ stamp: "same" }) }),
  });
  try {
    const pending = phase === "head" ? ingest.dims("c", "same.png", kind)
      : phase === "full" ? ingest.ensure("c", "same.png", kind)
      : ingest.ensureBytes("c", "same.png", bytes, { kind }).catch(error => ({ cancelled: error.code === "cancelled" }));
    await entered.promise;
    delete hosts.c; r.inventory.reconcile(); hosts.c = "example:1"; r.inventory.reconcile();
    r.store.collectionAdd("c", hosts.c);
    const version = r.store.metaVersion;
    release.resolve();
    const result = await pending;
    assertEquals(result.cancelled, true);
    assertEquals(r.store.entryGet("c", "same.png", kind), null);
    assertEquals(r.store.contentGet(await sha256(bytes)), null);
    assertEquals(r.store.metaVersion, version);
  } finally { release.resolve(); await r.close(); }
});

Deno.test("dims: all Store projections ignore legacy hash-bound entry geometry", async () => {
  const r = await mkStateRig("legacy-dims", { hosts: {} });
  try {
    await putHash(r.store, "output", "a".repeat(64));
    const db = new Database(join(r.dir, "metadata.db"));
    try { db.exec("UPDATE entry SET width=30, height=20 WHERE name='same.png'"); } finally { db.close(); }
    assertProjections(r.store, null);
  } finally { await r.close(); }
});

for (const kind of roots) for (const effect of ["retire", "remap"]) Deno.test(`dims: delayed ${kind} cache recovery fences ${effect}`, async () => {
  const hosts = { c: "example:1", alias: "example:1" }, r = await mkStateRig("gap-fence", { hosts });
  const bytes = testPng(30, 20), hash = await sha256(bytes), entered = deferred(), release = deferred();
  const ingest = new Ingest(r.store, hosts, { cache: { async get() { entered.resolve(); await release.promise; return bytes; } },
    capture: r.inventory.capture, isCurrent: r.inventory.isCurrent,
    backingFor: () => ({ async read() { entered.resolve(); await release.promise; return { status: 206, body: bytes }; } }) });
  try {
    await putHash(r.store, kind, hash);
    const pending = ingest.dims("c", "same.png", kind); await entered.promise;
    if (effect === "retire") {
      delete hosts.c; r.inventory.reconcile(); hosts.c = "example:1"; r.inventory.reconcile();
      r.store.collectionRemove("c"); r.store.collectionAdd("c", hosts.c);
    } else await putHash(r.store, kind, "b".repeat(64));
    const version = r.store.metaVersion;
    release.resolve(); const result = await pending;
    assertEquals(result.dims, null);
    if (effect === "retire") assertEquals(result.status, 499);
    assertEquals(r.store.contentGet(hash)?.width ?? null, null, "retired evidence is not published");
    assertEquals(r.store.metaVersion, version);
    assertEquals(r.store.entryDims("c", "same.png", kind), null);
  } finally { release.resolve(); await r.close(); }
});

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
Deno.test("source incarnation: late dimensions cannot attach to a replacement collection kept alive by an alias", async () => {
  const { mkStateRig } = await import("./helpers/rig.mjs");
  const { assertEquals } = await import("jsr:@std/assert");
  const png = await Deno.readFile(new URL("./fixtures/flux-basic.png", import.meta.url));
  let release, started = false;
  const gate = new Promise((resolve) => release = resolve);
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1" }, async () => {
    started = true; await gate; return new Response(png.subarray(0, 64), { status: 206 });
  });
  const address = `127.0.0.1:${server.addr.port}`, hosts = { h: address, alias: address };
  const rig = await mkStateRig("incarnation-dims", { hosts });
  rig.inventory.binding(address);
  try {
    const old = rig.ingest.dims("h", "image.png");
    for (let i = 0; i < 100 && !started; i++) await new Promise((r) => setTimeout(r, 1));
    delete hosts.h; rig.inventory.reconcile(); hosts.h = address; rig.inventory.reconcile();
    rig.store.collectionAdd("h", address); release();
    assertEquals((await old).status, 499);
    assertEquals(rig.store.entryDims("h", "image.png"), null);
  } finally { release(); await server.shutdown(); await rig.close(); }
});
