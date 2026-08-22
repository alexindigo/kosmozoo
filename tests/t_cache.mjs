// tests/t_cache.mjs — cache pipeline integration: sha256, cache store,
// ingestion flow, cache-first serve, hash identity across hosts.

import { assert, assertEquals, assertExists, assertFalse } from "jsr:@std/assert";
import { sha256, cachePut, cacheGet, cachePath } from "../src/cache.mjs";
import { Ingest } from "../src/ingest.mjs";
import { Settings } from "../src/settings.mjs";
import { Store } from "../src/store.mjs";
import { makeRouter } from "../src/routes.mjs";
import { isFolderHost, validateHost } from "../src/hosts.mjs";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- cache basics --------------------------------------------------------

Deno.test("sha256 is deterministic — same bytes, same hash", async () => {
  const bytes = new TextEncoder().encode("kosmozoo");
  const h1 = await sha256(bytes);
  const h2 = await sha256(bytes);
  assertEquals(h1, h2);
  assertEquals(h1.length, 64);
});

Deno.test("sha256 is content-specific — different bytes, different hash", async () => {
  const h1 = await sha256(new TextEncoder().encode("a"));
  const h2 = await sha256(new TextEncoder().encode("b"));
  assertFalse(h1 === h2);
});

Deno.test("cache put + get round-trip with atomic writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-cache-"));
  Deno.env.set("KOZMOZOO_CACHE", dir);
  const bytes = new TextEncoder().encode("test payload");
  const hash = await sha256(bytes);

  await cachePut(hash, bytes);
  const loaded = await cacheGet(hash);
  // Deno node:fs readFile returns a Buffer; compare lengths and content.
  assertEquals(loaded.length, bytes.length);
  assertEquals(new TextDecoder().decode(loaded), new TextDecoder().decode(bytes));

  // Cache path is two-char prefix + hash.
  const path = cachePath(hash);
  assertEquals(path, join(dir, hash.slice(0, 2), `${hash}.png`));

  // Unknown hash returns null, not an error.
  const miss = await cacheGet("f" + "0".repeat(63));
  assertEquals(miss, null);

  await rm(dir, { recursive: true });
});

// --- ingestion pipeline ---------------------------------------------------

Deno.test("ingestion: folder host → sha256 → cache → files table → images table", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-ing-"));
  Deno.env.set("KOZMOZOO_CACHE", join(dir, "cache"));

  // Create a folder with one test PNG.
  const folder = join(dir, "images");
  await mkdir(folder);
  const bytes = new TextEncoder().encode("fake png bytes " + Date.now());
  await writeFile(join(folder, "test.png"), bytes);

  const store = await Store.open(dir, join(dir, "fb.json"));
  const hosts = { fixtures: `folder:${folder}` };
  const ingest = new Ingest(store, hosts);

  // Before ingestion: no hash, no cache.
  assertEquals(store.hashFor("fixtures", "test.png"), null);

  // Ingest.
  const hash = await ingest.ensure("fixtures", "test.png");
  assertExists(hash);
  assertEquals(hash.length, 64);

  // After ingestion: hash recorded in files table.
  assertEquals(store.hashFor("fixtures", "test.png"), hash);

  // Cache file exists.
  const cached = await cacheGet(hash);
  assertEquals(cached.length, bytes.length);

  await rm(dir, { recursive: true });
});

Deno.test("ingestion: same bytes on two hosts → same hash → one identity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-oneid-"));
  Deno.env.set("KOZMOZOO_CACHE", join(dir, "cache"));

  const bytes = new TextEncoder().encode("shared image content");

  const folder1 = join(dir, "host1");
  const folder2 = join(dir, "host2");
  await mkdir(folder1);
  await mkdir(folder2);
  await writeFile(join(folder1, "img.png"), bytes);
  await writeFile(join(folder2, "img.png"), bytes);

  const store = await Store.open(dir, join(dir, "fb.json"));
  const hosts = { host1: `folder:${folder1}`, host2: `folder:${folder2}` };
  const ingest = new Ingest(store, hosts);

  const h1 = await ingest.ensure("host1", "img.png");
  const h2 = await ingest.ensure("host2", "img.png");

  // Same content → same hash.
  assertEquals(h1, h2);

  // Both files rows point to the same hash.
  assertEquals(store.hashFor("host1", "img.png"), h1);
  assertEquals(store.hashFor("host2", "img.png"), h1);

  // Judgment on one host is visible on the other.
  await store.judgmentSet("host1", "img.png", "vote", "up");
  const j = store.judgmentGet("host2", "img.png");
  assertEquals(j.vote, "up");

  await rm(dir, { recursive: true });
});

// --- serve path: cache-first ----------------------------------------------

Deno.test("serve path: cache hit serves directly, no host needed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-svc-"));
  Deno.env.set("KOZMOZOO_CACHE", join(dir, "cache"));

  const bytes = new TextEncoder().encode("served-from-cache");
  const folder = join(dir, "images");
  await mkdir(folder);
  await writeFile(join(folder, "img.png"), bytes);

  const settings = await Settings.open(dir);
  const store = await Store.open(dir, join(dir, "fb.json"));
  const hosts = { host: `folder:${folder}` };
  const ingest = new Ingest(store, hosts);
  const router = makeRouter({ hosts, store, settings, plugins: null, ingest });
  router.ctx = { hosts, store, settings, plugins: null, ingest };

  // First request: ingestion populates cache.
  const r1 = await router.handle(new Request("http://x/api/images/host:img.png/bytes"));
  assertEquals(r1.status, 200);
  const b1 = new Uint8Array(await r1.arrayBuffer());
  assertEquals(b1, bytes);

  // Remove the folder (simulate host offline).
  await rm(folder, { recursive: true });

  // Second request: cache hit, no host needed.
  const r2 = await router.handle(new Request("http://x/api/images/host:img.png/bytes"));
  assertEquals(r2.status, 200);
  const b2 = new Uint8Array(await r2.arrayBuffer());
  assertEquals(b2, bytes);

  await rm(dir, { recursive: true });
});

Deno.test("serve path: round-trip preserves Content-Type", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-ct-"));
  Deno.env.set("KOZMOZOO_CACHE", join(dir, "cache"));

  // Valid PNG header bytes so the extension mapping picks up.
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  const folder = join(dir, "images");
  await mkdir(folder);
  await writeFile(join(folder, "img.png"), png);

  const settings = await Settings.open(dir);
  const store = await Store.open(dir, join(dir, "fb.json"));
  const hosts = { h: `folder:${folder}` };
  const ingest = new Ingest(store, hosts);
  const router = makeRouter({ hosts, store, settings, plugins: null, ingest });
  router.ctx = { hosts, store, settings, plugins: null, ingest };

  const r = await router.handle(new Request("http://x/api/images/h:img.png/bytes"));
  assertEquals(r.status, 200);
  assertEquals(r.headers.get("Content-Type"), "image/png");
  assertExists(r.headers.get("Content-Length"));

  await rm(dir, { recursive: true });
});

// --- judgment migration ---------------------------------------------------

Deno.test("judgment migration: legacy host:filename keys → hash keys", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-jmig-"));
  Deno.env.set("KOZMOZOO_CACHE", join(dir, "cache"));

  const bytes = new TextEncoder().encode("judgment test content");
  const folder = join(dir, "images");
  await mkdir(folder);
  await writeFile(join(folder, "judge.png"), bytes);

  const fbPath = join(dir, "fb.json");
  const store = await Store.open(dir, fbPath);
  const hosts = { h: `folder:${folder}` };
  const ingest = new Ingest(store, hosts);

  // Simulate a pre-migration state: write a judgment under the legacy key
  // before the file is hashed.
  const { readFile } = await import("node:fs/promises");
  await writeFile(fbPath, JSON.stringify({
    version: 1,
    data: { "h:judge.png": { vote: "down", notes: { pos: "old" } } },
  }, null, 2));

  // Ingest the file (gives it a hash).
  const hash = await ingest.ensure("h", "judge.png");
  assertExists(hash);

  // Re-open the store: migration should re-key to hash.
  const store2 = await Store.open(dir, fbPath);
  const j = store2.judgmentGet("h", "judge.png");
  assertEquals(j.vote, "down");
  assertEquals(j.notes.pos, "old");

  // The feedback file should now have the hash key with a ref field.
  const raw = JSON.parse(await readFile(fbPath, "utf-8"));
  assertExists(raw.data[hash]);
  assertEquals(raw.data[hash].ref, "h:judge.png");
  assertEquals(raw.data[hash].vote, "down");
  // Legacy key should be gone.
  assertFalse("h:judge.png" in raw.data);

  await rm(dir, { recursive: true });
});

Deno.test("judgments: feedbackAll returns hash-keyed entries with ref", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-fball-"));
  Deno.env.set("KOZMOZOO_CACHE", join(dir, "cache"));

  const bytes = new TextEncoder().encode("feedback all test");
  const folder = join(dir, "images");
  await mkdir(folder);
  await writeFile(join(folder, "fb.png"), bytes);

  const store = await Store.open(dir, join(dir, "fb.json"));
  const hosts = { h: `folder:${folder}` };
  const ingest = new Ingest(store, hosts);
  const hash = await ingest.ensure("h", "fb.png");

  await store.judgmentSet("h", "fb.png", "vote", "up");
  await store.judgmentSet("h", "fb.png", "favorite", true);

  const all = store.feedbackAll();
  const keys = Object.keys(all);
  // At least one entry exists.
  assert(keys.length > 0);
  // The key is the hash (64 hex chars), not "host:filename".
  const entryKey = keys.find((k) => k.length === 64);
  assertExists(entryKey);
  assertEquals(all[entryKey].vote, "up");
  assertEquals(all[entryKey].favorite, true);
  assertEquals(all[entryKey].ref, "h:fb.png");

  await rm(dir, { recursive: true });
});
