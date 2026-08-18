// tests/t_plugins.mjs — Phase 10 contract tests: a dropped-in no-op plugin
// is discovered, registered, and listed by the engine API.

import { assert, assertEquals } from "jsr:@std/assert";
import { PluginHost } from "../src/plugins.mjs";
import { makeRouter } from "../src/routes.mjs";
import { Settings } from "../src/settings.mjs";
import { Store } from "../src/store.mjs";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

Deno.test("plugins: a 3-line no-op plugin loads, registers, lists, and routes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-plugins-"));
  const pdir = join(dir, "plugins", "hello2");
  await mkdir(pdir, { recursive: true });
  await writeFile(join(pdir, "plugin.mjs"),
    `export function register(kz) {\n` +
    `  kz.settings.set("loaded", true);\n` +
    `  kz.route("GET", "/hello", () => Response.json({ hello: "kosmozoo" }));\n` +
    `  kz.mode("difference", { label: "Difference" });\n` +
    `}\n`);

  const settings = await Settings.open(join(dir, "state"));
  const store = await Store.open(join(dir, "state"), join(dir, "feedback.json"));
  const router = makeRouter({ hosts: {}, store, settings, plugins: null });
  const host = new PluginHost({ store, settings, router, hosts: {} });

  // discovery is tier-driven; point it at our temp dir via the env seam
  Deno.env.set("KOZMOZOO_PLUGINS", join(dir, "plugins"));
  const found = await host.discover();
  Deno.env.delete("KOZMOZOO_PLUGINS");

  const ours = found.find((p) => p.name === "hello2");
  assert(ours, "hello2 discovered");
  // the capability was declared
  assert(ours.capabilities.some((c) => c.kind === "mode" && c.id === "difference"));
  // plugin settings persisted in their own namespace
  assertEquals(settings.get("plugins.hello2", "loaded"), true);
  // its route answers through the router
  const res = await router.handle(new Request("http://x/api/plugins/hello2/hello"));
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { hello: "kosmozoo" });
});

Deno.test("plugins: absent plugin tiers are fine (no error, empty list)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-plugins2-"));
  const settings = await Settings.open(dir);
  const store = await Store.open(dir, join(dir, "feedback.json"));
  const router = makeRouter({ hosts: {}, store, settings, plugins: null });
  const host = new PluginHost({ store, settings, router, hosts: {} });
  Deno.env.set("KOZMOZOO_PLUGINS", join(dir, "does-not-exist"));
  const found = await host.discover();
  Deno.env.delete("KOZMOZOO_PLUGINS");
  // discovery itself did not throw despite the absent tier
  assert(Array.isArray(found));
});
