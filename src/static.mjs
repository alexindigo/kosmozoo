// src/static.mjs — serve the client SPA and static assets.
// Zero-build: the client is plain ES modules served as-is.

import { join, normalize, extname } from "node:path";
import { readFile } from "node:fs/promises";
import { pluginDirs } from "./plugins.mjs";

const CLIENT_ROOT = new URL("../client", import.meta.url).pathname;
// Solid migration: the built Solid client (client-solid-dist/) is served at
// /solid until cutover; the preact app at / stays live.
const SOLID_ROOT = new URL("../client-solid-dist", import.meta.url).pathname;

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

export async function serveStatic(pathname) {
  // /shared/<file> exposes selected src/ modules (the extractor) to the
  // browser — one implementation, engine and client.
  if (pathname.startsWith("/shared/")) {
    const name = pathname.slice("/shared/".length);
    if (!/^[a-z0-9_-]+\.mjs$/.test(name)) return new Response("forbidden", { status: 403 });
    const full = new URL(`./${name}`, import.meta.url).pathname;
    try {
      const body = await readFile(full);
      return new Response(body, {
        headers: {
          "Content-Type": "text/javascript; charset=utf-8",
          "Cache-Control": "no-cache",
        },
      });
    } catch {
      return new Response("not found", { status: 404 });
    }
  }

  // /plugins/<name>/client.js serves a plugin's client half from its
  // discovery directory. No traversal; name must be a bare identifier.
  if (pathname.startsWith("/plugins/")) {
    const rest = pathname.slice("/plugins/".length);
    if (!/^[a-z0-9_-]+\/client\.js$/.test(rest)) return new Response("forbidden", { status: 403 });
    const name = rest.split("/")[0];
    for (const tier of pluginDirs()) {
      try {
        const body = await readFile(join(tier, name, "client.js"));
        return new Response(body, {
          headers: {
            "Content-Type": "text/javascript; charset=utf-8",
            "Cache-Control": "no-cache",
          },
        });
      } catch { /* try next tier */ }
    }
    return new Response("not found", { status: 404 });
  }

  // /solid serves the built Solid client during migration. /solid redirects to
  // /solid/ so the shell's relative URLs resolve inside the sub-app.
  if (pathname === "/solid") {
    return new Response(null, { status: 302, headers: { Location: "/solid/" } });
  }
  if (pathname.startsWith("/solid/")) {
    const p = pathname === "/solid/" ? "/index.html" : pathname.slice("/solid".length);
    const full = normalize(join(SOLID_ROOT, p));
    if (!full.startsWith(SOLID_ROOT)) return new Response("forbidden", { status: 403 });
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

  // / and the SPA route /diff both serve the app shell
  let p = (pathname === "/" || pathname === "/diff") ? "/index.html" : pathname;
  // prevent traversal
  const full = normalize(join(CLIENT_ROOT, p));
  if (!full.startsWith(CLIENT_ROOT)) return new Response("forbidden", { status: 403 });
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
