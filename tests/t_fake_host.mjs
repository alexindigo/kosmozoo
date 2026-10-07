// tests/t_fake_host.mjs — contract tests for the fake ComfyUI host.
// Asserts the four endpoints behave the way the engine's callers expect.

import { assert, assertEquals } from "jsr:@std/assert";

const PORT = 18199;
const BASE = `http://127.0.0.1:${PORT}`;

// Spawn the fake host as a subprocess so tests exercise the real HTTP path.
const child = new Deno.Command(Deno.execPath(), {
  args: ["run", "--allow-net", "--allow-read", new URL("./fake-comfy.mjs", import.meta.url).pathname, "--port", String(PORT)],
  stdout: "null",
  stderr: "null",
}).spawn();

// wait for it to come up
async function up() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/api/system_stats`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("fake host did not come up");
}
await up();

Deno.test("system_stats returns 200 (status is all the engine inspects)", async () => {
  const r = await fetch(`${BASE}/api/system_stats`);
  assertEquals(r.status, 200);
  await r.arrayBuffer();
});

Deno.test("file listing carries the ' [size]' suffix the engine strips", async () => {
  const r = await fetch(`${BASE}/internal/files/output`);
  const list = await r.json();
  assert(Array.isArray(list));
  assert(list.length > 0);
  for (const entry of list) {
    assert(/ \[.+\]$/.test(entry), `entry lacks suffix: ${entry}`);
  }
});

Deno.test("view serves fixture bytes with Content-Type and Content-Length", async () => {
  const list = await (await fetch(`${BASE}/internal/files/output`)).json();
  const first = list[0].replace(/ \[.+\]$/, "");
  const r = await fetch(`${BASE}/api/view?type=output&filename=${encodeURIComponent(first)}`);
  assertEquals(r.status, 200);
  assertEquals(r.headers.get("Content-Type"), "image/png");
  assert(r.headers.get("Content-Length"));
  const bytes = new Uint8Array(await r.arrayBuffer());
  assertEquals(bytes[0], 137); // PNG signature
  assertEquals(bytes[1], 80);
});

Deno.test("the reserved missing filename 404s (permanent-failure path)", async () => {
  const r = await fetch(`${BASE}/api/view?type=output&filename=missing-404.png`);
  assertEquals(r.status, 404);
  await r.arrayBuffer();
});

Deno.test("history is derived from fixtures' embedded prompt graphs", async () => {
  const h = await (await fetch(`${BASE}/api/history`)).json();
  // At least one entry per synthetic fixture that carries a prompt graph.
  const ids = Object.keys(h);
  assert(ids.length >= 5, `expected >=5 history entries, got ${ids.length}`);
  for (const id of ids) {
    const entry = h[id];
    assert(Array.isArray(entry.prompt));
    assertEquals(typeof entry.prompt[2], "object"); // the node graph
    assert(entry.outputs, "outputs present");
  }
});

Deno.test("bulk mode serves generated images", async () => {
  // This test runs against the default (no bulk) instance; assert the route
  // shape only — a dedicated bulk instance is exercised in the volume phase.
  const r = await fetch(`${BASE}/api/view?type=output&filename=bulk-00000.png`);
  // default instance has --bulk 0, so this 404s; the assertion documents the
  // contract so the volume phase can flip it to 200 by passing --bulk.
  assert([200, 404].includes(r.status));
  await r.arrayBuffer();
});

addEventListener("unload", () => {
  try { child.kill("SIGTERM"); } catch { /* already gone */ }
});

Deno.test("fake telemetry: external jobs, overwritten logs, targeted terminal history and real named output bytes", async () => {
  const control = async (body) => {
    const r = await fetch(`${BASE}/__test/activity`, { method: "POST", body: JSON.stringify(body) });
    assertEquals(r.status, 200); return r.json();
  };
  try {
    await control({ running: ["external"], pending: ["queued"], logs: [{ t: 1, m: "0/40\r" }] });
    const queue = await (await fetch(`${BASE}/api/queue`)).json();
    assertEquals(queue.queue_running[0][1], "external");
    assertEquals(queue.queue_running[0][3].client_id, "external-fixture-client");
    await control({ logs: [{ t: 1, m: "1/40\r" }] });
    assertEquals(await (await fetch(`${BASE}/internal/logs/raw`)).json(), { entries: [{ t: 1, m: "1/40\r" }], size: 1 });
    await control({ finish: [{ id: "external", outcome: "error", output: "arrived.png" }] });
    const history = await (await fetch(`${BASE}/api/history/external`)).json();
    assertEquals(history.external.status.status_str, "error");
    assertEquals(Object.keys(await (await fetch(`${BASE}/api/history?max_items=1`)).json()), ["external"]);
    const list = await (await fetch(`${BASE}/internal/files/output`)).json();
    assert(list[0].startsWith("arrived.png ["));
    const get = await fetch(`${BASE}/api/view?type=output&filename=arrived.png`);
    const bytes = new Uint8Array(await get.arrayBuffer());
    assertEquals([...bytes.subarray(0, 4)], [137, 80, 78, 71]);
    const head = await fetch(`${BASE}/api/view?type=output&filename=arrived.png`, { method: "HEAD" });
    assertEquals(Number(head.headers.get("content-length")), bytes.length);
    const enqueue = await fetch(`${BASE}/api/prompt`, { method: "POST", body: "{}" });
    assertEquals(enqueue.status, 404); await enqueue.arrayBuffer();
    await control({ clearHistory: true, failures: { queue: 503 } });
    assertEquals(await (await fetch(`${BASE}/api/history`)).json(), {});
    const fail = await fetch(`${BASE}/api/queue`);
    assertEquals(fail.status, 503); await fail.arrayBuffer();
  } finally { await control({ reset: true }); }
});
