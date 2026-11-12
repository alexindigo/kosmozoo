// tests/helpers/fake-comfy-inline.mjs — the shared inline ComfyUI stub for
// unit tests: /api/view with a caller-controlled ETag/body, HEAD handled,
// Range honored (206), every full read recorded. Replaces the hand-rolled
// per-file stub servers.
//
//   const stub = fakeComfyInline({ etag: '"e1"', body: "v1" });
//   … point hosts at stub.addr …
//   await stub.close();

import { readFile } from "node:fs/promises";

// `roots` ({ input, output, temp } -> { bytes, etag }) makes /api/view resolve
// exactly one ComfyUI root per `type`, as the real server does: unknown types
// are 400 and a missing root file is 404, never another root's bytes. `gate`
// (async) runs before a root read so tests can retire a source mid-flight.
export function fakeComfyInline({ etag = '"e1"', body = "v1", fixture = null, roots = null, gate = null } = {}) {
  const state = { etag, body, reads: [], status: 200, roots };
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1" }, async (req) => {
    const url = new URL(req.url);
    if (url.pathname !== "/api/view") return new Response("nf", { status: 404 });
    if (state.status !== 200) return new Response("boom", { status: state.status });
    const filename = url.searchParams.get("filename") ?? "", subfolder = url.searchParams.get("subfolder") ?? "";
    const name = subfolder ? `${subfolder}/${filename}` : filename;
    let file = null, type = null;
    if (state.roots) {
      type = url.searchParams.get("type") ?? "output";
      if (!["input", "output", "temp"].includes(type)) return new Response("bad type", { status: 400 });
      file = state.roots[type]?.[name];
      if (!file) return new Response("nf", { status: 404 });
    }
    const headers = { ETag: file?.etag ?? state.etag, "Content-Type": "image/png",
      ...(file ? { "Content-Length": String(file.bytes.length) } : {}) };
    if (req.method === "HEAD") return new Response(null, { headers });
    if (gate && type) await gate({ type, name });
    const bytes = file ? file.bytes : fixture
      ? await readFile(new URL(`../fixtures/${fixture}`, import.meta.url).pathname)
      : new TextEncoder().encode(state.body);
    const range = req.headers.get("range");
    const m = range && /^bytes=(\d+)-(\d+)$/.exec(range);
    if (m) {
      const start = Number(m[1]);
      const end = Math.min(Number(m[2]) + 1, bytes.length);
      return new Response(bytes.subarray(start, end), {
        status: 206,
        headers: { ...headers, "Content-Length": String(end - start), "Content-Range": `bytes ${start}-${end - 1}/${bytes.length}` },
      });
    }
    state.reads.push(type ? `${type}:${name}` : name);
    return new Response(bytes, { headers });
  });
  return {
    state,
    server,
    addr: `127.0.0.1:${server.addr.port}`,
    close: () => server.shutdown(),
  };
}
