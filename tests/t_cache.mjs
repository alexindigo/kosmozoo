// tests/t_cache.mjs — cache pipeline integration: sha256, cache store,
// ingestion flow, cache-first serve, hash identity across hosts.

import { assert, assertEquals, assertExists, assertFalse } from "jsr:@std/assert";
import { sha256, cachePut, cacheGet, cachePath } from "../src/cache.mjs";
import { Ingest } from "../src/ingest.mjs";
import { Settings } from "../src/settings.mjs";
import { Store } from "../src/store.mjs";
import { makeRouter } from "../src/routes.mjs";
import { isFolderHost } from "../src/backings/index.mjs";
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
  const { hash } = await ingest.ensure("fixtures", "test.png");
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

  const { hash: h1 } = await ingest.ensure("host1", "img.png");
  const { hash: h2 } = await ingest.ensure("host2", "img.png");

  // Same content → same hash.
  assertEquals(h1, h2);

  // Both files rows point to the same hash.
  assertEquals(store.hashFor("host1", "img.png"), h1);
  assertEquals(store.hashFor("host2", "img.png"), h1);

  // Bytes and meta share one identity; judgments are PER ENTRY — a vote on
  // one instance says nothing about the other (the §9 Q4 decision).
  await store.judgmentSet("host1", "img.png", "vote", "up");
  assertEquals(store.judgmentGet("host1", "img.png").vote, "up");
  assertEquals(store.judgmentGet("host2", "img.png"), null);

  await rm(dir, { recursive: true });
});

// --- serve path: cache-first ----------------------------------------------

Deno.test("serve path: bytes carry validators — ETag (content hash) + no-cache; If-None-Match → 304", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-val-"));
  Deno.env.set("KOZMOZOO_CACHE", join(dir, "cache"));

  const bytes = new TextEncoder().encode("validator content");
  const folder = join(dir, "images");
  await mkdir(folder);
  await writeFile(join(folder, "img.png"), bytes);

  const settings = await Settings.open(dir);
  const store = await Store.open(dir, join(dir, "fb.json"));
  const hosts = { h: `folder:${folder}` };
  const ingest = new Ingest(store, hosts);
  const router = makeRouter({ hosts, store, settings, plugins: null, ingest });
  router.ctx = { hosts, store, settings, plugins: null, ingest };

  const { hash } = await ingest.ensure("h", "img.png");
  const r1 = await router.handle(new Request("http://x/api/collections/h/entries/img.png/bytes"));
  assertEquals(r1.status, 200);
  assertEquals(r1.headers.get("ETag"), `"${hash}"`);
  assertEquals(r1.headers.get("Cache-Control"), "no-cache");
  await r1.arrayBuffer();

  const r2 = await router.handle(new Request("http://x/api/collections/h/entries/img.png/bytes", {
    headers: { "If-None-Match": `"${hash}"` },
  }));
  assertEquals(r2.status, 304);
  await r2.arrayBuffer();

  const r3 = await router.handle(new Request("http://x/api/collections/h/entries/img.png/bytes", {
    headers: { "If-None-Match": `"${"0".repeat(64)}"` },
  }));
  assertEquals(r3.status, 200);
  await r3.arrayBuffer();

  await rm(dir, { recursive: true });
});

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
  const r1 = await router.handle(new Request("http://x/api/collections/host/entries/img.png/bytes"));
  assertEquals(r1.status, 200);
  const b1 = new Uint8Array(await r1.arrayBuffer());
  assertEquals(b1, bytes);

  // Remove the folder (simulate host offline).
  await rm(folder, { recursive: true });

  // Second request: cache hit, no host needed.
  const r2 = await router.handle(new Request("http://x/api/collections/host/entries/img.png/bytes"));
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

  const r = await router.handle(new Request("http://x/api/collections/h/entries/img.png/bytes"));
  assertEquals(r.status, 200);
  assertEquals(r.headers.get("Content-Type"), "image/png");
  assertExists(r.headers.get("Content-Length"));

  await rm(dir, { recursive: true });
});

// --- judgment migration ---------------------------------------------------

Deno.test("judgment migration: v1 feedback fans out to entry columns, file backed up", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-jmig-"));
  Deno.env.set("KOZMOZOO_CACHE", join(dir, "cache"));

  const bytes = new TextEncoder().encode("judgment test content");
  const folder = join(dir, "images");
  await mkdir(folder);
  await writeFile(join(folder, "judge.png"), bytes);

  // an ingested file + a v1 feedback document keyed by legacy address AND hash
  const fbPath = join(dir, "fb.json");
  const store = await Store.open(dir);
  const hosts = { h: `folder:${folder}` };
  const ingest = new Ingest(store, hosts);
  const { hash } = await ingest.ensure("h", "judge.png");
  assertExists(hash);
  store.close();
  await writeFile(fbPath, JSON.stringify({
    version: 1,
    data: {
      "h:judge.png": { vote: "down", notes: { pos: "old" } },
      [hash]: { favorite: true },
    },
  }, null, 2));

  // re-open: the v1→v2 import lands both on the same entry, then backs up
  const store2 = await Store.open(dir, { feedbackPath: fbPath });
  assertEquals(store2.judgmentGet("h", "judge.png"), {
    vote: "down", favorite: true, notes: { pos: "old" },
  });
  const names = [];
  for await (const f of Deno.readDir(dir)) names.push(f.name);
  assert(!names.includes("fb.json"), "the v1 document is renamed away");
  assert(names.some((f) => f.startsWith("fb.json.v1-backup-")));
  store2.close();

  await rm(dir, { recursive: true });
});

Deno.test("judgments: judgmentsAll returns hash-keyed entries with ref; per-collection export", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-fball-"));
  Deno.env.set("KOZMOZOO_CACHE", join(dir, "cache"));

  const bytes = new TextEncoder().encode("feedback all test");
  const folder = join(dir, "images");
  await mkdir(folder);
  await writeFile(join(folder, "fb.png"), bytes);

  const store = await Store.open(dir);
  const hosts = { h: `folder:${folder}` };
  const ingest = new Ingest(store, hosts);
  const { hash } = await ingest.ensure("h", "fb.png");

  await store.judgmentSet("h", "fb.png", "vote", "up");
  await store.judgmentSet("h", "fb.png", "favorite", true);

  const all = store.judgmentsAll();
  const entryKey = Object.keys(all).find((k) => k.length === 64);
  assertExists(entryKey);
  assertEquals(all[entryKey].vote, "up");
  assertEquals(all[entryKey].favorite, true);
  assertEquals(all[entryKey].ref, "h:fb.png");

  // the per-collection export generates the portable v2 document on demand
  const doc = store.feedbackExport("h");
  assertEquals(doc.version, 2);
  assertEquals(doc.collection, "h");
  assertEquals(doc.entries["fb.png"], { hash, vote: "up", favorite: true });
  assertEquals(store.feedbackExport("nope"), null); // unknown collection

  store.close();
  await rm(dir, { recursive: true });
});
