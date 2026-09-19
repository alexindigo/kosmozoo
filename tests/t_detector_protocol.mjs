// tests/t_detector_protocol.mjs — the detector service's protocol discipline
// (F11/F12): the ready handshake is consumed (no off-by-one), request ids
// increment and response ids are asserted, /health reports model_ready.
//
// TWO variants:
//   1. the plugin's service protocol (Deno-only, runs everywhere): the
//      deadline comes from /health (never a hand-synced default), an
//      unreachable /health fails "unconfigured", r.ok is checked before
//      .json(), /status mirrors the service honestly.
//   2. the python-backed service test (Deno subprocess would not help — the
//      service itself is python): stays behind `ignore` without python3.

import { assert, assertEquals } from "jsr:@std/assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "../plugins/detector/plugin.mjs";

// --- variant 1: the plugin's service protocol (Deno-only) --------------------

Deno.test("detector plugin: deadline from /health; unconfigured fails 'unconfigured'; r.ok guards", async () => {
  // a mock kz: captures routes + the settings namespace
  const routes = new Map();
  const settingsData = {};
  const kz = {
    settings: {
      get: (k, fb) => settingsData[k] ?? fb,
      set: (k, v) => { settingsData[k] = v; },
      ns: () => ({ ...settingsData }),
    },
    route: (method, path, handler) => routes.set(`${method} ${path}`, handler),
    alignment: () => {},
    content: { bytesForEntry: async () => null },
    reason: (status, error, reason) => Response.json({ error, reason }, { status }),
  };
  register(kz);
  const detect = routes.get("POST /detect");
  const status = routes.get("GET /status");

  // unconfigured: no serviceUrl → 503 "unconfigured", no fetch attempted
  let r = await detect(new Request("http://x/api/plugins/detector/detect", { method: "POST", body: "img" }));
  assertEquals(r.status, 503);
  assertEquals((await r.json()).reason, "unconfigured (no deadline from /health)");
  r = await status(new Request("http://x/api/plugins/detector/status"));
  assertEquals((await r.json()).state, "unconfigured");

  // a service whose /health lies (500): /status is unreachable, /detect
  // refuses instead of guessing a timeout
  let healthStatus = 500;
  const svc = Deno.serve({ port: 0, hostname: "127.0.0.1" }, (req) => {
    const p = new URL(req.url).pathname;
    if (p === "/health") return new Response("no", { status: healthStatus });
    if (p === "/detect") return Response.json({ w: 1, h: 1, faces: [] });
    return new Response("nf", { status: 404 });
  });
  settingsData.serviceUrl = `http://127.0.0.1:${svc.addr.port}`;
  r = await status(new Request("http://x/api/plugins/detector/status"));
  assertEquals((await r.json()).state, "unreachable");
  r = await detect(new Request("http://x/api/plugins/detector/detect", { method: "POST", body: "img" }));
  assertEquals(r.status, 503);
  assertEquals((await r.json()).reason, "unconfigured (no deadline from /health)");

  // a healthy service: the deadline comes from /health (60 s + margin), the
  // detect proxies the JSON, /status reports ready with the SAME deadline
  healthStatus = 200;
  const svc2 = Deno.serve({ port: 0, hostname: "127.0.0.1" }, (req) => {
    const p = new URL(req.url).pathname;
    if (p === "/health") {
      return Response.json({ model_ready: true, model: "stub", deadline_ms: 60_000, stderr_tail: [] });
    }
    if (p === "/detect") return Response.json({ w: 2, h: 3, faces: [{ bbox: [0, 0, 1, 1], score: 0.9, kps: [] }] });
    return new Response("nf", { status: 404 });
  });
  settingsData.serviceUrl = `http://127.0.0.1:${svc2.addr.port}`;
  r = await status(new Request("http://x/api/plugins/detector/status"));
  const st = await r.json();
  assertEquals(st.state, "ready");
  assertEquals(st.deadlineMs, 60_000);
  r = await detect(new Request("http://x/api/plugins/detector/detect", { method: "POST", body: "img" }));
  assertEquals(r.status, 200);
  assertEquals((await r.json()).faces.length, 1);

  await svc.shutdown();
  await svc2.shutdown();
});

// --- variant 2: the python-backed service test (behind ignore) ---------------

function hasPython3() {
  try {
    return new Deno.Command("python3", { args: ["--version"], stdout: "null", stderr: "null" })
      .outputSync().success;
  } catch {
    return false;
  }
}

Deno.test({
  name: "detector protocol: ready handshake consumed; response ids match request ids",
  ignore: !hasPython3(),
  fn: async () => {
    const dir = await mkdtemp(join(tmpdir(), "kz-det-"));
    // a stub worker: ready line, then per request an echo with the id + a
    // payload marker derived from the request's b64 content
    const stub = join(dir, "stub_worker.py");
    await writeFile(stub, `
import sys, json, base64
print(json.dumps({"ready": True}), flush=True)
for line in sys.stdin:
    req = json.loads(line)
    marker = base64.b64decode(req["b64"]).decode()
    print(json.dumps({"id": req["id"], "w": 1, "h": 1, "faces": [], "marker": marker}), flush=True)
`);

    const port = 28471;
    const svc = new Deno.Command("python3", {
      args: [new URL("../plugins/detector/detect_service.py", import.meta.url).pathname, String(port)],
      env: { DETECT_WORKER: stub },
      stdout: "null", stderr: "null",
    }).spawn();

    try {
      // the service consumes the ready line at startup — /health is honest
      let ready = false;
      for (let i = 0; i < 100; i++) {
        try {
          const h = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
          if (h.model_ready) { ready = true; break; }
        } catch { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 100));
      }
      assert(ready, "model_ready after the handshake (the ready line is not a response)");

      // two detects: the FIRST gets the FIRST result (no off-by-one), and the
      // ids track the request order
      const r1 = await (await fetch(`http://127.0.0.1:${port}/detect`, {
        method: "POST", body: "first-image",
      })).json();
      const r2 = await (await fetch(`http://127.0.0.1:${port}/detect`, {
        method: "POST", body: "second-image",
      })).json();
      assertEquals(r1.marker, "first-image");
      assertEquals(r1.id, 1);
      assertEquals(r2.marker, "second-image");
      assertEquals(r2.id, 2);
    } finally {
      try { svc.kill("SIGTERM"); } catch { /* already gone */ }
      await rm(dir, { recursive: true, force: true });
    }
  },
});
