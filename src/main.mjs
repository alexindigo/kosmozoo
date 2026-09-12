// src/main.mjs — engine entry point.
//
// Running kosmozoo stays one `deno run` away:
//   deno run --allow-all src/main.mjs
//
// Environment overrides: KOZMOZOO_PORT (default 2084), KOZMOZOO_HOSTS,
// KOZMOZOO_STATE, KOZMOZOO_FEEDBACK.

import { resolveStateDir, ensureStateDir, CorruptStateError } from "./state.mjs";
import { Settings } from "./settings.mjs";
import { Store } from "./store.mjs";
import { loadHosts } from "./hosts.mjs";
import { makeRouter } from "./routes.mjs";
import { serveStatic } from "./static.mjs";
import { Scraper } from "./scraper.mjs";
import { PluginHost } from "./plugins.mjs";
import { Ingest } from "./ingest.mjs";

const PORT = parseInt(Deno.env.get("KOZMOZOO_PORT") ?? "2084", 10);

// A corrupt state file stops the boot: the bytes were quarantined by
// loadVersioned; the human repairs or removes them and starts again.
let stateDir, settings, store;
try {
  stateDir = await ensureStateDir(resolveStateDir());
  settings = await Settings.open(stateDir);
  store = await Store.open(
    stateDir,
    settings.get("core", "feedbackPath", null)
      ?? Deno.env.get("KOZMOZOO_FEEDBACK")
      ?? `${Deno.env.get("HOME")}/Documents/kosmozoo_feedback.json`,
    { settings },
  );
} catch (e) {
  if (e instanceof CorruptStateError) {
    console.error(`kosmozoo: corrupt state file: ${e.path}`);
    console.error(`kosmozoo: original bytes preserved at: ${e.quarantined}`);
    console.error(`kosmozoo: repair the JSON and move it back, or delete it to start empty — the engine never overwrites an unreadable state file`);
    Deno.exit(1);
  }
  throw e;
}
const hosts = await loadHosts(store); // env seeds first boot, then user-managed
const downloadsDir = Deno.env.get("KOZMOZOO_DOWNLOADS")
  ?? `${Deno.env.get("HOME")}/Downloads`;

const router = makeRouter({ hosts, store, settings, plugins: null, downloadsDir });
const plugins = new PluginHost({ store, settings, router, hosts });
const discovered = await plugins.discover();
router.ctx = { hosts, store, settings, plugins, downloadsDir };

// Background metadata walker — headless, politeness set intact.
const scraper = new Scraper({ hosts, store, settings });
scraper.start();
router.ctx.scraper = scraper;

// Image ingestion — every served byte flows through here.
const ingest = new Ingest(store, hosts);
router.ctx.ingest = ingest;

Deno.serve({ port: PORT }, async (req) => {
  const url = new URL(req.url);
  if (url.pathname.startsWith("/api/")) {
    try {
      return await router.handle(req);
    } catch (e) {
      return Response.json({ error: String(e?.message ?? e) }, { status: 500 });
    }
  }
  // plugin client halves: /plugins/<name>/client.js
  if (url.pathname.startsWith("/plugins/")) {
    return serveStatic(url.pathname); // static.mjs maps this tier
  }
  return serveStatic(url.pathname);
});

console.log(`kosmozoo engine on http://127.0.0.1:${PORT}  (state: ${stateDir})`);
console.log(`hosts: ${Object.keys(hosts).join(", ")}`);
if (discovered.length) {
  console.log(`plugins: ${discovered.map((p) => p.name).join(", ")}`);
}
