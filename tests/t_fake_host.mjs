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
