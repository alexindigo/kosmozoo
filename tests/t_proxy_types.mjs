// tests/t_proxy_types.mjs — the bytes proxy maps octet-stream upstreams to a
// renderable Content-Type by extension (SVGs would otherwise not render).

import { assertEquals } from "jsr:@std/assert";
import { makeRouter } from "../src/routes.mjs";
import { Settings } from "../src/settings.mjs";
import { Store } from "../src/store.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKE_PORT = 18271;
const FAKE = `127.0.0.1:${FAKE_PORT}`;

const child = new Deno.Command(Deno.execPath(), {
  args: ["run", "--allow-net", "--allow-read", new URL("./fake-comfy.mjs", import.meta.url).pathname, "--port", String(FAKE_PORT)],
  stdout: "null", stderr: "null",
}).spawn();

async function up() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://${FAKE}/api/system_stats`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("fake host did not come up");
}
await up();

Deno.test("proxy: SVG upstream (octet-stream) is served as image/svg+xml", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-proxy-"));
  const settings = await Settings.open(dir);
  const store = await Store.open(dir, join(dir, "feedback.json"));
  const router = makeRouter({ hosts: { fake: FAKE }, store, settings, plugins: null });

  const r = await router.handle(new Request("http://x/api/images/fake:logo.svg/bytes"));
  assertEquals(r.status, 200);
  assertEquals(r.headers.get("Content-Type"), "image/svg+xml");
  const body = await r.text();
  assertEquals(body.slice(0, 60).includes("<svg"), true);
  await rm(dir, { recursive: true });
});

Deno.test("proxy: PNG keeps its upstream Content-Type", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-proxy2-"));
  const settings = await Settings.open(dir);
  const store = await Store.open(dir, join(dir, "feedback.json"));
  const router = makeRouter({ hosts: { fake: FAKE }, store, settings, plugins: null });
  const r = await router.handle(new Request("http://x/api/images/fake:flux-basic.png/bytes"));
  assertEquals(r.status, 200);
  assertEquals(r.headers.get("Content-Type"), "image/png");
  await r.arrayBuffer();
  await rm(dir, { recursive: true });
});

addEventListener("unload", () => { try { child.kill("SIGTERM"); } catch {} });
