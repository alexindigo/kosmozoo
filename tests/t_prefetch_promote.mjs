// tests/t_prefetch_promote.mjs — want actually promotes (audit E12): a name
// sitting in the walk lane moves to the prio lane and is processed NEXT.
// Uses the SAME name for prio and walk — the old test's different-names
// setup is what masked the bug.

import { assert, assertEquals } from "jsr:@std/assert";
import { Prefetch } from "../src/prefetch.mjs";
import { Ingest } from "../src/ingest.mjs";
import { Cache } from "../src/cache.mjs";
import { Store } from "../src/store.mjs";
import { Settings } from "../src/settings.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

Deno.test("prefetch: enqueue a.png in walk, then want(['a.png']) — a.png is next", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-promo-"));
  const processed = [];
  // a backing that answers slowly enough to observe the queue order
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1" }, async (req) => {
    const url = new URL(req.url);
    if (url.pathname !== "/api/view") return new Response("nf", { status: 404 });
    const name = url.searchParams.get("filename");
    if (req.method === "HEAD") return new Response(null, { headers: { ETag: '"e"' } });
    processed.push(name);
    await new Promise((r) => setTimeout(r, 20));
    return new Response(`bytes-${name}`, { headers: { ETag: '"e"', "Content-Type": "image/png" } });
  });
  const addr = `127.0.0.1:${server.addr.port}`;

  const settings = await Settings.open(dir);
  const store = await Store.open(dir, join(dir, "fb.json"));
  const ingest = new Ingest(store, { local: addr }, { cache: new Cache(join(dir, "cache")) });
  const pf = new Prefetch({ hosts: { local: addr }, store, settings, ingest, interFileDelayMs: 5 });

  pf.feed("local", ["b.png", "a.png"]);   // the walk: b first, a second
  pf.feed("local", ["a.png"], true);      // want: a.png promotes from walk to prio
  assertEquals(pf.workers.get("local").walk, ["b.png"]);
  assertEquals(pf.workers.get("local").prio, ["a.png"]);

  pf.start();
  for (let i = 0; i < 100 && pf.pending("local") > 0; i++) {
    await new Promise((r) => setTimeout(r, 30));
  }
  pf.stop();

  assertEquals(processed[0], "a.png"); // promoted: processed FIRST
  assert(processed.includes("b.png"));
  assertEquals(pf.pending("local"), 0);
  // and no duplicates: a.png was ingested once
  assertEquals(processed.filter((n) => n === "a.png").length, 1);

  await server.shutdown();
  await rm(dir, { recursive: true });
});
