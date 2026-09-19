// tests/t_prefetch_two_pass.mjs — the §4.2 two-pass prefetch: pass 1 (dims
// head reads) drains before pass 2 (ingest) starts, want promotes in BOTH
// queues, and a 404 head read marks the entry gone one pass early.

import { assert, assertEquals } from "jsr:@std/assert";
import { Prefetch } from "../src/prefetch.mjs";
import { Ingest } from "../src/ingest.mjs";
import { Store } from "../src/store.mjs";
import { mkStateRig } from "./helpers/rig.mjs";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

Deno.test("prefetch: dims queue drains before ingest starts; want promotes in both", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-2pass-"));
  const png = await readFile(new URL("./fixtures/flux-basic.png", import.meta.url).pathname);
  const order = []; // "dims:<name>" / "ingest:<name>"
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1" }, async (req) => {
    const url = new URL(req.url);
    if (url.pathname !== "/api/view") return new Response("nf", { status: 404 });
    const name = url.searchParams.get("filename");
    if (req.method === "HEAD") return new Response(null, { headers: { ETag: '"e"' } });
    if (req.headers.get("range")) {
      order.push("dims:" + name);
      // the IHDR lives in the first 24 bytes — a 64-byte slice dims fine
      return new Response(png.subarray(0, 64), { status: 206, headers: { "Content-Type": "image/png" } });
    }
    order.push("ingest:" + name);
    await new Promise((r) => setTimeout(r, 5));
    return new Response(png, { headers: { ETag: '"e"', "Content-Type": "image/png" } });
  });
  const addr = `127.0.0.1:${server.addr.port}`;

  const rig = await mkStateRig("2pass", { dir });
  const { settings, store, cache } = rig;
  const ingest = new Ingest(store, { local: addr }, { cache });
  const pf = new Prefetch({
    hosts: { local: addr }, store, settings, ingest,
    interFileDelayMs: 2, dimsInterFileDelayMs: 1, listRefreshMs: 3_600_000,
  });

  pf.feed("local", ["c.png", "b.png", "a.png"]);
  pf.feed("local", ["a.png"], true); // want: promotes in BOTH queues
  const w = pf.workers.get("local");
  assertEquals(w.dimsPrio, ["a.png"]);
  assertEquals(w.dimsWalk, ["c.png", "b.png"]);
  assertEquals(w.prio, ["a.png"]);
  assertEquals(w.walk, ["c.png", "b.png"]);
  assertEquals(pf.dimsPending("local"), 3);
  assertEquals(pf.pending("local"), 3);

  pf.start();
  for (let i = 0; i < 200 && (pf.pending("local") > 0 || pf.dimsPending("local") > 0); i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  pf.stop();

  assertEquals(pf.pending("local"), 0);
  assertEquals(pf.dimsPending("local"), 0);
  // pass 1 fully precedes pass 2
  const firstIngest = order.findIndex((x) => x.startsWith("ingest:"));
  const lastDims = order.map((x) => x.startsWith("dims:")).lastIndexOf(true);
  assert(firstIngest > lastDims, `dims lane drained first: ${order.join(",")}`);
  // want promoted in both: the first head read AND the first full read are a.png
  assertEquals(order[0], "dims:a.png");
  assertEquals(order[firstIngest], "ingest:a.png");
  // every entry carries dims and a hash at the end
  for (const n of ["a.png", "b.png", "c.png"]) {
    assert(store.entryDims("local", n), `dims for ${n}`);
    assert(store.hashFor("local", n), `ingested ${n}`);
  }

  await server.shutdown();
  await rm(dir, { recursive: true });
});

Deno.test("prefetch: a 404 dims head read marks the entry gone immediately", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-2pass-gone-"));
  const png = await readFile(new URL("./fixtures/flux-basic.png", import.meta.url).pathname);
  const hits = []; // [pass, name] in request order — which pass touched the file first
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1" }, (req) => {
    const url = new URL(req.url);
    if (url.pathname !== "/api/view") return new Response("nf", { status: 404 });
    const name = url.searchParams.get("filename");
    if (name !== "ok.png") {
      hits.push([req.headers.get("range") ? "dims" : "full", name]);
      return new Response("nf", { status: 404 });
    }
    if (req.headers.get("range")) {
      hits.push(["dims", name]);
      return new Response(png.subarray(0, 64), { status: 206, headers: { "Content-Type": "image/png" } });
    }
    hits.push(["full", name]);
    return new Response(png, { headers: { ETag: '"e"', "Content-Type": "image/png" } });
  });
  const addr = `127.0.0.1:${server.addr.port}`;

  const rig = await mkStateRig("2pass", { dir });
  const { settings, store, cache } = rig;
  const ingest = new Ingest(store, { local: addr }, { cache });
  const pf = new Prefetch({
    hosts: { local: addr }, store, settings, ingest,
    interFileDelayMs: 2, dimsInterFileDelayMs: 1, listRefreshMs: 3_600_000,
  });

  pf.feed("local", ["gone.png", "ok.png"]);
  pf.start();
  let goneState = null;
  for (let i = 0; i < 200; i++) {
    goneState = store.entryGet("local", "gone.png")?.state ?? null;
    if (goneState === "gone") break;
    await new Promise((r) => setTimeout(r, 25));
  }
  pf.stop();

  assertEquals(goneState, "gone");
  assertEquals(store.hashFor("local", "gone.png"), null); // …never ingested
  // and it was the DIMS pass that marked it: the first read of the file at
  // all was a head read (a pass-2 full read hits the same 404 later —
  // entryGone is idempotent — so order, not presence, is the proof)
  const firstHit = hits.find(([, n]) => n === "gone.png");
  assertEquals(firstHit?.[0], "dims", `the dims pass saw the 404 first: ${JSON.stringify(hits)}`);

  await server.shutdown();
  await rm(dir, { recursive: true });
});
