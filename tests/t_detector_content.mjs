import { assertEquals, assertRejects } from "jsr:@std/assert";
import { PluginHost } from "../src/plugins.mjs";
import { makeRouter } from "../src/routes.mjs";
import { Ingest } from "../src/ingest.mjs";
import { sha256 } from "../src/cache.mjs";
import { mkStateRig } from "./helpers/rig.mjs";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

// The service observes bytes obtained by the real plugin host + Ingest/cache,
// not a mocked content port. Same-name input/output is the original regression.
Deno.test("detector content: per-kind cached/read-through bytes and expected hash", async () => {
  let inheritedReads = 0;
  const prototype = Object.defineProperty({}, "inherited", { get() {
    inheritedReads++;
    throw new Error("inherited host address must not be read");
  } });
  const hosts = Object.assign(Object.create(prototype), { images: "fake:8188" });
  const rig = await mkStateRig("detector-content", { hosts });
  const enc = new TextEncoder(), bodies = [], reads = [];
  const svc = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, async req => {
    if (new URL(req.url).pathname === "/health") return Response.json({ model_ready: true, deadline_ms: 1000, model: "fixture" });
    bodies.push(await req.text());
    return Response.json({ w: 2, h: 3, faces: [] });
  });
  let release, entered;
  const enteredRead = new Promise(r => entered = r);
  const heldRead = new Promise(r => release = r);
  const ingest = new Ingest(rig.store, hosts, {
    cache: rig.cache, capture: rig.inventory.capture, isCurrent: rig.inventory.isCurrent,
    backingFor: () => ({
      async read(_addr, name, kind) {
        reads.push([name, kind]);
        if (name === "held.png") { entered(); await heldRead; }
        return { status: 200, body: enc.encode(`${kind}:${name}`) };
      },
      stat: () => ({ stamp: "1" }),
    }),
  });
  const routes = new Map();
  await rig.settings.set("plugins.detector", "serviceUrl", `http://127.0.0.1:${svc.addr.port}`);
  const host = new PluginHost({ ...rig, ingest, route: (method, path, fn) => routes.set(`${method} ${path}`, fn) });
  await host.load("detector", fileURLToPath(new URL("../plugins/detector", import.meta.url)));
  const detect = routes.get("POST /api/plugins/detector/detect");
  const request = value => detect(new Request("http://engine/detect", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value),
  }));
  try {
    const output = enc.encode("cached-output"), input = enc.encode("cached-input");
    await ingest.ensureBytes("images", "same.png", output);
    await ingest.ensureBytes("images", "same.png", input, { kind: "input" });
    const hash = await sha256(input);
    let res = await request({ collection: "images", name: "same.png", kind: "input", expectedHash: hash });
    assertEquals(res.status, 200);
    assertEquals(bodies, ["cached-input"]);
    assertEquals((await res.json()).image, { collection: "images", name: "same.png", kind: "input", hash });
    res = await request({ collection: "images", name: "same.png" });
    assertEquals(res.status, 200);
    await res.json();
    assertEquals(bodies, ["cached-input", "cached-output"]);
    assertEquals(reads, []);

    res = await request({ collection: "images", name: "fresh.png", kind: "input" });
    assertEquals(res.status, 200);
    assertEquals((await res.json()).image.hash, await sha256(enc.encode("input:fresh.png")));
    assertEquals(reads, [["fresh.png", "input"]]);
    assertEquals(bodies.at(-1), "input:fresh.png");
    const shared = await Promise.all([request({ collection: "images", name: "fresh.png" }),
      request({ collection: "images", name: "fresh.png" })]);
    for (const response of shared) {
      assertEquals(response.status, 200);
      assertEquals((await response.json()).image.hash, await sha256(enc.encode("output:fresh.png")));
    }
    assertEquals(reads, [["fresh.png", "input"], ["fresh.png", "output"]], "read-through remains single-flight per kind");
    assertEquals(bodies.slice(-2), ["output:fresh.png", "output:fresh.png"]);
    res = await request({ collection: "missing", name: "same.png" });
    assertEquals(res.status, 404);
    await res.json();
    res = await request({ collection: "inherited", name: "same.png" });
    assertEquals(res.status, 404);
    await res.json();
    assertEquals(inheritedReads, 0, "own membership precedes host-address reads");
    const count = bodies.length;
    res = await request({ collection: "images", name: "same.png", kind: "input", expectedHash: await sha256(output) });
    assertEquals(res.status, 409);
    await res.json();
    await ingest.ensureBytes("images", "same.png", enc.encode("replacement-input"), { kind: "input" });
    res = await request({ collection: "images", name: "same.png", kind: "input", expectedHash: hash });
    assertEquals(res.status, 409, "same-name replacement cannot satisfy the old accepted hash");
    await res.json();
    res = await detect(new Request("http://engine/detect", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: "{not-json" }));
    assertEquals(res.status, 400);
    await res.json();
    for (const value of [null, [], {}, { collection: 7, name: "same.png" },
      { collection: "images", name: "../x.png" }, { collection: "images", name: "same.png", kind: "temp" },
      { collection: "images", name: "same.png", expectedHash: "wrong" }]) {
      res = await request(value);
      assertEquals(res.status, 400);
      await res.json();
    }
    assertEquals(bodies.length, count, "rejected addresses/hash never reach inference");

    const pending = request({ collection: "images", name: "held.png", kind: "input" });
    await enteredRead;
    delete hosts.images;
    rig.inventory.capture("images");
    release();
    res = await pending;
    assertEquals(res.status, 409);
    await res.json();
    assertEquals(bodies.length, count, "retired source never reaches inference");
    assertEquals(rig.store.inputCacheGet("images", "held.png"), null);
  } finally {
    release();
    await svc.shutdown();
    await rig.close();
  }
});

Deno.test("detector relocation: actual standalone plugin loads and routes without adjacent engine src", async () => {
  const rig = await mkStateRig("detector-relocated", { hosts: { images: "fake:8188" } });
  const installed = join(rig.dir, "installed", "plugins", "detector");
  const bodies = [];
  let result = { w: 4, h: 5, faces: [
    { bbox: [-1, 0, 2, 3], score: 1.01, kps: [[1, 2, 1.02]] },
    { bbox: [1, 1, 3, 4], score: null, kps: [] },
  ] };
  const svc = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, async req => {
    if (new URL(req.url).pathname === "/health") return Response.json({ model_ready: true, deadline_ms: 1000, model: "relocated-fixture" });
    bodies.push(await req.text());
    return Response.json(result);
  });
  try {
    await mkdir(installed, { recursive: true });
    await writeFile(join(installed, "plugin.mjs"), await readFile(new URL("../plugins/detector/plugin.mjs", import.meta.url)));
    assertEquals(await readdir(installed), ["plugin.mjs"], "no engine source copied into plugin");
    const absent = await assertRejects(() => stat(join(installed, "..", "..", "src")), Error);
    assertEquals(absent.code, "ENOENT");
    const routes = [];
    const host = new PluginHost({ ...rig, route: (method, path, handler) => routes.push({ method, path, handler }) });
    await host.load("detector", installed);
    assertEquals(host.list()[0].error, undefined, "relocated module registers successfully");
    const router = makeRouter({ ...rig, plugins: host });
    for (const { method, path, handler } of routes) router.add(method, path, handler);
    const url = `http://127.0.0.1:${svc.addr.port}`;
    await rig.settings.set("plugins.detector", "serviceUrl", url);
    await rig.ingest.ensureBytes("images", "same.png", new TextEncoder().encode("output"));
    const bytes = new TextEncoder().encode("input"), hash = await sha256(bytes);
    await rig.ingest.ensureBytes("images", "same.png", bytes, { kind: "input" });
    const address = { collection: "images", name: "same.png", kind: "input", expectedHash: hash };
    const detect = value => router.handle(new Request("http://engine/api/plugins/detector/detect", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value),
    }));
    let response = await router.handle(new Request("http://engine/api/plugins/detector/status"));
    assertEquals((await response.json()).state, "ready");
    response = await detect(address);
    assertEquals(response.status, 200);
    assertEquals(await response.json(), { ...result,
      image: { collection: "images", name: "same.png", kind: "input", hash },
      detector: { serviceUrl: url, model: "relocated-fixture" } });
    assertEquals(bodies, ["input"]);
    response = await detect({ ...address, expectedHash: "invalid" });
    assertEquals(response.status, 400);
    await response.json();
    assertEquals(bodies.length, 1, "injected canonical hash validator rejects before inference");
    response = await router.handle(new Request("http://engine/api/plugins/detector/detect", {
      method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: bytes,
    }));
    assertEquals(response.status, 200);
    assertEquals((await response.json()).image, { hash }, "injected byte hasher works after relocation");
    result = { error: "invalid image" };
    response = await detect(address);
    assertEquals(response.status, 502, "injected result decoder rejects HTTP 200 worker errors");
    assertEquals((await response.json()).reason.includes("invalid image"), true);
  } finally { await svc.shutdown(); await rig.close(); }
});
