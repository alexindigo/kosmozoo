// tests/t_detector_protocol.mjs — the detector service's protocol discipline
// (F11/F12): the ready handshake is consumed (no off-by-one), request ids
// increment and response ids are asserted, /health reports model_ready.
//
// Drives the REAL detect_service.py over HTTP against a stub worker.
// Requires python3 on the runner — SKIPPED in the docker unit image (no
// python there); runs on any host with python3 (and any future CI image
// that carries it).

import { assert, assertEquals } from "jsr:@std/assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
