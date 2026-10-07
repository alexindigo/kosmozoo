import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import { isEntryPath, isFolderPath, splitEntryPath, inventoryFolders, inFolder } from "../src/entry-path.mjs";
import { validEntryName } from "../src/backings/index.mjs";
import * as comfy from "../src/backings/comfy.mjs";
import { makeRouter } from "../src/routes.mjs";
import { mkStateRig } from "./helpers/rig.mjs";
import { testPng } from "./helpers/png.mjs";

const bad = ["", "/image.png", "C:/image.png", "C:\\image.png", "a\\image.png", "a//image.png",
  "a/image.png/", "./image.png", "a/../image.png", "../image.png", "a/./image.png", "nul\0.png", "line\n.png", null, 1];

Deno.test("entry paths: exact canonical identity, ancestor/subtree boundaries and unchanged flat-folder grammar", () => {
  for (const name of bad) assertEquals(isEntryPath(name), false, JSON.stringify(name));
  for (const name of ["root.png", "a:b#c.png", "C:file.png", "a/image.png", "b/image.png", "a/day/image.png", "a/leaf..png", "literal%2F.png", "a/#name: café %.png", "h#real.png"]) {
    assertEquals(isEntryPath(name), true, name);
  }
  assertEquals(isFolderPath(""), true);
  assertEquals(splitEntryPath("a/day/image.png"), { filename: "image.png", subfolder: "a/day" });
  assertEquals(splitEntryPath("literal%2F.png"), { filename: "literal%2F.png", subfolder: "" });
  assertEquals(inventoryFolders([{ name: "a/day/image.png" }, { name: "ab/image.png" }]), ["", "a", "a/day", "ab"]);
  assert(inFolder("a/day/image.png", "a")); assert(!inFolder("ab/image.png", "a"));
  assertEquals(validEntryName("folder:/tmp", "a/image.png"), false);
  assertEquals(validEntryName("folder:/tmp", "leaf..png"), false);
  assertEquals(validEntryName("comfy:1", "leaf..png"), true);
  for (const name of ["\\leaf.png", "line\n.png"]) {
    assertEquals(validEntryName("folder:/tmp", name), true, "the flat driver's leaf grammar stays intact");
    assertEquals(validEntryName("comfy:1", name), false);
  }
});

Deno.test("entry boundary: invalid names reject before entry/cache/backing/judgment operations, and want rejection is atomic", async () => {
  const hosts = { h: "127.0.0.1:1", flat: "folder:/tmp" }, rig = await mkStateRig("path-guard", { hosts });
  let reads = 0, writes = 0, queued = 0, cache = 0;
  for (const method of ["entryGet", "entryJoined", "fileInfo", "entryDims", "inputCacheGet"]) {
    const original = rig.store[method].bind(rig.store);
    rig.store[method] = (...args) => { reads++; return original(...args); };
  }
  for (const method of ["judgmentPatch", "entryHide"]) {
    const original = rig.store[method].bind(rig.store);
    rig.store[method] = (...args) => { writes++; return original(...args); };
  }
  rig.cache.get = () => { cache++; throw new Error("invalid name reached cache"); };
  rig.cache.has = () => { cache++; throw new Error("invalid name reached cache"); };
  const router = makeRouter({ ...rig, prefetch: { feed() { queued++; return 0; } } });
  try {
    for (const name of bad.filter((x) => typeof x === "string" && x)) {
      const entry = `http://x/api/collections/h/entries/${encodeURIComponent(name)}`;
      for (const [method, suffix] of [["GET", ""], ["GET", "/bytes"], ["HEAD", "/bytes"], ["DELETE", ""], ["PATCH", "/judgment"]]) {
        const result = await router.handle(new Request(entry + suffix, { method, ...(method === "PATCH" ? { body: "{}" } : {}) }));
        assertEquals(result.status, 400, `${method} ${name}`);
      }
      assertEquals(await rig.ingest.ensure("h", name), { status: 400 });
      assertEquals(await rig.ingest.dims("h", name), { status: 400, dims: null });
      await assertRejects(() => rig.ingest.ensureBytes("h", name, new Uint8Array([1])));
      rig.ingest.scheduleRevalidate("h", name); await rig.ingest.revalidateNow("h", name);
    }
    for (const files of [["valid.png", "../bad.png"], ["valid.png", null], ["valid.png", 7]]) {
      assertEquals((await router.handle(new Request("http://x/api/collections/h/want", { method: "POST", body: JSON.stringify({ files }) }))).status, 400);
    }
    for (const method of ["GET", "HEAD", "DELETE", "PATCH"]) {
      assertEquals((await router.handle(new Request(`http://x/api/collections/h/entries/bad%escape${method === "HEAD" ? "/bytes" : method === "PATCH" ? "/judgment" : ""}`, { method, ...(method === "PATCH" ? { body: "{}" } : {}) }))).status, 400);
    }
    assertEquals((await router.handle(new Request("http://x/api/collections/flat/entries/a%2Fimage.png/bytes"))).status, 400);
    assertEquals([reads, writes, queued, cache], [0, 0, 0, 0]);
    const literal = "a/literal%2F#name: café.png";
    const result = await router.handle(new Request(`http://x/api/collections/h/entries/${encodeURIComponent(literal)}`));
    assertEquals((await result.json()).name, literal);
    assertEquals(reads, 1, "exactly one lookup after one decode of the full name segment");
  } finally { await rig.close(); }
});

Deno.test("entry addressing: same leaf, distinct real pixels/dims/stamps/judgments/cache states; nested input keeps its own type", async () => {
  const bodies = new Map([
    ["output:image.png", testPng(2, 3, [255, 0, 0, 255])],
    ["output:a/image.png", testPng(4, 5, [0, 255, 0, 255])],
    ["output:b/image.png", testPng(6, 7, [0, 0, 255, 255])],
    ["input:inputs/deep/image.png", testPng(8, 9)],
    ["output:a/literal%2F#name: café.png", testPng(10, 11)],
  ]);
  const calls = [], stamps = new Map();
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1" }, (req) => {
    const url = new URL(req.url), name = url.searchParams.get("filename"), subfolder = url.searchParams.get("subfolder") ?? "";
    assertEquals(name.includes("/"), false, "transport filename is a leaf, never an encoded hierarchy");
    const key = `${url.searchParams.get("type")}:${subfolder ? subfolder + "/" : ""}${name}`;
    calls.push({ key, method: req.method, range: req.headers.get("range") });
    const bytes = bodies.get(key);
    if (!bytes) return new Response(null, { status: 404 });
    const headers = { ETag: `"${stamps.get(key) ?? 0}"`, "Content-Length": String(bytes.length), "Content-Type": "image/png" };
    if (req.method === "HEAD") return new Response(null, { headers });
    if (req.headers.has("range")) return new Response(bytes.subarray(0, 64), { status: 206, headers: { ...headers, "Content-Length": "64" } });
    return new Response(bytes, { headers });
  });
  const address = `127.0.0.1:${server.addr.port}`, hosts = { h: address }, rig = await mkStateRig("nested-bytes", { hosts });
  const router = makeRouter({ ...rig });
  try {
    const names = ["image.png", "a/image.png", "b/image.png"];
    for (let i = 0; i < names.length; i++) {
      const name = names[i], expected = { width: 2 + i * 2, height: 3 + i * 2 };
      assertEquals((await rig.ingest.dims("h", name)).dims, expected);
      const result = await rig.ingest.ensure("h", name);
      assertEquals(result.bytes, bodies.get(`output:${name}`));
      rig.store.judgmentPatch("h", name, { notes: { pos: name }, bookmark: i === 1 });
      assertEquals(rig.store.judgmentGet("h", name).notes.pos, name);
      const head = await router.handle(new Request(`http://x/api/collections/h/entries/${encodeURIComponent(name)}/bytes`, { method: "HEAD" }));
      assertEquals(Number(head.headers.get("content-length")), result.bytes.length);
    }
    assertEquals(new Set(names.map((name) => rig.store.hashFor("h", name))).size, 3);
    const literal = "a/literal%2F#name: café.png";
    assertEquals((await rig.ingest.ensure("h", literal)).bytes, bodies.get(`output:${literal}`));
    assertEquals((await rig.ingest.ensure("h", "inputs/deep/image.png", "input")).bytes, bodies.get("input:inputs/deep/image.png"));
    assert(calls.some((x) => x.key === "output:a/image.png" && x.range === "bytes=0-65535"));
    assert(calls.some((x) => x.key === "input:inputs/deep/image.png" && x.method === "HEAD"));
    const before = rig.store.hashFor("h", "a/image.png");
    bodies.set("output:a/image.png", testPng(12, 13, [255, 255, 0, 255])); stamps.set("output:a/image.png", 1);
    await rig.ingest.revalidateNow("h", "a/image.png");
    assert(before !== rig.store.hashFor("h", "a/image.png"));
    assertEquals(rig.store.entryDims("h", "a/image.png"), { width: 12, height: 13 });
    assertEquals(rig.store.entryDims("h", "b/image.png"), { width: 6, height: 7 });
    assertEquals(rig.store.feedbackExport("h").entries["b/image.png"].notes.pos, "b/image.png");
  } finally { await rig.close(); await server.shutdown(); }
});

Deno.test("delete: AssetsPlus receives full relpath; history hide matches output parent and never a sibling or input", async () => {
  const posts = [];
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1" }, async (req) => {
    if (req.method === "POST") {
      const body = await req.json(); posts.push({ path: new URL(req.url).pathname, body });
      return Response.json({ removed: body.relpaths ?? [], failed: [] });
    }
    return Response.json({
      sibling: { outputs: { "1": { images: [{ type: "output", subfolder: "b", filename: "image.png" }] } } },
      input: { outputs: { "1": { images: [{ type: "input", subfolder: "a", filename: "image.png" }] } } },
      correct: { outputs: { "1": { images: [{ type: "output", subfolder: "a", filename: "image.png" }] } } },
    });
  });
  const address = `127.0.0.1:${server.addr.port}`;
  try {
    assertEquals(await comfy.remove(address, "a/image.png"), { ok: true, mode: "trash" });
    assertEquals(posts[0].body, { relpaths: ["a/image.png"], mode: "trash" });
    assertEquals(await comfy.historyDelete(address, "a/image.png"), true);
    assertEquals(posts[1].body, { delete: ["correct"] });
  } finally { await server.shutdown(); }
});
