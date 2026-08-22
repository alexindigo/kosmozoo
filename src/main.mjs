// src/main.mjs — engine entry point.
//
// Running kosmozoo stays one `deno run` away:
//   deno run --allow-all src/main.mjs
//
// Environment overrides: KOZMOZOO_PORT (default 2084), KOZMOZOO_HOSTS,
// KOZMOZOO_STATE, KOZMOZOO_FEEDBACK.

import { resolveStateDir, ensureStateDir } from "./state.mjs";
import { Settings } from "./settings.mjs";
import { Store } from "./store.mjs";
import { parseHosts, loadHosts } from "./hosts.mjs";
import { makeRouter } from "./routes.mjs";
import { serveStatic } from "./static.mjs";
import { Scraper } from "./scraper.mjs";
import { PluginHost } from "./plugins.mjs";
import { Ingest } from "./ingest.mjs";

const PORT = parseInt(Deno.env.get("KOZMOZOO_PORT") ?? "2084", 10);

const stateDir = await ensureStateDir(resolveStateDir());

const settings = await Settings.open(stateDir);
const store = await Store.open(
  stateDir,
  settings.get("core", "feedbackPath", null)
    ?? Deno.env.get("KOZMOZOO_FEEDBACK")
    ?? `${Deno.env.get("HOME")}/Documents/kosmozoo_feedback.json`,
);
const hosts = await loadHosts(settings); // env seeds first boot, then user-managed
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
