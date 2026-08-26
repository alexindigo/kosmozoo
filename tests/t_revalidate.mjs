// tests/t_revalidate.mjs — stale-while-revalidate for non-durable remotes:
// durability flag, mtime seam, changed-file remap, touch-only stamp,
// legacy-meta drop on change, and the debounce.

import { assert, assertEquals, assertExists, assertFalse } from "jsr:@std/assert";
import { hostDurable, hostModified } from "../src/hosts.mjs";
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

// --- the flag and the seam ---------------------------------------------------

Deno.test("durability flag: folder remotes revalidate, ComfyUI is durable", () => {
  assertFalse(hostDurable("folder:/tmp/x"));
  assert(hostDurable("comfyui.home:8188"));
  assert(hostDurable("127.0.0.1:8188"));
});

Deno.test("hostModified: folder reports mtime, durable kinds report null", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-rev-seam-"));
  await writeFile(join(dir, "a.png"), "x");
  const m = await hostModified(`folder:${dir}`, "a.png");
  assertExists(m);
  assert(typeof m === "number" && m > 0);
  assertEquals(await hostModified("127.0.0.1:8188", "a.png"), null);
  assertEquals(await hostModified(`folder:${dir}`, "../a.png"), null); // guard
  assertEquals(await hostModified(`folder:${dir}`, "gone.png"), null);
  await rm(dir, { recursive: true });
});

// --- ingestion records mtime --------------------------------------------------

Deno.test("ingestion records the source mtime", async () => {
  const { dir, folder, store, ingest } = await rig("record");
  await writeFile(join(folder, "img.png"), "v1 bytes");
  await ingest.ensure("h", "img.png");
  const info = store.fileInfo("h", "img.png");
  assertExists(info.hash);
  assertExists(info.mtime);
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
  assertEquals(after.mtime, before.mtime);
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
  assertEquals(v2.mtime, future.getTime());
  // both contents remain in the content-addressed cache
  assertExists(await cacheGet(v1.hash));
  assertExists(await cacheGet(v2.hash));
  // the bytes route now serves the new content
  const r = await bytesRoute(router);
  assertEquals(new TextDecoder().decode(await r.arrayBuffer()), "v2 bytes — changed content");
  await rm(dir, { recursive: true });
});

// --- touch only: same content, newer mtime ------------------------------------

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
  assertEquals(after.mtime, future.getTime());
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
  assertEquals(store.fileInfo("h", "img.png").mtime, future.getTime());

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

// --- durable remotes are never scheduled --------------------------------------

Deno.test("durable remote: scheduleRevalidate never checks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-rev-durable-"));
  const settings = await Settings.open(dir);
  const store = await Store.open(dir, join(dir, "fb.json"));
  const hosts = { c: "127.0.0.1:1" }; // comfy-style, durable (and unreachable)
  const router = makeRouter({ hosts, store, settings, plugins: null });
  router.ctx = { hosts, store, settings, plugins: null };
  // would hang/throw if it actually tried to check the unreachable host —
  // the durability flag must short-circuit before any I/O
  scheduleRevalidate(router.ctx, "c", "img.png");
  await new Promise((r) => setTimeout(r, 50));
  assertEquals(store.fileInfo("c", "img.png"), null);
  await rm(dir, { recursive: true });
});
