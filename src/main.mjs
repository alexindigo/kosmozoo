// src/main.mjs — engine entry point.
//
// Running kosmozoo stays one `deno run` away:
//   deno run --allow-all src/main.mjs
//
// Environment overrides: KOZMOZOO_PORT (default 2084), KOZMOZOO_HOSTS,
// KOZMOZOO_STATE, KOZMOZOO_FEEDBACK (migration import only — sqlite is canonical).

import { CorruptStateError } from "./state.mjs";
import { buildContext } from "./context.mjs";
import { serveStatic } from "./static.mjs";

const PORT = parseInt(Deno.env.get("KOZMOZOO_PORT") ?? "2084", 10);

// A corrupt state file stops the boot: the bytes were quarantined by the
// state layer; the human repairs or removes them and starts again.
let ctx, router, discovered;
try {
  ({ ctx, router, discovered } = await buildContext({ env: Deno.env.toObject() }));
} catch (e) {
  if (e instanceof CorruptStateError) {
    console.error(`kosmozoo: corrupt state file: ${e.path}`);
    console.error(`kosmozoo: original bytes preserved at: ${e.quarantined}`);
    console.error(`kosmozoo: repair the JSON and move it back, or delete it to start empty — the engine never overwrites an unreadable state file`);
    Deno.exit(1);
  }
  throw e;
}

Deno.serve({ port: PORT }, async (req) => {
  const url = new URL(req.url);
  if (url.pathname.startsWith("/api/")) {
    try {
      return await router.handle(req);
    } catch (e) {
      return Response.json({ error: String(e?.message ?? e) }, { status: 500 });
    }
  }
  // static.mjs maps the SPA, /shared/*, and /plugins/<name>/client.js
  return serveStatic(url.pathname);
});

console.log(`kosmozoo engine on http://127.0.0.1:${PORT}  (state: ${ctx.paths.state})`);
console.log(`collections: ${Object.keys(ctx.hosts).join(", ")}`);
if (discovered.length) {
  console.log(`plugins: ${discovered.map((p) => p.name).join(", ")}`);
}
