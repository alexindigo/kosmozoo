// src/static.mjs — serve the client SPA and static assets.
// Zero-build: the client is plain ES modules served as-is.

import { join, normalize, extname } from "node:path";
import { readFile } from "node:fs/promises";

const CLIENT_ROOT = new URL("../client", import.meta.url).pathname;

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
  let p = pathname === "/" ? "/index.html" : pathname;
  // prevent traversal
  const full = normalize(join(CLIENT_ROOT, p));
  if (!full.startsWith(CLIENT_ROOT)) return new Response("forbidden", { status: 403 });
  try {
    const body = await readFile(full);
    const headers = new Headers();
    const mime = MIME[extname(full)];
    if (mime) headers.set("Content-Type", mime);
    return new Response(body, { headers });
  } catch {
    return new Response("not found", { status: 404 });
  }
}
