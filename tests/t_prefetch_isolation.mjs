// tests/t_prefetch_isolation.mjs — one async worker per collection: a host
// failing every read stalls nothing else, the healthy host drains within
// its own expected time, and /api/prefetch reports the failing host's
// lastError (E14 / RE4).

import { assert, assertEquals } from "jsr:@std/assert";
import { Prefetch } from "../src/prefetch.mjs";
import { Ingest } from "../src/ingest.mjs";
import { Cache } from "../src/cache.mjs";
import { Store } from "../src/store.mjs";
import { makeRouter } from "../src/routes.mjs";
import { Settings } from "../src/settings.mjs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NAMES = ["a.png", "b.png", "c.png", "d.png", "e.png", "f.png"];

Deno.test("prefetch isolation: a host failing every read never stalls the healthy one; lastError reported", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-iso-"));
  const png = await readFile(new URL("./fixtures/flux-basic.png", import.meta.url).pathname);

  const good = Deno.serve({ port: 0, hostname: "127.0.0.1" }, (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/internal/files/output") return Response.json(NAMES);
    if (url.pathname !== "/api/view") return new Response("nf", { status: 404 });
    if (req.method === "HEAD") return new Response(null, { headers: { ETag: '"e"' } });
    if (req.headers.get("range")) {
      return new Response(png.subarray(0, 64), { status: 206, headers: { "Content-Type": "image/png" } });
    }
    return new Response(png, { headers: { ETag: '"e"', "Content-Type": "image/png" } });
  });
  const bad = Deno.serve({ port: 0, hostname: "127.0.0.1" }, () => new Response("boom", { status: 500 }));
  const goodAddr = `127.0.0.1:${good.addr.port}`;
  const badAddr = `127.0.0.1:${bad.addr.port}`;

  const settings = await Settings.open(dir);
  const store = await Store.open(dir);
  const cache = new Cache(join(dir, "cache"));
  const ingest = new Ingest(store, { healthy: goodAddr, broken: badAddr }, { cache });
  const pf = new Prefetch({
    hosts: { healthy: goodAddr, broken: badAddr }, store, settings, ingest,
    interFileDelayMs: 2, dimsInterFileDelayMs: 1, listRefreshMs: 3_600_000,
  });

  pf.feed("healthy", NAMES);
  pf.feed("broken", NAMES);
  const t0 = Date.now();
  pf.start();
  for (let i = 0; i < 600 && (pf.pending("healthy") > 0 || pf.dimsPending("healthy") > 0); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const drainedMs = Date.now() - t0;
  await pf.stop();

  // the healthy host drained every pass while the broken one 500s
  assertEquals(pf.pending("healthy"), 0);
  assertEquals(pf.dimsPending("healthy"), 0);
  for (const n of NAMES) {
    assert(store.hashFor("healthy", n), `healthy ${n} ingested`);
  }
  // analytic solo time is ~6 × (2 reads + 3 ms of gaps) — well under 1 s;
  // anything past 2× solo means the broken host's backoff leaked into it
  assert(drainedMs < 2000, `healthy host drained in ${drainedMs} ms — a failing host stalled it`);
  // the failure is visible, not swallowed
  assert(pf.lastError("broken"), "the broken host reports a lastError");
  assertEquals(pf.lastError("healthy"), null);

  // the router exposes it on /api/prefetch
  const router = makeRouter({
    hosts: { healthy: goodAddr, broken: badAddr }, store, settings, plugins: null, cache, ingest, prefetch: pf,
  });
  const body = await (await router.handle(new Request("http://x/api/prefetch"))).json();
  assert(String(body.lastError.broken).length > 0, `/api/prefetch carries the error: ${JSON.stringify(body.lastError)}`);
  assertEquals(body.lastError.healthy, null);

  await good.shutdown();
  await bad.shutdown();
  await rm(dir, { recursive: true, force: true });
});

Deno.test("prefetch: a collection added at runtime gets a worker and drains", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-isolate-"));
  const png = await readFile(new URL("./fixtures/flux-basic.png", import.meta.url).pathname);
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1" }, (req) => {
    const url = new URL(req.url);
    if (url.pathname !== "/api/view") return new Response("nf", { status: 404 });
    if (req.method === "HEAD") return new Response(null, { headers: { ETag: '"e"' } });
    if (req.headers.get("range")) {
      return new Response(png.subarray(0, 64), { status: 206, headers: { "Content-Type": "image/png" } });
    }
    return new Response(png, { headers: { ETag: '"e"', "Content-Type": "image/png" } });
  });
  const addr = `127.0.0.1:${server.addr.port}`;

  const settings = await Settings.open(dir);
  const store = await Store.open(dir);
  const cache = new Cache(join(dir, "cache"));
  const hosts = {}; // nothing registered at start
  const ingest = new Ingest(store, hosts, { cache });
  const pf = new Prefetch({
    hosts, store, settings, ingest,
    interFileDelayMs: 2, dimsInterFileDelayMs: 1, listRefreshMs: 3_600_000,
  });
  await pf.start();
  // the collection arrives AFTER start (the route's addCollection path)
  hosts.late = addr;
  pf.feed("late", NAMES.slice(0, 2));
  for (let i = 0; i < 300 && (pf.pending("late") > 0 || pf.dimsPending("late") > 0); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  await pf.stop();
  assertEquals(pf.pending("late"), 0);
  assertEquals(pf.dimsPending("late"), 0);
  for (const n of NAMES.slice(0, 2)) assert(store.hashFor("late", n), `${n} ingested`);

  await server.shutdown();
  await rm(dir, { recursive: true, force: true });
});

Deno.test("prefetch: a collection removed and re-added starts clean and drains again", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-isore-"));
  const png = await readFile(new URL("./fixtures/flux-basic.png", import.meta.url).pathname);
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1" }, (req) => {
    const url = new URL(req.url);
    if (url.pathname !== "/api/view") return new Response("nf", { status: 404 });
    if (req.method === "HEAD") return new Response(null, { headers: { ETag: '"e"' } });
    if (req.headers.get("range")) {
      return new Response(png.subarray(0, 64), { status: 206, headers: { "Content-Type": "image/png" } });
    }
    return new Response(png, { headers: { ETag: '"e"', "Content-Type": "image/png" } });
  });
  const addr = `127.0.0.1:${server.addr.port}`;

  const settings = await Settings.open(dir);
  const store = await Store.open(dir);
  const cache = new Cache(join(dir, "cache"));
  const hosts = { c: addr };
  const ingest = new Ingest(store, hosts, { cache });
  const pf = new Prefetch({
    hosts, store, settings, ingest,
    interFileDelayMs: 2, dimsInterFileDelayMs: 1, listRefreshMs: 3_600_000,
  });
  await pf.start();
  pf.feed("c", NAMES.slice(0, 2));
  for (let i = 0; i < 300 && (pf.pending("c") > 0 || pf.dimsPending("c") > 0); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assertEquals(pf.pending("c"), 0, "first pass drained");

  // remove the collection (the route's removeCollection path): the worker
  // ends and its state dies
  delete hosts.c;
  for (let i = 0; i < 100 && pf.workers.has("c"); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert(!pf.workers.has("c"), "the removed collection's worker is gone");

  // re-add: it must start clean and drain again (a settled task is not a
  // live one)
  hosts.c = addr;
  pf.feed("c", NAMES.slice(0, 2));
  for (let i = 0; i < 300 && (pf.pending("c") > 0 || pf.dimsPending("c") > 0); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  await pf.stop();
  assertEquals(pf.pending("c"), 0, "re-added collection drained again");
  assertEquals(pf.dimsPending("c"), 0);

  await server.shutdown();
  await rm(dir, { recursive: true, force: true });
});
