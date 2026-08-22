// src/hosts.mjs — ComfyUI host registry, proxy, and folder-as-host adapter.
//
// Multi-host is a core capability (four hosts configured today), so host
// stays part of image identity: keys are `host:filename`. A local folder is
// just another host whose "API" is the filesystem: name=folder:/abs/path.

import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";

// Hosts are user config and change over time (spec §5): env seeds the map
// on first boot, then it is user-managed and persisted in settings
// (core.hosts.map). The returned object is mutated in place so every holder
// of the reference (router ctx, scraper) sees changes.
export async function loadHosts(settings, env = Deno.env.toObject()) {
  const existing = settings.get("core.hosts", "map", null);
  if (existing && Object.keys(existing).length) return existing;
  const seed = parseHosts(env);
  await settings.set("core.hosts", "map", seed);
  return seed;
}

const NAME_RE = /^[\w][\w.-]*$/;
const ADDR_RE = /^[\w.-]+:\d+$/;
const FOLDER_RE = /^folder:(.+)$/;

export function isFolderHost(addr) {
  return FOLDER_RE.test(addr ?? "");
}

export function validateHost(name, address) {
  if (!name || !NAME_RE.test(name)) return "bad name (word chars, dots, hyphens)";
  if (address?.startsWith("folder:")) {
    if (!address.slice("folder:".length).trim()) return "folder: needs a path";
    return null;
  }
  if (!address || !ADDR_RE.test(address)) return "bad address (host:port or folder:/path)";
  return null;
}

export function addHost(map, name, address) {
  map[name] = address;
}

export function removeHost(map, name) {
  delete map[name];
}

export function parseHosts(env = Deno.env.toObject()) {
  // KOZMOZOO_HOSTS: "name=host:port,name2=host2:port2" or "name=folder:/path"
  const raw = env.KOZMOZOO_HOSTS ?? "local=127.0.0.1:8188";
  const hosts = {};
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    hosts[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return hosts;
}

export function hostKey(host, filename) {
  return `${host}:${filename}`;
}

export function splitHostKey(key) {
  const i = key.indexOf(":");
  return [key.slice(0, i), key.slice(i + 1)];
}

// --- host I/O: one surface for both kinds --------------------------------------

const RENDERABLE = new Set(["png", "jpg", "jpeg", "webp", "gif", "svg", "avif", "bmp"]);

// Online probe: HTTP = only the status code of /api/system_stats is
// inspected; folder = the directory exists.
export async function probeHost(addr) {
  if (isFolderHost(addr)) {
    try {
      const s = await stat(FOLDER_RE.exec(addr)[1]);
      return s.isDirectory();
    } catch {
      return false;
    }
  }
  try {
    const r = await fetch(`http://${addr}/api/system_stats`, { signal: AbortSignal.timeout(5000) });
    await r.arrayBuffer();
    return r.status === 200;
  } catch {
    return false;
  }
}

// File listing for the candidates feed. HTTP: /internal/files/output with the
// " [size]" suffix stripped. Folder: renderable files, newest first by mtime.
export async function hostList(addr) {
  if (isFolderHost(addr)) {
    const dir = FOLDER_RE.exec(addr)[1];
    const names = await readdir(dir);
    const files = [];
    for (const n of names) {
      if (n.startsWith(".")) continue;
      const ext = n.split(".").pop().toLowerCase();
      if (!RENDERABLE.has(ext)) continue;
      if (basename(n) !== n) continue;
      try {
        const s = await stat(join(dir, n));
        if (s.isFile()) files.push({ n, mtime: s.mtimeMs });
      } catch { /* vanished */ }
    }
    files.sort((a, b) => b.mtime - a.mtime || a.n.localeCompare(b.n));
    return files.map((f) => f.n);
  }
  const r = await fetch(`http://${addr}/internal/files/output`);
  const raw = await r.json();
  return raw.map((n) => String(n).replace(/\s+\[[^\]]+\]$/, ""));
}

// Proxy image bytes from a host's /api/view. Upstream ComfyUI serves some
// files as application/octet-stream (with nosniff) — the browser can't
// render those, so map the extension when the upstream type is useless.
export const EXT_MIME = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
  gif: "image/gif", svg: "image/svg+xml", avif: "image/avif", bmp: "image/bmp",
};

export async function hostReadBytes(addr, filename) {
  const ext = filename.split(".").pop().toLowerCase();
  const mime = EXT_MIME[ext];

  if (isFolderHost(addr)) {
    // traversal guard: flat folder, basename only, no ".."
    if (basename(filename) !== filename || filename.includes("..")) {
      return { status: 400 };
    }
    const dir = FOLDER_RE.exec(addr)[1];
    try {
      const bytes = await readFile(join(dir, filename));
      const headers = new Headers();
      if (mime) headers.set("Content-Type", mime);
      headers.set("Content-Length", String(bytes.length));
      return { status: 200, body: bytes, headers };
    } catch {
      return { status: 404 };
    }
  }

  const url = `http://${addr}/api/view?type=output&filename=${encodeURIComponent(filename)}`;
  const r = await fetch(url);
  if (!r.ok) return { status: r.status };
  const headers = new Headers();
  const ct = r.headers.get("Content-Type");
  if (mime && (!ct || /octet-stream/i.test(ct))) headers.set("Content-Type", mime);
  else if (ct) headers.set("Content-Type", ct);
  const cl = r.headers.get("Content-Length");
  if (cl) headers.set("Content-Length", cl);
  return { status: 200, body: r.body, headers };
}

// Back-compat alias (the bytes proxy).
export const proxyImage = hostReadBytes;

// Hosts are user config and change over time (spec §5): env seeds the map
// on first boot, then it is user-managed and persisted in settings
// (core.hosts.map). The returned object is mutated in place so every holder
// of the reference (router ctx, scraper) sees changes.
