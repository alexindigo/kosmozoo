// src/hosts.mjs — ComfyUI host registry, proxy, and folder-as-host adapter.
//
// Multi-host is a core capability (four hosts configured today), so host
// stays part of image identity: keys are `host:filename`. A local folder is
// just another host whose "API" is the filesystem: name=folder:/abs/path.

import { readdir, readFile, stat, unlink } from "node:fs/promises";
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

// Durability flag: can files on this remote change in place? The cache
// revalidates non-durable remotes (src/revalidate.mjs); durable ones are
// trusted forever once ingested. ComfyUI output is durable — a file is
// generated once and never rewritten. Folder remotes are NOT: external
// tools edit files in place. Every new remote kind added here must decide
// this flag explicitly.
export function hostDurable(addr) {
  if (isFolderHost(addr)) return false;
  return true; // ComfyUI (and future HTTP kinds until decided otherwise)
}

// Source mtime (ms) for revalidation, or null when the remote can't/needn't
// report one (durable kinds). Folder = stat; nothing else today.
export async function hostModified(addr, filename) {
  if (!isFolderHost(addr)) return null;
  if (basename(filename) !== filename || filename.includes("..")) return null;
  try {
    const s = await stat(join(FOLDER_RE.exec(addr)[1], filename));
    return s.isFile() ? s.mtimeMs : null;
  } catch {
    return null;
  }
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

// File listing for the candidates feed: [{ name, size }], newest first.
// HTTP: /internal/files/output's " [size]" suffix parsed, not stripped.
// Folder: renderable files by mtime, size from stat.
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
        if (s.isFile()) files.push({ n, mtime: s.mtimeMs, size: s.size });
      } catch { /* vanished */ }
    }
    files.sort((a, b) => b.mtime - a.mtime || a.n.localeCompare(b.n));
    return files.map((f) => ({ name: f.n, size: f.size }));
  }
  const r = await fetch(`http://${addr}/internal/files/output`);
  const raw = await r.json();
  return raw.map(parseListingEntry);
}

// ComfyUI listings annotate names with a trailing "[...]" — a size in some
// versions, a subfolder marker ("[output]") in others. The annotation is
// NEVER part of the identity; the size only when numeric. Greedy prefix so
// "a [b].png [7]" keeps its inner brackets.
export function parseListingEntry(n) {
  const m = /^(.*)\s+\[([^\]]*)\]$/.exec(String(n));
  if (!m) return { name: String(n), size: null };
  return { name: m[1], size: /^\d+$/.test(m[2]) ? Number(m[2]) : null };
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

// Byte size without the body: folder = stat; HTTP = HEAD on the host's
// view endpoint. Feeds the bytes route's HEAD and the card's size line.
export async function hostHeadSize(addr, filename) {
  if (isFolderHost(addr)) {
    if (basename(filename) !== filename || filename.includes("..")) return null;
    try {
      const s = await stat(join(FOLDER_RE.exec(addr)[1], filename));
      return s.isFile() ? s.size : null;
    } catch {
      return null;
    }
  }
  try {
    const url = `http://${addr}/api/view?type=output&filename=${encodeURIComponent(filename)}`;
    const r = await fetch(url, { method: "HEAD" });
    const cl = r.headers.get("content-length");
    return r.ok && cl ? Number(cl) : null;
  } catch {
    return null;
  }
}

// Input-dir image bytes (LoadImage-style node references): folder hosts read
// the file straight from the directory; ComfyUI serves them via /api/view
// with type=input. Output-dir files are NOT reachable here — that's what the
// regular bytes route is for.
export async function hostInputBytes(addr, filename) {
  if (basename(filename) !== filename || filename.includes("..")) {
    return { status: 400 };
  }
  const mime = EXT_MIME[filename.split(".").pop().toLowerCase()];
  if (isFolderHost(addr)) {
    try {
      const bytes = await readFile(join(FOLDER_RE.exec(addr)[1], filename));
      const headers = new Headers();
      if (mime) headers.set("Content-Type", mime);
      headers.set("Content-Length", String(bytes.length));
      return { status: 200, body: bytes, headers };
    } catch {
      return { status: 404 };
    }
  }
  try {
    const url = `http://${addr}/api/view?type=input&filename=${encodeURIComponent(filename)}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return { status: r.status };
    const headers = new Headers();
    const ct = r.headers.get("Content-Type");
    if (mime && (!ct || /octet-stream/i.test(ct))) headers.set("Content-Type", mime);
    else if (ct) headers.set("Content-Type", ct);
    return { status: 200, body: r.body, headers };
  } catch {
    return { status: 502 };
  }
}

// Back-compat alias (the bytes proxy).
export const proxyImage = hostReadBytes;

// --- deletion ------------------------------------------------------------------
//
// ComfyUI core has no file-delete API. The assets_plus extension adds one
// (POST /api/assets_plus/output/delete, mode "trash" = recoverable). Delete
// a file without it is impossible — the engine then only hides the image
// (routes.mjs) and tidies Comfy's history on a best-effort basis.

// Capability probe cache: addr -> boolean. Detection calls the delete
// endpoint with a name that can never exist — side-effect-free, and the
// response shape is authoritative (hosts without the extension answer the
// generic 405 / non-JSON).
const assetsPlusCache = new Map();

export async function hostHasAssetsPlus(addr) {
  if (isFolderHost(addr)) return false;
  if (assetsPlusCache.has(addr)) return assetsPlusCache.get(addr);
  let ok = false;
  try {
    const r = await fetch(`http://${addr}/api/assets_plus/output/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ relpaths: ["__kosmozoo_capability_probe__"], mode: "trash" }),
      signal: AbortSignal.timeout(5000),
    });
    if (r.ok) {
      const d = await r.json();
      ok = Array.isArray(d?.removed) && Array.isArray(d?.failed);
    }
  } catch { /* unreachable or no extension */ }
  assetsPlusCache.set(addr, ok);
  return ok;
}

// Delete one image from its source. folder -> unlink (permanent);
// comfy -> assets_plus trash (recoverable). { ok, mode, detail }.
export async function hostDelete(addr, filename) {
  if (basename(filename) !== filename || filename.includes("..")) {
    return { ok: false, mode: null, detail: "bad filename" };
  }
  if (isFolderHost(addr)) {
    try {
      await unlink(join(FOLDER_RE.exec(addr)[1], filename));
      return { ok: true, mode: "unlink" };
    } catch (e) {
      return { ok: false, mode: null, detail: e?.code === "ENOENT" ? "already gone" : String(e?.message ?? e) };
    }
  }
  let r;
  try {
    r = await fetch(`http://${addr}/api/assets_plus/output/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ relpaths: [filename], mode: "trash" }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    return { ok: false, mode: null, detail: `host unreachable: ${e?.message ?? e}` };
  }
  if (!r.ok) return { ok: false, mode: null, detail: `host returned ${r.status}` };
  let d;
  try { d = await r.json(); } catch { return { ok: false, mode: null, detail: "host returned no JSON" }; }
  if (!Array.isArray(d?.removed) || !Array.isArray(d?.failed)) {
    return { ok: false, mode: null, detail: "host has no assets_plus delete" };
  }
  if (d.removed.includes(filename)) return { ok: true, mode: "trash" };
  return { ok: false, mode: null, detail: d.failed.includes(filename) ? "not found on host" : "delete failed on host" };
}

// Best-effort Comfy history cleanup for the hide path: find the prompt that
// produced the file and delete its history entry. The file itself is
// untouched — this only tidies Comfy's own history panel.
export async function comfyHistoryDelete(addr, filename) {
  try {
    const r = await fetch(`http://${addr}/api/history`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return false;
    const history = await r.json();
    let promptId = null;
    for (const [pid, entry] of Object.entries(history)) {
      for (const nodeOut of Object.values(entry?.outputs ?? {})) {
        const items = [...(nodeOut?.images ?? []), ...(nodeOut?.gifs ?? [])];
        if (items.some((o) => o?.filename === filename)) { promptId = pid; break; }
      }
      if (promptId) break;
    }
    if (!promptId) return false;
    const dr = await fetch(`http://${addr}/api/history`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delete: [promptId] }),
      signal: AbortSignal.timeout(5000),
    });
    return dr.ok;
  } catch {
    return false;
  }
}

// Hosts are user config and change over time (spec §5): env seeds the map
// on first boot, then it is user-managed and persisted in settings
// (core.hosts.map). The returned object is mutated in place so every holder
// of the reference (router ctx, scraper) sees changes.
