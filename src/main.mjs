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
import { parseHosts } from "./hosts.mjs";
import { makeRouter } from "./routes.mjs";
import { serveStatic } from "./static.mjs";

const PORT = parseInt(Deno.env.get("KOZMOZOO_PORT") ?? "2084", 10);

const stateDir = await ensureStateDir(resolveStateDir());
const feedbackPath = Deno.env.get("KOZMOZOO_FEEDBACK")
  ?? `${Deno.env.get("HOME")}/Documents/kosmozoo_feedback.json`;

const settings = await Settings.open(stateDir);
const store = await Store.open(stateDir, feedbackPath);
const hosts = parseHosts();

const router = makeRouter({ hosts, store, settings, plugins: null });

Deno.serve({ port: PORT }, async (req) => {
  const url = new URL(req.url);
  if (url.pathname.startsWith("/api/")) {
    try {
      return await router.handle(req);
    } catch (e) {
      return Response.json({ error: String(e?.message ?? e) }, { status: 500 });
    }
  }
  return serveStatic(url.pathname);
});

console.log(`kosmozoo engine on http://127.0.0.1:${PORT}  (state: ${stateDir})`);
console.log(`hosts: ${Object.keys(hosts).join(", ")}`);
