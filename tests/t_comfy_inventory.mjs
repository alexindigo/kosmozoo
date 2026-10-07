import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import { comfyClient, normalizeInventory, normalizeRootInventory } from "../src/backings/comfy.mjs";
import { buildContext } from "../src/context.mjs";
import { mkStateRig } from "./helpers/rig.mjs";
import { makeRouter } from "../src/routes.mjs";

const config = { recursive: true, scan_depth: null, list_limit: 200, allowed_extensions: [".png"] };
const item = (relpath, mtime = 1, size = 12) => ({ relpath, filename: relpath.split("/").at(-1), mtime, size });
const payload = (items) => ({ items, has_more: false, cursor: items.length ? `${items.at(-1).mtime}:${items.at(-1).relpath}` : "", latest_mtime: items[0]?.mtime ?? 0 });
const deferred = () => { let resolve; const promise = new Promise((yes) => resolve = yes); return { promise, resolve }; };
const head = (mtime = 1, size = 12) => new Response(null, { headers: {
  "Last-Modified": new Date(mtime * 1000).toUTCString(), "Content-Length": String(size), ETag: '"opaque"' } });
const waitFor = async (predicate) => {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise((r) => setTimeout(r, 1)); }
  throw new Error("Condition did not become true");
};

Deno.test("unified chronology: an actual dated nested output precedes an older root", async () => {
  const port = 18209;
  const child = new Deno.Command(Deno.execPath(), { args: ["run", "--allow-net", "--allow-read",
    new URL("./fake-comfy.mjs", import.meta.url).pathname, "--port", String(port)], stdout: "null", stderr: "null" }).spawn();
  const base = `http://127.0.0.1:${port}`;
  let owner;
  try {
    let ready = false;
    for (let i = 0; i < 50; i++) {
      try { const r = await fetch(base + "/api/system_stats"); await r.arrayBuffer(); if (r.ok) { ready = true; break; } } catch { /* boot */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert(ready);
    const files = [
      { name: "chronology-root-today.png", mtime: 2_000_000_004 },
      { name: "chronology/nested-yesterday.png", mtime: 2_000_000_003 },
      { name: "chronology-root-last-week.png", mtime: 2_000_000_002 },
      { name: "chronology/deep/nested-older.png", mtime: 2_000_000_001 },
    ];
    const control = await fetch(base + "/__test/activity", { method: "POST", body: JSON.stringify({ publish: files, clearHistory: true }) });
    assertEquals(control.status, 200); await control.arrayBuffer();
    for (const file of files) {
      const url = new URL(base + "/api/view"); const parts = file.name.split("/");
      url.searchParams.set("type", "output"); url.searchParams.set("filename", parts.pop());
      if (parts.length) url.searchParams.set("subfolder", parts.join("/"));
      const head = await fetch(url, { method: "HEAD" });
      assertEquals(head.status, 200);
      assertEquals(head.headers.get("last-modified"), new Date(file.mtime * 1000).toUTCString());
    }
    owner = comfyClient(`127.0.0.1:${port}`);
    const snapshot = await owner.inventory();
    const names = new Set(files.map((f) => f.name));
    assertEquals(snapshot.items.filter((e) => names.has(e.name)).map((e) => e.name), files.map((f) => f.name));
  } finally {
    await owner?.disposeInventory(); child.kill("SIGTERM"); await child.status;
  }
});

Deno.test("inventory: combined complete request includes roots and >200/deep/backdated/history-independent descendants", async () => {
  const rows = [item("parent/deep/same.png", -1), item("a/same.png", 10), item("b/same.png", 10),
    ...Array.from({ length: 250 }, (_, i) => item(`series/file-${i}.png`, 5))];
  let calls = 0;
  const client = comfyClient("fake:1", { fetcher: async (url, options) => {
    const u = new URL(url);
    if (options?.method === "HEAD") {
      const name = [u.searchParams.get("subfolder"), u.searchParams.get("filename")].filter(Boolean).join("/");
      const file = rows.find((r) => r.relpath === name);
      return head(file?.mtime ?? 10, file?.size ?? 12);
    }
    if (u.pathname === "/api/assets_plus/config") return Response.json(config);
    if (u.pathname === "/internal/files/output") return Response.json(["root.png [12]"]);
    assertEquals(u.pathname, "/api/assets_plus/output/list");
    assertEquals(u.searchParams.get("recursive"), "1");
    assertEquals(u.searchParams.get("scan_depth"), "-1");
    assertEquals(u.searchParams.get("limit"), "0");
    assertEquals(u.searchParams.get("extensions"), "png,jpg,jpeg,webp,gif,svg,avif,bmp");
    assertEquals(u.searchParams.get("query"), "/");
    for (const key of ["cursor", "since", "q"]) assertEquals(u.searchParams.has(key), false);
    calls++;
    return Response.json(payload(rows));
  } });
  try {
    const inventory = await client.inventory();
    assertEquals(inventory.items.length, 254);
    assertEquals(inventory.items.slice(0, 3).map((x) => x.name), ["a/same.png", "b/same.png", "root.png"]);
    assertEquals(inventory.items.at(-1).name, "parent/deep/same.png");
    assertEquals(inventory.folders, ["", "a", "b", "parent", "parent/deep", "series"]);
    assertEquals(inventory.coverage, "recursive");
    assertEquals(inventory.subfolders.supported, true);
    assertEquals(calls, 1);
  } finally { await client.disposeInventory(); }
});

Deno.test("inventory: malformed records, conflicting duplicates and truncated scans reject as a whole", () => {
  const valid = item("a/image.png");
  for (const bad of [null, {}, { ...payload([valid]), has_more: true },
    payload([valid, item("../outside.png")]), payload([valid, item("a/image.png", 2)]),
    payload([valid, { ...valid, relpath: "b.png", size: "12" }]),
    payload([valid, { ...valid, relpath: "b.png", mtime: null }])]) {
    let threw = false;
    try { normalizeInventory(bad); } catch { threw = true; }
    assert(threw, "a partial/invalid scan must not become a valid inventory");
  }
  assertEquals(normalizeInventory(payload([valid, valid])), [{ name: "a/image.png", size: 12, mtime: 1 }]);
});

Deno.test("inventory: stock roots retain native order/visibility and validate before union publication", () => {
  assertEquals(normalizeRootInventory(["z.png [output]", "a.png [12]", "notes.json", "a.png [12]"]),
    [{ name: "z.png", size: null }, { name: "a.png", size: 12 }]);
  for (const raw of [{}, [null], ["a/invalid.png"], ["../outside.png"], ["a.png [12]", "a.png [13]"]]) {
    let threw = false; try { normalizeRootInventory(raw); } catch { threw = true; }
    assert(threw, "invalid stock roots must reject as a whole");
  }
});

Deno.test("inventory: concurrent readers share one flight; invalidation during read coalesces a follow-up before publication", async () => {
  const first = deferred(), second = deferred();
  let scans = 0;
  const client = comfyClient("fake:1", { fetcher: async (url, options) => {
    if (options?.method === "HEAD") return head();
    if (new URL(url).pathname.endsWith("config")) return Response.json(config);
    if (new URL(url).pathname === "/internal/files/output") return Response.json([]);
    scans++;
    return scans === 1 ? first.promise : second.promise;
  } });
  try {
    const a = client.inventory(), b = client.inventory();
    assertEquals(a, b);
    await waitFor(() => scans > 0);
    assertEquals(scans, 1);
    client.invalidateInventory(); client.invalidateInventory();
    first.resolve(Response.json(payload([item("stale/old.png")])));
    await waitFor(() => scans >= 2);
    assertEquals(scans, 2);
    let resolved = false;
    a.then(() => resolved = true, () => {});
    await Promise.resolve(); assertEquals(resolved, false);
    second.resolve(Response.json(payload([item("latest/new.png")])));
    const [one, two] = await Promise.all([a, b]);
    assertEquals(one, two);
    assertEquals(one.items.map((x) => x.name), ["latest/new.png"]);
    assertEquals(await client.inventory({ maxAgeMs: 60_000 }), one);
    assertEquals(scans, 2);
  } finally { first.resolve(Response.json(payload([]))); second.resolve(Response.json(payload([]))); await client.disposeInventory(); }
});

Deno.test("inventory: absence alone allows stock root; known recursive failure cannot downgrade or poison good snapshot", async () => {
  let clock = 0, mode = "absent", scans = 0;
  const client = comfyClient("fake:1", { clock: () => clock, fetcher: async (url, options) => {
    if (options?.method === "HEAD") return head(1, 123);
    const path = new URL(url).pathname;
    if (path.endsWith("config")) return mode === "absent" ? new Response(null, { status: 404 }) : Response.json(config);
    if (path === "/internal/files/output") return Response.json(["root.png [123]"]);
    scans++;
    if (mode === "failure") return new Response(null, { status: 503 });
    if (mode === "truncated") return Response.json({ ...payload([item("partial.png")]), has_more: true });
    return Response.json(payload([item("nested/good.png")]));
  } });
  try {
    const flat = await client.inventory();
    assertEquals(flat.coverage, "root-only"); assertEquals(flat.folders, [""]);
    assertEquals(flat.items, [{ name: "root.png", size: 123, modified: { atMs: 1000, precisionMs: 1000, source: "http-last-modified" } }]);
    assertEquals(flat.subfolders.supported, false);
    mode = "recursive"; clock = 60_001;
    const good = await client.inventory();
    mode = "failure";
    await assertRejects(() => client.inventory());
    assertEquals(client.peekInventory(), good);
    mode = "truncated";
    await assertRejects(() => client.inventory());
    assertEquals(client.peekInventory(), good);
    mode = "recursive";
    assertEquals((await client.inventory()).coverage, "recursive");
    assertEquals(scans, 4);
  } finally { await client.disposeInventory(); }
});

Deno.test("inventory: removed owner aborts/fences ignored-abort fetches; new incarnation gets a new revision epoch", async () => {
  const pending = deferred(); let signal;
  const old = comfyClient("fake:1", { fetcher: async (url, options) => {
    if (options?.method === "HEAD") return head();
    if (new URL(url).pathname.endsWith("config")) return Response.json(config);
    if (new URL(url).pathname === "/internal/files/output") return Response.json([]);
    signal = options.signal; return pending.promise;
  } });
  const read = old.inventory();
  await waitFor(() => !!signal);
  const rejected = assertRejects(() => read);
  const stopped = old.disposeInventory();
  assertEquals(signal.aborted, true);
  pending.resolve(Response.json(payload([item("late.png")])));
  await rejected; await stopped;
  let throws = false; try { old.inventory(); } catch { throws = true; } assert(throws);
  const fresh = comfyClient("fake:1", { fetcher: async (url, options) => options?.method === "HEAD" ? head() : Response.json(new URL(url).pathname.endsWith("config") ? config
    : new URL(url).pathname === "/internal/files/output" ? [] : payload([item("new/image.png")])) });
  try { assertEquals((await fresh.inventory()).items[0].name, "new/image.png"); }
  finally { await fresh.disposeInventory(); }
});

Deno.test("inventory API: raw folders survive hidden/gone overlay, array compatibility and address-alias independence", async () => {
  let scans = 0;
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1" }, (req) => {
    if (req.method === "HEAD") return head();
    const path = new URL(req.url).pathname;
    if (path.endsWith("config")) return Response.json(config);
    if (path === "/internal/files/output") return Response.json([]);
    if (path.endsWith("output/list")) { scans++; return Response.json(payload([item("a/image.png"), item("hidden/deep/image.png")])); }
    return new Response(null, { status: 404 });
  });
  const address = `127.0.0.1:${server.addr.port}`, hosts = { h: address, alias: address };
  const rig = await mkStateRig("inventory-api", { hosts });
  const built = await buildContext({ start: false, env: { HOME: rig.dir }, fakes: { ...rig,
    plugins: { discover: async () => [], list: () => [] }, prefetch: { requestRelist() {} }, features: [] } });
  try {
    rig.store.entryHide("h", "hidden/deep/image.png");
    rig.store.judgmentPatch("h", "a/image.png", { bookmark: true });
    const one = built.router.handle(new Request("http://x/api/collections/h/entries?inventory=1"));
    const two = built.router.handle(new Request("http://x/api/collections/alias/entries?inventory=1"));
    const [a, b] = await Promise.all([one.then((r) => r.json()), two.then((r) => r.json())]);
    assertEquals(scans, 1);
    assertEquals(a.revision, b.revision);
    assertEquals(a.folders, ["", "a", "hidden", "hidden/deep"]);
    assertEquals(a.entries.map((x) => x.name), ["a/image.png"]);
    assertEquals(a.entries[0].judgment, { bookmark: true });
    assertEquals(b.entries.length, 2); assertEquals(b.entries[0].judgment, null);
    const plain = await (await built.router.handle(new Request("http://x/api/collections/h/entries"))).json();
    assertEquals(plain, a.entries, "array/envelope metadata and order parity");
    const scansBeforeEntry = scans;
    const observed = await (await built.router.handle(new Request("http://x/api/collections/h/entries/a%2Fimage.png"))).json();
    assertEquals(observed.modified, a.entries[0].modified);
    assertEquals(scans, scansBeforeEntry, "single entry never starts a full scan");
    assertEquals(rig.store.hashFor("h", "a/image.png"), null, "GET scheduled no ingestion writes");
    delete hosts.alias; built.ctx.inventory.reconcile();
    const before = (await built.ctx.inventory("h")).revision;
    delete hosts.h; built.ctx.inventory.reconcile(); hosts.h = address;
    const after = (await built.ctx.inventory("h")).revision;
    assert(before.split(":")[0] !== after.split(":")[0], "last-address removal fences owner incarnation");
  } finally { await built.ctx.jobs.stop(); await built.ctx.inventory.stop(); await rig.close(); await server.shutdown(); }
});

Deno.test("inventory: either half failing or nested query returning roots cannot erase a good combined snapshot", async () => {
  let mode = "good";
  const client = comfyClient("fake:1", { fetcher: async (url, options) => {
    if (options?.method === "HEAD") return head();
    const p = new URL(url).pathname;
    if (p.endsWith("config")) return Response.json(config);
    if (p === "/internal/files/output") return mode === "root-failure" ? new Response(null, { status: 503 }) : Response.json(["root.png [12]"]);
    if (mode === "nested-failure") return new Response(null, { status: 500 });
    return Response.json(payload([item(mode === "wrong-scope" ? "unexpected-root.png" : "a/nested.png")]));
  } });
  try {
    const good = await client.inventory();
    for (mode of ["root-failure", "nested-failure", "wrong-scope"]) {
      await assertRejects(() => client.inventory());
      assertEquals(client.peekInventory(), good);
    }
  } finally { await client.disposeInventory(); }
});
Deno.test("unified chronology: root and descendant share HTTP authority, fresh same-size touch/backdate replaces old order", async () => {
  let date = 6000, calls = 0, fail = false;
  const client = comfyClient("fake:1", { fetcher: async (url, options) => {
    const u = new URL(url);
    if (options?.method === "HEAD") {
      calls++;
      if (fail) return new Response(null, { headers: { ETag: '"content-only"' } });
      return head(u.searchParams.get("filename") === "root.png" ? date / 1000 : 6, 12);
    }
    if (u.pathname.endsWith("config")) return Response.json(config);
    if (u.pathname === "/internal/files/output") return Response.json(["root.png [12]"]);
    return Response.json(payload([item("a/nested.png", 5, 12)]));
  } });
  try {
    const first = await client.inventory();
    assertEquals(first.items.map((e) => e.name), ["a/nested.png", "root.png"]);
    assertEquals(first.items[0].modified.atMs, 6000);
    assertEquals(await client.inventory({ maxAgeMs: 60000 }), first); assertEquals(calls, 2);
    date = 7000; assertEquals((await client.inventory()).items[0].name, "root.png");
    date = 0; const backdated = await client.inventory();
    assertEquals(backdated.items.at(-1).modified.atMs, 0);
    fail = true; await assertRejects(() => client.inventory());
    assertEquals(client.peekInventory(), backdated);
  } finally { await client.disposeInventory(); }
});

Deno.test("chronology 404: reconcile once, retry still-listed once, preserve vanished folders and clear diagnostics on presence", async () => {
  let listing = 0, present = false;
  const heads = new Map();
  const client = comfyClient("fake:1", { fetcher: async (url, options) => {
    const u = new URL(url);
    if (options?.method === "HEAD") {
      const name = [u.searchParams.get("subfolder"), u.searchParams.get("filename")].filter(Boolean).join("/");
      heads.set(name, (heads.get(name) ?? 0) + 1);
      return present || name === "good.png" || name === "race/returns.png" && heads.get(name) === 2
        ? head() : new Response(null, { status: 404 });
    }
    if (u.pathname.endsWith("config")) return Response.json(config);
    if (u.pathname === "/internal/files/output") return Response.json(["good.png [12]"]);
    listing++;
    return Response.json(payload([item("still/missing.png"), item("race/returns.png"),
      ...(listing === 1 ? [item("vanished/deep/file.png")] : [])]));
  } });
  try {
    const result = await client.inventory();
    assertEquals(listing, 2);
    assertEquals([...heads.entries()], [["good.png", 1], ["still/missing.png", 2], ["race/returns.png", 2], ["vanished/deep/file.png", 1]]);
    assertEquals(result.items.map(e => e.name), ["good.png", "race/returns.png"]);
    assertEquals(result.unavailable.map(e => e.name), ["still/missing.png", "vanished/deep/file.png"]);
    assert(result.folders.includes("vanished/deep"));
    present = true;
    assertEquals((await client.inventory()).unavailable, []);
  } finally { await client.disposeInventory(); }
});

Deno.test("chronology HEAD failures: 403/405/5xx/malformed date/length reject without poisoning snapshot or byte stamp", async () => {
  let mode = "good";
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1" }, req => {
    const u = new URL(req.url);
    if (req.method === "HEAD") {
      if (typeof mode === "number") return new Response(null, { status: mode });
      return new Response(null, { headers: { ETag: '"new-observation"',
        "Last-Modified": mode === "date" ? "1234" : new Date(1000).toUTCString(),
        "Content-Length": mode === "length" ? "9007199254740992" : "12" } });
    }
    if (u.pathname.endsWith("config")) return new Response(null, { status: 404 });
    return Response.json(["root.png [12]"]);
  });
  const rig = await mkStateRig("chronology-stamp", { hosts: { h: `127.0.0.1:${server.addr.port}` } });
  try {
    await rig.store.ingestFile("h", "root.png", "old-hash", 12, { stamp: '"ingested-bytes"' });
    const first = await rig.inventory("h");
    for (mode of [403, 405, 500, 503, "date", "length"]) {
      await assertRejects(() => rig.inventory("h"));
      assertEquals(rig.inventory.peek("h"), first);
      assertEquals(rig.store.fileInfo("h", "root.png").stamp, '"ingested-bytes"');
    }
  } finally { await rig.close(); await server.shutdown(); }
});
