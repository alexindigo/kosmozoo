// tests/helpers/fake-comfy-inline.mjs — the shared inline ComfyUI stub for
// unit tests: /api/view with a caller-controlled ETag/body, HEAD handled,
// Range honored (206), every full read recorded. Replaces the hand-rolled
// per-file stub servers.
//
//   const stub = fakeComfyInline({ etag: '"e1"', body: "v1" });
//   … point hosts at stub.addr …
//   await stub.close();

import { readFile } from "node:fs/promises";

export function fakeComfyInline({ etag = '"e1"', body = "v1", fixture = null } = {}) {
  const state = { etag, body, reads: [], status: 200 };
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1" }, async (req) => {
    const url = new URL(req.url);
    if (url.pathname !== "/api/view") return new Response("nf", { status: 404 });
    if (state.status !== 200) return new Response("boom", { status: state.status });
    const name = url.searchParams.get("filename") ?? "";
    const headers = { ETag: state.etag, "Content-Type": "image/png" };
    if (req.method === "HEAD") return new Response(null, { headers });
    const bytes = fixture
      ? await readFile(new URL(`../fixtures/${fixture}`, import.meta.url).pathname)
      : new TextEncoder().encode(state.body);
    const range = req.headers.get("range");
    const m = range && /^bytes=(\d+)-(\d+)$/.exec(range);
    if (m) {
      const start = Number(m[1]);
      const end = Math.min(Number(m[2]) + 1, bytes.length);
      return new Response(bytes.subarray(start, end), {
        status: 206,
        headers: { ...headers, "Content-Range": `bytes ${start}-${end - 1}/${bytes.length}` },
      });
    }
    state.reads.push(name);
    return new Response(bytes, { headers });
  });
  return {
    state,
    server,
    addr: `127.0.0.1:${server.addr.port}`,
    close: () => server.shutdown(),
  };
}
