// tests/t_revalidate.mjs — stale-while-revalidate for every host kind:
// the stamp seam, changed-file remap, touch-only stamp, meta drop on
// change, the debounce (and its input/output key separation), a ComfyUI
// stub-server remap over HTTP, and the input-cache branch.
//
// Revalidation is an Ingest method: the interval is a constructor option
// and the debounce clock is instance state — no module globals, no env seam.

import { assert, assertEquals, assertExists } from "jsr:@std/assert";
import { backingFor } from "../src/backings/index.mjs";
import { cacheGet } from "../src/cache.mjs";
import { Ingest } from "../src/ingest.mjs";
import { Settings } from "../src/settings.mjs";
import { Store } from "../src/store.mjs";
import { makeRouter } from "../src/routes.mjs";
import { mkdtemp, rm, writeFile, mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Direct-check tests get a huge interval so the debounce never fires;
// debounce tests pass their own.
async function rig(name, { revalidateMs = 3_600_000 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), `kz-rev-${name}-`));
  Deno.env.set("KOZMOZOO_CACHE", join(dir, "cache"));
  const folder = join(dir, "images");
  await mkdir(folder);
  const settings = await Settings.open(dir);
  const store = await Store.open(dir, join(dir, "fb.json"));
  const hosts = { h: `folder:${folder}` };
  const ingest = new Ingest(store, hosts, { revalidateMs });
  const router = makeRouter({ hosts, store, settings, plugins: null, ingest });
  router.ctx = { hosts, store, settings, plugins: null, ingest };
  return { dir, folder, store, ingest, router, hosts };
}

const bytesRoute = (router) =>
  router.handle(new Request("http://x/api/collections/h/entries/img.png/bytes"));

// A minimal ComfyUI stand-in: /api/view with a caller-controlled ETag and
// body, HEAD handled explicitly (no dependence on serve internals).
function comfyStub(initial) {
  const state = { ...initial };
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen: () => {} }, (req) => {
    const url = new URL(req.url);
    if (url.pathname !== "/api/view") return new Response("nope", { status: 404 });
    const headers = {
      ETag: state.etag,
      "Content-Type": "image/png",
      "Content-Length": String(state.body.length),
    };
    return req.method === "HEAD"
      ? new Response(null, { headers })
      : new Response(state.body, { headers });
  });
  return { state, server, addr: `127.0.0.1:${server.addr.port}` };
}

// --- the stamp seam -----------------------------------------------------------

Deno.test("backing stat: folder reports the mtime string; guards hold", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-rev-seam-"));
  await writeFile(join(dir, "a.png"), "x");
  const addr = `folder:${dir}`;
  const m = await backingFor(addr).stat(addr, "a.png");
  assertExists(m);
  assert(typeof m.stamp === "string" && Number(m.stamp) > 0);
  assertEquals(await backingFor(addr).stat(addr, "../a.png"), null); // guard
  assertEquals(await backingFor(addr).stat(addr, "gone.png"), null);
  await rm(dir, { recursive: true });
});

Deno.test("backing stat: ComfyUI reports the upstream ETag; unreachable reports null", async () => {
  const stub = comfyStub({ etag: '"abc-def"', body: "x" });
  assertEquals((await backingFor(stub.addr).stat(stub.addr, "a.png")).stamp, '"abc-def"');
  await stub.server.shutdown();
  assertEquals(await backingFor("127.0.0.1:1").stat("127.0.0.1:1", "a.png"), null); // no throw
});

// --- ingestion records the stamp ----------------------------------------------

Deno.test("ingestion records the source stamp", async () => {
  const { dir, folder, store, ingest } = await rig("record");
  await writeFile(join(folder, "img.png"), "v1 bytes");
  await ingest.ensure("h", "img.png");
  const info = store.fileInfo("h", "img.png");
  assertExists(info.hash);
  assertExists(info.stamp);
  await rm(dir, { recursive: true });
});

// --- unchanged: no remap ------------------------------------------------------

Deno.test("unchanged file: revalidation is a no-op", async () => {
  const { dir, folder, store, ingest } = await rig("noop");
  await writeFile(join(folder, "img.png"), "v1 bytes");
  await ingest.ensure("h", "img.png");
  const before = store.fileInfo("h", "img.png");

  await ingest.revalidateNow("h", "img.png");

  const after = store.fileInfo("h", "img.png");
  assertEquals(after.hash, before.hash);
  assertEquals(after.stamp, before.stamp);
  await rm(dir, { recursive: true });
});

// --- changed file: remap to the new hash --------------------------------------

Deno.test("changed file: remaps to the new hash; old bytes stay cached", async () => {
  const { dir, folder, store, ingest } = await rig("changed");
  await writeFile(join(folder, "img.png"), "c v1");
  await ingest.ensure("h", "img.png");
  const before = store.fileInfo("h", "img.png");

  await writeFile(join(folder, "img.png"), "c v2 — different bytes");
  const future = new Date(Date.now() + 5000);
  await utimes(join(folder, "img.png"), future, future);
  await ingest.revalidateNow("h", "img.png");

  const after = store.fileInfo("h", "img.png");
  assert(after.hash !== before.hash, "hash must change with content");
  assertEquals(after.stamp, String(future.getTime()));
  // old bytes are still in the cache (immutable, hash-addressed)
  assertExists(await cacheGet(before.hash));
  assertExists(await cacheGet(after.hash));
  await rm(dir, { recursive: true });
});

// --- touched file (same content): stamp only ----------------------------------

Deno.test("touched file (same content): stamp refreshes, hash holds", async () => {
  const { dir, folder, store, ingest } = await rig("touch");
  await writeFile(join(folder, "img.png"), "same bytes");
  await ingest.ensure("h", "img.png");
  const before = store.fileInfo("h", "img.png");

  const future = new Date(Date.now() + 9000);
  await utimes(join(folder, "img.png"), future, future);
  await ingest.revalidateNow("h", "img.png");

  const after = store.fileInfo("h", "img.png");
  assertEquals(after.hash, before.hash);
  assertEquals(after.stamp, String(future.getTime()));
  await rm(dir, { recursive: true });
});

// --- meta must not ride onto changed content ------------------------------------

Deno.test("changed re-ingest drops legacy metadata (belongs to old bytes)", async () => {
  const { dir, folder, store, ingest } = await rig("legacy");
  await writeFile(join(folder, "img.png"), "v1 bytes");
  await ingest.ensure("h", "img.png");

  // Meta lives on content (hash): a later CHANGE remaps the entry to a new
  // hash whose content row carries no meta — old-bytes meta must not leak.
  await writeFile(join(folder, "legacy.png"), "legacy v1");
  await ingest.ensure("h", "legacy.png");
  await store.metaPut("h", "legacy.png", { seed: 111 }, { ext: 1 });
  assertEquals(store.metaGet("h", "legacy.png").seed, 111);
  await writeFile(join(folder, "legacy.png"), "legacy v2 — different");
  const future = new Date(Date.now() + 7000);
  await utimes(join(folder, "legacy.png"), future, future);
  await ingest.revalidateNow("h", "legacy.png");

  // new hash has no meta
  assertEquals(store.metaGet("h", "legacy.png"), null);
  await rm(dir, { recursive: true });
});

// --- the route schedules revalidation (stale-while-revalidate) ----------------

Deno.test("bytes route: serves cache, then the next request after a change is fresh", async () => {
  const { dir, folder, store, router } = await rig("route", { revalidateMs: 1 }); // schedule on every request

  await writeFile(join(folder, "img.png"), "route v1");
  const r1 = await bytesRoute(router);
  assertEquals(new TextDecoder().decode(await r1.arrayBuffer()), "route v1");

  // change in place; the tiny debounce lets the next request re-check
  await writeFile(join(folder, "img.png"), "route v2");
  const future = new Date(Date.now() + 6000);
  await utimes(join(folder, "img.png"), future, future);

  // request 2: the check runs async; allow it to land
  await bytesRoute(router);
  await new Promise((r) => setTimeout(r, 150));
  assertEquals(store.fileInfo("h", "img.png").stamp, String(future.getTime()));

  // request 3: fresh bytes
  const r3 = await bytesRoute(router);
  assertEquals(new TextDecoder().decode(await r3.arrayBuffer()), "route v2");

  await rm(dir, { recursive: true });
});

// --- debounce: one check per window -------------------------------------------

Deno.test("debounce: a second change inside the window is not re-checked", async () => {
  const { dir, folder, store, ingest, router } = await rig("debounce");

  await writeFile(join(folder, "img.png"), "d v1");
  await ingest.ensure("h", "img.png");

  // change + first scheduled check → remaps to v2
  await writeFile(join(folder, "img.png"), "d v2");
  let future = new Date(Date.now() + 5000);
  await utimes(join(folder, "img.png"), future, future);
  ingest.scheduleRevalidate("h", "img.png");
  await new Promise((r) => setTimeout(r, 150));
  const v2 = store.fileInfo("h", "img.png");
  const r2 = await bytesRoute(router);
  assertEquals(new TextDecoder().decode(await r2.arrayBuffer()), "d v2");

  // change again INSIDE the window → the check must be skipped (still v2)
  await writeFile(join(folder, "img.png"), "d v3");
  future = new Date(Date.now() + 9000);
  await utimes(join(folder, "img.png"), future, future);
  ingest.scheduleRevalidate("h", "img.png");
  await new Promise((r) => setTimeout(r, 150));
  assertEquals(store.fileInfo("h", "img.png").hash, v2.hash);
  const r3 = await bytesRoute(router);
  assertEquals(new TextDecoder().decode(await r3.arrayBuffer()), "d v2");

  await rm(dir, { recursive: true });
});

// --- unreachable host: quiet no-op, the row is kept ----------------------------

Deno.test("unreachable host: stamp check fails quietly, the row is kept", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-rev-down-"));
  const settings = await Settings.open(dir);
  const store = await Store.open(dir, join(dir, "fb.json"));
  const hosts = { c: "127.0.0.1:1" }; // comfy-style, unreachable
  await store.ingestFile("c", "img.png", "deadbeef", 3, { stamp: "s1" });
  const ingest = new Ingest(store, hosts);
  // connection refused must be a quiet no-op, and the recorded row survives
  ingest.scheduleRevalidate("c", "img.png");
  await new Promise((r) => setTimeout(r, 150));
  assertEquals(store.fileInfo("c", "img.png").stamp, "s1");
  await rm(dir, { recursive: true });
});

// --- ComfyUI over HTTP: changed ETag remaps the same filename -------------------

Deno.test("comfy host: a changed ETag remaps the same filename to new content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-rev-comfy-"));
  Deno.env.set("KOZMOZOO_CACHE", join(dir, "cache"));
  const stub = comfyStub({ etag: '"e1"', body: "comfy v1" });
  const settings = await Settings.open(dir);
  const store = await Store.open(dir, join(dir, "fb.json"));
  const hosts = { c: stub.addr };
  const ingest = new Ingest(store, hosts);
  const router = makeRouter({ hosts, store, settings, plugins: null, ingest });
  router.ctx = { hosts, store, settings, plugins: null, ingest };

  await ingest.ensure("c", "img.png");
  const v1 = store.fileInfo("c", "img.png");
  assertEquals(v1.stamp, '"e1"');

  // same filename, new bytes → new ETag
  stub.state.etag = '"e2"';
  stub.state.body = "comfy v2 — rewritten";
  await ingest.revalidateNow("c", "img.png");

  const v2 = store.fileInfo("c", "img.png");
  assert(v2.hash !== v1.hash, "hash must change with content");
  assertEquals(v2.stamp, '"e2"');
  const r = await router.handle(new Request("http://x/api/collections/c/entries/img.png/bytes"));
  assertEquals(new TextDecoder().decode(await r.arrayBuffer()), "comfy v2 — rewritten");

  await stub.server.shutdown();
  await rm(dir, { recursive: true });
});

// --- the input-cache branch ------------------------------------------------------

Deno.test("input branch: a changed folder file updates the input row", async () => {
  const { dir, folder, store, ingest, router } = await rig("input");
  await writeFile(join(folder, "in.png"), "input v1");
  const fill = await router.handle(new Request("http://x/api/collections/h/entries/in.png/bytes?kind=input"));
  assertEquals(new TextDecoder().decode(await fill.arrayBuffer()), "input v1");
  const v1 = store.inputCacheGet("h", "in.png");
  assertExists(v1.stamp);

  await writeFile(join(folder, "in.png"), "input v2 — new bytes");
  const future = new Date(Date.now() + 4000);
  await utimes(join(folder, "in.png"), future, future);

  // the route catches folder changes inline; drive the revalidate branch here
  await ingest.revalidateNow("h", "in.png", { input: true });
  const v2 = store.inputCacheGet("h", "in.png");
  assert(v2.hash !== v1.hash, "input row must remap to the new content");
  assertEquals(v2.stamp, String(future.getTime()));
  assertExists(await cacheGet(v2.hash));
  await rm(dir, { recursive: true });
});

// --- debounce keys: input and output checks are independent -----------------------

Deno.test("debounce keys: input and output checks do not suppress each other", async () => {
  const { dir, folder, store, ingest, router } = await rig("keysep");

  await writeFile(join(folder, "img.png"), "sep v1");
  await ingest.ensure("h", "img.png");
  await writeFile(join(folder, "img.png"), "sep v2");
  const future = new Date(Date.now() + 5000);
  await utimes(join(folder, "img.png"), future, future);

  // the input check consumes only the "in:" key (no input row → no row created)
  ingest.scheduleRevalidate("h", "img.png", { input: true });
  await new Promise((r) => setTimeout(r, 100));
  assertEquals(store.inputCacheGet("h", "img.png"), null);

  // the output check must still fire for the same host:filename
  ingest.scheduleRevalidate("h", "img.png");
  await new Promise((r) => setTimeout(r, 150));
  const r2 = await bytesRoute(router);
  assertEquals(new TextDecoder().decode(await r2.arrayBuffer()), "sep v2");

  await rm(dir, { recursive: true });
});
