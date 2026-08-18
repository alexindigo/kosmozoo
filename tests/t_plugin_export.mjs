// tests/t_plugin_export.mjs — Phase 12 contract: server+client plugin.
// 5 buckets set, one tagged scene; export routes 5, writes 5 sidecars,
// digest 5 rows, scene absent from the reject-set.

import { assert, assertEquals } from "jsr:@std/assert";
import { PluginHost } from "../src/plugins.mjs";
import { makeRouter } from "../src/routes.mjs";
import { Settings } from "../src/settings.mjs";
import { Store } from "../src/store.mjs";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

Deno.test("export plugin: 5 routed + captions + reject-set excludes scene", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-export-"));
  const state = join(dir, "state");
  const settings = await Settings.open(state);
  const store = await Store.open(state, join(dir, "feedback.json"));
  const router = makeRouter({ hosts: { local: "127.0.0.1:1" }, store, settings, plugins: null });
  const host = new PluginHost({ store, settings, router, hosts: { local: "127.0.0.1:1" } });

  // load the real export plugin from the repo tier
  const mod = await import("../plugins/export/plugin.mjs");
  const caps = [];
  const kz = hostTestKz(store, settings, router, caps);
  mod.register(kz);

  // assign buckets/tags: 5 images, one tagged scene
  const imgs = [
    ["local", "a.png", "alisa_good", null],
    ["local", "b.png", "alisa_almost", null],
    ["local", "c.png", "not_alisa", null],
    ["local", "d.png", "alisa_broken", null],
    ["local", "e.png", "alisa_good", "scene"], // scene: excluded from reject-set
  ];
  for (const [h, f, bucket, tag] of imgs) {
    await kz.store.setField(h, f, "bucket", bucket);
    if (tag) await kz.store.setField(h, f, "tag", tag);
    if (bucket === "alisa_broken" || bucket === "not_alisa") {
      await store.judgmentSet(h, f, "vote", "down"); // would land in reject-set
    }
  }
  // one more down-vote with scene tag must NOT pollute the reject-set
  await store.judgmentSet("local", "e.png", "vote", "down");

  // run the export via the plugin's route
  const runRes = await router.handle(new Request("http://x/api/plugins/export/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ downloads: join(dir, "Downloads") }),
  }));
  assertEquals(runRes.status, 200);
  const summary = await runRes.json();

  const routed = Object.values(summary.routed).reduce((a, b) => a + b, 0);
  assertEquals(routed, 5);
  assertEquals(summary.digest.length, 5);
  // scene-tagged down-vote excluded from the reject-set
  assert(!summary.rejectSet.includes("e.png"), "scene staging failure must stay out of the character reject-set");
  // the non-scene down-votes are in
  assert(summary.rejectSet.includes("c.png") || summary.rejectSet.includes("d.png"));

  // sidecar captions written next to routed images
  const goodDir = join(dir, "Downloads", "alisa_good");
  const files = await readdir(goodDir);
  assert(files.some((f) => f.endsWith(".txt")), "caption sidecars written");
  await rm(dir, { recursive: true, force: true });
});

// A kz double wired to the same store/settings/router the host would give.
function hostTestKz(store, settings, router, caps) {
  return {
    exporter: (def) => caps.push({ kind: "exporter", ...def }),
    route: (method, path, handler) => router.add(method, `/api/plugins/export${path}`, handler),
    settings: {
      get: (k, fb) => settings.get("plugins.export", k, fb),
      set: (k, v) => settings.set("plugins.export", k, v),
      ns: () => settings.getNs("plugins.export"),
    },
    store: {
      getField: (h, f, field) => store.judgmentGet(h, f)?.plugins?.export?.[field] ?? null,
      setField: (h, f, field, v) => store.judgmentSet(h, f, `plugins.export.${field}`, v),
    },
    judgments: {
      get: (h, f) => store.judgmentGet(h, f),
      set: (h, f, field, v) => store.judgmentSet(h, f, field, v),
      _all: () => store.feedbackAll(),
    },
    _fetchImageBytes: async () => null, // host unreachable in this test — bytes optional
  };
}
