// tests/t_revalidate.mjs — stale-while-revalidate for every host kind:
// the stamp seam, changed-file remap, touch-only stamp, legacy-meta drop on
// change, the debounce (and its input/output key separation), a ComfyUI
// stub-server remap over HTTP, and the input-cache branch.

import { assert, assertEquals, assertExists } from "jsr:@std/assert";
import { hostStamp } from "../src/hosts.mjs";
import { cacheGet } from "../src/cache.mjs";
import { Ingest } from "../src/ingest.mjs";
import { Settings } from "../src/settings.mjs";
import { Store } from "../src/store.mjs";
import { makeRouter } from "../src/routes.mjs";
import { scheduleRevalidate, revalidateNow, __resetRevalidateClocks } from "../src/revalidate.mjs";
import { mkdtemp, rm, writeFile, mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Keep the debounce out of the direct-check tests; scheduleRevalidate tests
// manage their own clock via __resetRevalidateClocks.
Deno.env.set("KOZMOZOO_REVALIDATE_MS", "3600000");

async function rig(name) {
  const dir = await mkdtemp(join(tmpdir(), `kz-rev-${name}-`));
  Deno.env.set("KOZMOZOO_CACHE", join(dir, "cache"));
  const folder = join(dir, "images");
  await mkdir(folder);
  const settings = await Settings.open(dir);
  const store = await Store.open(dir, join(dir, "fb.json"));
  const hosts = { h: `folder:${folder}` };
  const ingest = new Ingest(store, hosts);
  const router = makeRouter({ hosts, store, settings, plugins: null, ingest });
  router.ctx = { hosts, store, settings, plugins: null, ingest };
  return { dir, folder, store, ingest, router, hosts };
}

const bytesRoute = (router) =>
  router.handle(new Request("http://x/api/images/h:img.png/bytes"));

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

Deno.test("hostStamp: folder reports the mtime string; guards hold", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-rev-seam-"));
  await writeFile(join(dir, "a.png"), "x");
  const m = await hostStamp(`folder:${dir}`, "a.png");
  assertExists(m);
  assert(typeof m === "string" && Number(m) > 0);
  assertEquals(await hostStamp(`folder:${dir}`, "../a.png"), null); // guard
  assertEquals(await hostStamp(`folder:${dir}`, "gone.png"), null);
  await rm(dir, { recursive: true });
});

Deno.test("hostStamp: ComfyUI reports the upstream ETag; unreachable reports null", async () => {
  const stub = comfyStub({ etag: '"abc-def"', body: "x" });
  assertEquals(await hostStamp(stub.addr, "a.png"), '"abc-def"');
  await stub.server.shutdown();
  assertEquals(await hostStamp("127.0.0.1:1", "a.png"), null); // no throw
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
  const { dir, folder, store, ingest, router } = await rig("noop");
  await writeFile(join(folder, "img.png"), "v1 bytes");
  await ingest.ensure("h", "img.png");
  const before = store.fileInfo("h", "img.png");

  await revalidateNow(router.ctx, "h", "img.png");

  const after = store.fileInfo("h", "img.png");
  assertEquals(after.hash, before.hash);
  assertEquals(after.stamp, before.stamp);
  await rm(dir, { recursive: true });
});

// --- changed: remap, old content keeps its cache entry ------------------------

Deno.test("changed file: remaps to the new hash; old bytes stay cached", async () => {
  const { dir, folder, store, ingest, router } = await rig("changed");
  await writeFile(join(folder, "img.png"), "v1 bytes");
  await ingest.ensure("h", "img.png");
  const v1 = store.fileInfo("h", "img.png");

  // rewrite in place with a clearly newer mtime
  await writeFile(join(folder, "img.png"), "v2 bytes — changed content");
  const future = new Date(Date.now() + 5000);
  await utimes(join(folder, "img.png"), future, future);

  await revalidateNow(router.ctx, "h", "img.png");

  const v2 = store.fileInfo("h", "img.png");
  assert(v2.hash !== v1.hash, "hash must change with content");
  assertEquals(v2.stamp, String(future.getTime()));
  // both contents remain in the content-addressed cache
  assertExists(await cacheGet(v1.hash));
  assertExists(await cacheGet(v2.hash));
  // the bytes route now serves the new content
  const r = await bytesRoute(router);
  assertEquals(new TextDecoder().decode(await r.arrayBuffer()), "v2 bytes — changed content");
  await rm(dir, { recursive: true });
});

// --- touch only: same content, newer stamp ------------------------------------

Deno.test("touched file (same content): stamp refreshes, hash holds", async () => {
  const { dir, folder, store, ingest, router } = await rig("touch");
  await writeFile(join(folder, "img.png"), "stable bytes");
  await ingest.ensure("h", "img.png");
  const before = store.fileInfo("h", "img.png");

  const future = new Date(Date.now() + 9000);
  await utimes(join(folder, "img.png"), future, future);
  await revalidateNow(router.ctx, "h", "img.png");

  const after = store.fileInfo("h", "img.png");
  assertEquals(after.hash, before.hash);
  assertEquals(after.stamp, String(future.getTime()));
  await rm(dir, { recursive: true });
});

// --- legacy meta must not ride onto changed content ---------------------------

Deno.test("changed re-ingest drops legacy metadata (belongs to old bytes)", async () => {
  const { dir, folder, store, ingest, router } = await rig("legacy");
  await writeFile(join(folder, "img.png"), "v1 bytes");
  await ingest.ensure("h", "img.png");

  // A legacy-table row: metaPut writes to the metadata table while the file
  // has no hash. First ingestion moves it onto the hash; a later CHANGE must
  // drop it, not carry old-bytes meta onto the new hash.
  await writeFile(join(folder, "legacy.png"), "legacy v1");
  await store.metaPut("h", "legacy.png", { seed: 111 }, { ext: 1 });
  assertEquals(store.metaGet("h", "legacy.png").seed, 111);
  await ingest.ensure("h", "legacy.png");
  await writeFile(join(folder, "legacy.png"), "legacy v2 — different");
  const future = new Date(Date.now() + 7000);
  await utimes(join(folder, "legacy.png"), future, future);
  await revalidateNow(router.ctx, "h", "legacy.png");

  // new hash has no meta, and the legacy row must not leak through metaGet
  assertEquals(store.metaGet("h", "legacy.png"), null);
  await rm(dir, { recursive: true });
});

// --- the route schedules revalidation (stale-while-revalidate) ----------------

Deno.test("bytes route: serves cache, then the next request after a change is fresh", async () => {
  const { dir, folder, store, router } = await rig("route");
  __resetRevalidateClocks();
  Deno.env.set("KOZMOZOO_REVALIDATE_MS", "1"); // schedule on every request

  await writeFile(join(folder, "img.png"), "route v1");
  const r1 = await bytesRoute(router);
  assertEquals(new TextDecoder().decode(await r1.arrayBuffer()), "route v1");

  // change in place; the debounce (1ms) lets the next request re-check
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

  Deno.env.set("KOZMOZOO_REVALIDATE_MS", "3600000");
  await rm(dir, { recursive: true });
});

// --- debounce: one check per window -------------------------------------------

Deno.test("debounce: a second change inside the window is not re-checked", async () => {
  const { dir, folder, store, ingest, router } = await rig("debounce");
  __resetRevalidateClocks();
  Deno.env.set("KOZMOZOO_REVALIDATE_MS", "3600000"); // one check per hour

  await writeFile(join(folder, "img.png"), "d v1");
  await ingest.ensure("h", "img.png");

  // change + first scheduled check → remaps to v2
  await writeFile(join(folder, "img.png"), "d v2");
  let future = new Date(Date.now() + 5000);
  await utimes(join(folder, "img.png"), future, future);
  scheduleRevalidate(router.ctx, "h", "img.png");
  await new Promise((r) => setTimeout(r, 150));
  const v2 = store.fileInfo("h", "img.png");
  const r2 = await bytesRoute(router);
  assertEquals(new TextDecoder().decode(await r2.arrayBuffer()), "d v2");

  // change again INSIDE the window → the check must be skipped (still v2)
  await writeFile(join(folder, "img.png"), "d v3");
  future = new Date(Date.now() + 9000);
  await utimes(join(folder, "img.png"), future, future);
  scheduleRevalidate(router.ctx, "h", "img.png");
  await new Promise((r) => setTimeout(r, 150));
  assertEquals(store.fileInfo("h", "img.png").hash, v2.hash);
  const r3 = await bytesRoute(router);
  assertEquals(new TextDecoder().decode(await r3.arrayBuffer()), "d v2");

  __resetRevalidateClocks();
  await rm(dir, { recursive: true });
});

// --- unreachable host: quiet no-op, the row is kept ----------------------------

Deno.test("unreachable host: stamp check fails quietly, the row is kept", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-rev-down-"));
  const settings = await Settings.open(dir);
  const store = await Store.open(dir, join(dir, "fb.json"));
  const hosts = { c: "127.0.0.1:1" }; // comfy-style, unreachable
  await store.ingestFile("c", "img.png", "deadbeef", 3, { stamp: "s1" });
  const router = makeRouter({ hosts, store, settings, plugins: null });
  router.ctx = { hosts, store, settings, plugins: null };
  // fires real I/O now (no durability gate) — connection refused must be a
  // quiet no-op, and the recorded row must survive
  scheduleRevalidate(router.ctx, "c", "img.png");
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
  await revalidateNow(router.ctx, "c", "img.png");

  const v2 = store.fileInfo("c", "img.png");
  assert(v2.hash !== v1.hash, "hash must change with content");
  assertEquals(v2.stamp, '"e2"');
  const r = await router.handle(new Request("http://x/api/images/c:img.png/bytes"));
  assertEquals(new TextDecoder().decode(await r.arrayBuffer()), "comfy v2 — rewritten");

  await stub.server.shutdown();
  await rm(dir, { recursive: true });
});

// --- the input-cache branch ------------------------------------------------------

Deno.test("input branch: a changed folder file updates the input row", async () => {
  const { dir, folder, store, router } = await rig("input");
  await writeFile(join(folder, "in.png"), "input v1");
  const fill = await router.handle(new Request("http://x/api/input-bytes/h/in.png"));
  assertEquals(new TextDecoder().decode(await fill.arrayBuffer()), "input v1");
  const v1 = store.inputCacheGet("h", "in.png");
  assertExists(v1.stamp);

  await writeFile(join(folder, "in.png"), "input v2 — new bytes");
  const future = new Date(Date.now() + 4000);
  await utimes(join(folder, "in.png"), future, future);

  // the route catches folder changes inline; drive the revalidate branch here
  await revalidateNow(router.ctx, "h", "in.png", { input: true });
  const v2 = store.inputCacheGet("h", "in.png");
  assert(v2.hash !== v1.hash, "input row must remap to the new content");
  assertEquals(v2.stamp, String(future.getTime()));
  assertExists(await cacheGet(v2.hash));
  await rm(dir, { recursive: true });
});

// --- debounce keys: input and output checks are independent -----------------------

Deno.test("debounce keys: input and output checks do not suppress each other", async () => {
  const { dir, folder, store, ingest, router } = await rig("keysep");
  __resetRevalidateClocks();
  Deno.env.set("KOZMOZOO_REVALIDATE_MS", "3600000");

  await writeFile(join(folder, "img.png"), "sep v1");
  await ingest.ensure("h", "img.png");
  await writeFile(join(folder, "img.png"), "sep v2");
  const future = new Date(Date.now() + 5000);
  await utimes(join(folder, "img.png"), future, future);

  // the input check consumes only the "in:" key (no input row → no row created)
  scheduleRevalidate(router.ctx, "h", "img.png", { input: true });
  await new Promise((r) => setTimeout(r, 100));
  assertEquals(store.inputCacheGet("h", "img.png"), null);

  // the output check must still fire for the same host:filename
  scheduleRevalidate(router.ctx, "h", "img.png");
  await new Promise((r) => setTimeout(r, 150));
  const r2 = await bytesRoute(router);
  assertEquals(new TextDecoder().decode(await r2.arrayBuffer()), "sep v2");

  __resetRevalidateClocks();
  await rm(dir, { recursive: true });
});
