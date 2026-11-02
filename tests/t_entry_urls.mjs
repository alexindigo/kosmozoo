import { assert, assertEquals } from "jsr:@std/assert";
import { api } from "../client/js/api.mjs";
import { inputThumbnail, inputList, uploadInput } from "../client-solid/features/variations/api.js";
import { nodeImages } from "../client-solid/store/fields.js";
import { imageRequestUrl } from "../client-solid/lib/img-measure.js";
import * as comfy from "../src/backings/comfy.mjs";

const names = ["#athena.png", "literal%2F%25.png", "?x&y=1.png", "space café 日本.png", "literal [input].png", "x".repeat(196) + ".png", "nested/# %.png"];
const collection = "source #?% café", origin = { source: collection, address: "127.0.0.1:1", kind: "comfy", epoch: "a", incarnation: 1 };

Deno.test("entry URLs: core, node details, picker/selected thumbnails, priority and retry preserve exact identity", () => {
  for (const name of names) {
    const details = nodeImages({ nodes: [{ type: "LoadImage", inputs: { image: name } }] }, collection)[0];
    for (const [src, kind] of [[api.entryBytesUrl(collection, name), "output"], [api.inputBytesUrl(collection, name), "input"],
      [details.src, "input"], [inputThumbnail(collection, name, origin), "input"], [inputThumbnail(collection, name, origin, "output"), "output"]]) {
      for (const priority of ["foreground", "background"]) {
        const url = new URL(imageRequestUrl(src, priority, "retry"), "http://x");
        assertEquals(decodeURIComponent(url.pathname.split("/")[3]), collection);
        assertEquals(decodeURIComponent(url.pathname.split("/")[5]), name);
        assertEquals(url.searchParams.get("kind") ?? "output", kind);
        if (url.searchParams.has("origin")) assertEquals(JSON.parse(url.searchParams.get("origin")), origin);
        assertEquals(url.hash, "");
      }
    }
  }
});

Deno.test("entry URLs: client requests share one serializer, including metadata, HEAD, judgment, delete, list and upload", async () => {
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = (src, options) => { calls.push({ url: new URL(src, "http://x"), options }); return Promise.resolve(Response.json({ name: "ok" })); };
  try {
    for (const name of names) {
      calls.length = 0;
      await api.entryMeta(collection, name); await api.entrySizeProbe(collection, name);
      await api.setJudgment(collection, name, { vote: 1 }); await api.deleteEntry(collection, name);
      for (const { url } of calls) {
        assertEquals(decodeURIComponent(url.pathname.split("/")[3]), collection);
        assertEquals(decodeURIComponent(url.pathname.split("/")[5]), name); assertEquals(url.hash, "");
      }
    }
    calls.length = 0;
    await inputList(collection, origin); await uploadInput(collection, new FormData(), origin);
    assertEquals(calls.map(({ url }) => decodeURIComponent(url.pathname.split("/")[3])), [collection, collection]);
    assertEquals(calls[0].url.searchParams.get("kind"), "input");
    assertEquals(calls[1].options.method, "POST");
    assertEquals(calls[1].options.headers["X-Kosmozoo-Origin"], JSON.stringify(origin));
  } finally { globalThis.fetch = original; }
});

Deno.test("entry URLs: annotation removed once at listing ingress, engine view URL uses exact leaf/subfolder and kind", async () => {
  const seen = [], bytes = new Uint8Array([1, 2, 3]);
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1" }, req => {
    const url = new URL(req.url);
    if (url.pathname === "/internal/files/input") return Response.json(names.filter(n => !n.includes("/")).map(n => `${n} [input]`));
    seen.push({ name: (url.searchParams.get("subfolder") ? url.searchParams.get("subfolder") + "/" : "") + url.searchParams.get("filename"), kind: url.searchParams.get("type") });
    return new Response(bytes, { headers: { "Content-Type": "image/png" } });
  });
  const addr = `127.0.0.1:${server.addr.port}`;
  try {
    assertEquals(await comfy.list(addr, "input"), names.filter(n => !n.includes("/")));
    for (const name of names) for (const kind of ["input", "output"]) {
      const reply = await comfy.read(addr, name, kind);
      assertEquals(new Uint8Array(await new Response(reply.body).arrayBuffer()), bytes);
      assertEquals(seen.at(-1), { name, kind });
    }
  } finally { await server.shutdown(); }
});

Deno.test("entry URLs: a single client serializer owns entry routes (no parallel template in consumers)", async () => {
  // This architectural check catches reintroduced bypasses, even if their
  // escaping happens to pass today's value matrix.
  async function scan(dir) {
    for await (const entry of Deno.readDir(dir)) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory && entry.name !== "vendor") await scan(path);
      if (!entry.isFile || !/\.(mjs|js|tsx)$/.test(path) || path.endsWith("/entry-url.mjs")) continue;
      assert(!/\/api\/collections\/[^\n]*\/entries/.test(await Deno.readTextFile(path)), path + " bypasses entry URL owner");
    }
  }
  await scan("client/js"); await scan("client-solid");
});
