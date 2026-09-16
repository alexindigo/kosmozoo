// src/static.mjs — serve the client SPA and static assets.

import { join, normalize, extname, relative } from "node:path";
import { readFile } from "node:fs/promises";
import { pluginDirs } from "./plugins.mjs";

const CLIENT_ROOT = new URL("../client", import.meta.url).pathname;
// The built Solid client (client-solid-dist/) is the app: it owns the shell
// (/ and /diff) and the compiled modules; shared assets (css, vendor, the
// framework-free /js modules, logos) still live in the client tree.
const SOLID_ROOT = new URL("../client-solid-dist", import.meta.url).pathname;

// /shared/<name> exposes SELECTED src modules to the browser — one
// implementation, engine and client. Allow-listed, never the whole dir.
const SHARED_ALLOW = new Set(["extractor.mjs", "features/variations/shared.mjs"]);
const SRC_ROOT = new URL("./", import.meta.url).pathname;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// one serve-from-root helper: containment by path computation, never prefix
// strings; js/css/etc content types; no-cache for dev.
async function serveFrom(root, name) {
  const full = normalize(join(root, name));
  if (relative(root, full).startsWith("..")) return new Response("forbidden", { status: 403 });
  try {
    const body = await readFile(full);
    const headers = new Headers();
    const mime = MIME[extname(full)];
    if (mime) headers.set("Content-Type", mime);
    headers.set("Cache-Control", "no-cache");
    return new Response(body, { headers });
  } catch {
    return new Response("not found", { status: 404 });
  }
}

export async function serveStatic(pathname) {
  // /shared/<file> exposes allow-listed src/ modules to the browser — one
  // implementation, engine and client.
  if (pathname.startsWith("/shared/")) {
    const name = pathname.slice("/shared/".length);
    if (!SHARED_ALLOW.has(name)) return new Response("not found", { status: 404 });
    return serveFrom(SRC_ROOT, name);
  }

  // /plugins/<name>/client.js serves a plugin's client half from its
  // discovery directory. No traversal; name must be a bare identifier.
  if (pathname.startsWith("/plugins/")) {
    const rest = pathname.slice("/plugins/".length);
    if (!/^[a-z0-9_-]+\/client\.js$/.test(rest)) return new Response("forbidden", { status: 403 });
    for (const tier of pluginDirs()) {
      const r = await serveFrom(tier, rest);
      if (r.status !== 404) return r;
    }
    return new Response("not found", { status: 404 });
  }

  // / and the SPA route /diff serve the Solid app shell; compiled app
  // modules resolve from the dist tree too. Everything the dist doesn't
  // have falls through to the client tree (css, vendor, /js, logos).
  const p = (pathname === "/" || pathname === "/diff") ? "/index.html" : pathname;
  const fromDist = await serveFrom(SOLID_ROOT, p);
  if (fromDist.status !== 404) return fromDist;
  return serveFrom(CLIENT_ROOT, p);
}
