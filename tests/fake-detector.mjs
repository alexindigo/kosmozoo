// Deterministic HTTP service behind the real engine detector plugin. It sees
// actual bytes, not resource names or browser interceptions.
import { parseArgs } from "node:util";
import { testPng } from "./helpers/png.mjs";
import { face } from "./helpers/face-fixtures.mjs";
import { sha256 } from "../src/cache.mjs";

const { values } = parseArgs({ options: { port: { type: "string", default: "18463" }, "fixtures-dir": { type: "string" } } });
const fixtures = {
  "multi-a.png": [face(256, 256, 160, .01), face(75, 75, 32, 100)],
  "multi-b.png": [face(210, 210, 40, 100), face(360, 120, 48, .01)],
  "no-face.png": [],
  "invalid-eyes.png": [{ ...face(240, 240, 70), kps: [] }],
  "single.png": [face(240, 240, 70)],
};
const records = new Map(), files = new Map();
function pixel(faces, x, y) {
  for (const f of faces) {
    const span = f.bbox[2] - f.bbox[0], mx = (f.bbox[0] + f.bbox[2]) / 2, my = (f.bbox[1] + f.bbox[3]) / 2;
    const u = (x - mx) / (span / 2), v = (y - my) / (span / 2);
    if (u * u + v * v < .95) {
      if ((Math.abs(u - .5) < .1 || Math.abs(u + .5) < .1) && Math.abs(v) < .1) return [240, 240, 240, 255];
      if (Math.abs(u) < .35 && v > .35 && v < .45) return [40, 80, 180, 255];
      return [112, 136, 168, 255];
    }
  }
  return [24, 28, 36, 255];
}
if (values["fixtures-dir"]) await Deno.mkdir(values["fixtures-dir"], { recursive: true });
for (const [name, faces] of Object.entries(fixtures)) {
  // Distinct records need distinct immutable bytes even when visible geometry
  // is intentionally identical (single face vs missing eye landmarks).
  const bytes = testPng(512, 512, (x, y) => pixel(faces, x, y), null, { fixture: name });
  const hash = await sha256(bytes);
  files.set(name, bytes); records.set(hash, { w: 512, h: 512, faces });
  if (values["fixtures-dir"]) await Deno.writeFile(`${values["fixtures-dir"]}/${name}`, bytes);
}
let config = { delay: 0, fail: false, ready: true }, serial = 0;
const requests = [];
Deno.serve({ hostname: "127.0.0.1", port: Number(values.port) }, async req => {
  const path = new URL(req.url).pathname;
  if (path === "/__test/config" && req.method === "POST") {
    const input = await req.json(); config = { ...config, ...input };
    for (const [hash, result] of Object.entries(input.records ?? {})) records.set(hash, result);
    return Response.json({ ...config, records: undefined });
  }
  if (path === "/__test/requests") return Response.json(requests);
  if (path.startsWith("/fixtures/")) {
    const bytes = files.get(path.slice(10));
    return bytes ? new Response(bytes, { headers: { "content-type": "image/png" } }) : new Response("missing", { status: 404 });
  }
  if (path.endsWith("/health")) return Response.json({ model_ready: config.ready, model: "anime28-fixture", deadline_ms: 10000 });
  if (path.endsWith("/detect") && req.method === "POST") {
    const hash = await sha256(new Uint8Array(await req.arrayBuffer())), captured = { ...config }, id = ++serial;
    const request = { id, hash, path, pending: true }; requests.push(request);
    if (captured.delay) await new Promise(resolve => setTimeout(resolve, captured.delay));
    request.pending = false;
    if (!captured.ready) return Response.json({ id, error: "model loading" }, { status: 422 });
    if (captured.fail) return Response.json({ id, error: "controlled inference failure" }, { status: 422 });
    const result = records.get(hash);
    return result ? Response.json({ id, ...result }) : Response.json({ id, error: "unmapped content hash" }, { status: 422 });
  }
  return new Response("not found", { status: 404 });
});
