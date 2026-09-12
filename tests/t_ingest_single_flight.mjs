// tests/t_ingest_single_flight.mjs — the one ingestion path: concurrent
// ensure() calls for the same file share ONE backing read; extraction is
// decided by the content row's ext (stale re-extracts, current skips).

import { assert, assertEquals } from "jsr:@std/assert";
import { Ingest } from "../src/ingest.mjs";
import { Store } from "../src/store.mjs";
import { Settings } from "../src/settings.mjs";
import { EXTRACTOR_VERSION } from "../src/extractor.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A counting fake backing: every /api/view read is tallied.
function countingComfy(body = "counting v1") {
  const state = { reads: 0 };
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1" }, (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/api/view") {
      if (req.method === "HEAD") return new Response(null, { headers: { ETag: '"e1"' } });
      state.reads++;
      return new Response(body, { headers: { ETag: '"e1"', "Content-Type": "image/png" } });
    }
    return new Response("nf", { status: 404 });
  });
  return { state, server, addr: `127.0.0.1:${server.addr.port}` };
}

Deno.test("ingest: concurrent ensure() is single-flight — one backing read", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-sf-"));
  Deno.env.set("KOZMOZOO_CACHE", join(dir, "cache"));
  const { state, server, addr } = countingComfy();
  const store = await Store.open(dir, join(dir, "fb.json"));
  const ingest = new Ingest(store, { c: addr });

  const [r1, r2, r3] = await Promise.all([
    ingest.ensure("c", "img.png"),
    ingest.ensure("c", "img.png"),
    ingest.ensure("c", "img.png"),
  ]);
  assertEquals(state.reads, 1); // one backing read for three callers
  assert(r1.hash && r1.hash === r2.hash && r2.hash === r3.hash);
  assertEquals(store.hashFor("c", "img.png"), r1.hash);

  // a later ensure serves from the cache — no new backing read
  const again = await ingest.ensure("c", "img.png");
  assertEquals(again.hash, r1.hash);
  assertEquals(state.reads, 1);

  await server.shutdown();
  await rm(dir, { recursive: true });
});

Deno.test("ingest: extraction is decided by content.ext — stale re-extracts, current skips", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-ext-"));
  Deno.env.set("KOZMOZOO_CACHE", join(dir, "cache"));
  const { server, addr } = countingComfy("not-a-png");
  const store = await Store.open(dir, join(dir, "fb.json"));
  const ingest = new Ingest(store, { c: addr });

  // pre-seed a CURRENT content row: the ensure must NOT re-extract
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update("not-a-png").digest("hex");
  await store.ingestFile("c", "img.png", hash, 9, {});
  await store.metaPut("c", "img.png", { seed: 7 }, { ext: EXTRACTOR_VERSION });
  await ingest.ensure("c", "img.png");
  assertEquals(store.metaGet("c", "img.png"), { seed: 7 }); // untouched

  // a STALE row (older ext) re-extracts: not-a-png yields no meta (NULL)
  await store.metaPut("c", "img.png", { seed: 7 }, { ext: EXTRACTOR_VERSION - 1 });
  await ingest.ingest("c", "img.png", "output", { bytes: new TextEncoder().encode("not-a-png") });
  assertEquals(store.metaGet("c", "img.png"), null);
  assertEquals(store.contentGet(store.hashFor("c", "img.png")).ext, EXTRACTOR_VERSION);

  await server.shutdown();
  await rm(dir, { recursive: true });
});
