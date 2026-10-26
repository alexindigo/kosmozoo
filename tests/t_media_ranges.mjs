import { assertEquals } from "jsr:@std/assert";
import { makeRouter } from "../src/routes.mjs";
import { mkStateRig } from "./helpers/rig.mjs";
import { read } from "../src/backings/comfy.mjs";

Deno.test("media ranges: entry and hash routes share exact single-range/validator semantics", async () => {
  const rig = await mkStateRig("media-ranges", { hosts: { c: "folder:/unused" } });
  const bytes = await Deno.readFile(new URL("./fixtures/media/workflow.mp4", import.meta.url));
  try {
    const hash = await rig.ingest.ensureBytes("c", "video.mp4", bytes);
    const router = makeRouter(rig);
    // Isolate range serving from source revalidation (cache already owns bytes).
    rig.ingest.scheduleRevalidate = () => {};
    for (const path of ["collections/c/entries/video.mp4", `content/${hash}`]) {
      const request = headers => router.handle(new Request(`http://x/api/${path}/bytes`, { headers }));
      for (const [range, start, end] of [["bytes=0-99", 0, 99], ["bytes=20-", 20, bytes.length - 1],
        ["bytes=-31", bytes.length - 31, bytes.length - 1], ["bytes=5-999999", 5, bytes.length - 1]]) {
        const response = await request({ Range: range });
        assertEquals(response.status, 206);
        assertEquals(response.headers.get("Content-Range"), `bytes ${start}-${end}/${bytes.length}`);
        assertEquals(response.headers.get("Content-Length"), String(end - start + 1));
        assertEquals(response.headers.get("Accept-Ranges"), "bytes");
        assertEquals(response.headers.get("Content-Type"), "video/mp4");
        assertEquals(new Uint8Array(await response.arrayBuffer()), bytes.subarray(start, end + 1));
      }
      for (const range of ["bytes=999999-", "bytes=20-10", "bytes=-0"]) {
        const response = await request({ Range: range });
        assertEquals(response.status, 416); assertEquals(response.headers.get("Content-Range"), `bytes */${bytes.length}`);
        assertEquals((await response.arrayBuffer()).byteLength, 0);
      }
      for (const headers of [{ Range: "bytes=0-2,5-8" }, { Range: "items=0-2" },
        { Range: "bytes=0-99", "If-Range": '"stale"' }]) {
        const response = await request(headers);
        assertEquals(response.status, 200); assertEquals(new Uint8Array(await response.arrayBuffer()), bytes);
      }
      const fresh = await request({ Range: "bytes=0-99", "If-None-Match": `"${hash}"` });
      assertEquals(fresh.status, 304);
      const matched = await request({ Range: "bytes=0-99", "If-Range": `"${hash}"` });
      assertEquals(matched.status, 206); await matched.arrayBuffer();
    }
  } finally { await rig.close(); }
});

Deno.test("comfy bytes: progress resets idle deadline; stalled bodies fail; cancel releases resources", async () => {
  let timer;
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, req => {
    const name = new URL(req.url).searchParams.get("filename");
    let count = 0;
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([count++]));
        if (name === "progress.mp4") timer = setInterval(() => {
          controller.enqueue(new Uint8Array([count++]));
          if (count === 8) { clearInterval(timer); controller.close(); }
        }, 30);
      },
      cancel() { clearInterval(timer); },
    }));
  });
  const address = `127.0.0.1:${server.addr.port}`;
  try {
    const progress = await read(address, "progress.mp4", "output", { idleMs: 150 });
    assertEquals([...new Uint8Array(await new Response(progress.body).arrayBuffer())], [0, 1, 2, 3, 4, 5, 6, 7]);
    const stalled = await read(address, "stall.mp4", "output", { idleMs: 30 });
    let failed = false;
    try { await new Response(stalled.body).arrayBuffer(); } catch { failed = true; }
    assertEquals(failed, true);
    const cancelled = await read(address, "cancel.mp4", "output", { idleMs: 30 });
    await cancelled.body.cancel();
  } finally { clearInterval(timer); await server.shutdown(); }
});
