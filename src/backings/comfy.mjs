// src/backings/comfy.mjs — the ComfyUI backing: a host's output/input dirs
// over HTTP. One timeout for every fetch; every fetch checks r.ok.

import { RENDERABLE, EXT_MIME } from "./mime.mjs";
import { assertSafeName } from "./folder.mjs";

const HOST_TIMEOUT_MS = 10_000;

const viewUrl = (addr, name, kind) =>
  `http://${addr}/api/view?type=${kind}&filename=${encodeURIComponent(name)}`;

// Online probe: only the status code of /api/system_stats is inspected.
export async function probe(addr) {
  try {
    const r = await fetch(`http://${addr}/api/system_stats`, { signal: AbortSignal.timeout(HOST_TIMEOUT_MS) });
    return r.status === 200;
  } catch {
    return false;
  }
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

// kind 'output' → [{ name, size }] (feed listing); kind 'input' → [name]
// (LoadImage sweep sources, renderable only).
export async function list(addr, kind = "output") {
  const r = await fetch(`http://${addr}/internal/files/${kind}`, { signal: AbortSignal.timeout(HOST_TIMEOUT_MS) });
  if (!r.ok) return [];
  const raw = await r.json();
  if (kind === "input") {
    return raw
      .map((n) => parseListingEntry(n).name)
      .filter((n) => RENDERABLE.has(n.split(".").pop().toLowerCase()) && assertSafeName(n));
  }
  return raw.map(parseListingEntry);
}

// Source-content stamp: an OPAQUE string that changes when a file's content
// is rewritten under the same name — the revalidation signal. ComfyUI's
// ETag (aiohttp derives it from mtime_ns+size; fallback Last-Modified|CL).
// Compare for equality only — stamps are never ordered.
export async function stat(addr, name, kind = "output") {
  if (!assertSafeName(name)) return null;
  try {
    const r = await fetch(viewUrl(addr, name, kind), { method: "HEAD", signal: AbortSignal.timeout(HOST_TIMEOUT_MS) });
    if (!r.ok) return null;
    const etag = r.headers.get("ETag");
    const lm = r.headers.get("Last-Modified");
    const cl = r.headers.get("Content-Length");
    const stamp = etag ?? (lm || cl ? `${lm}|${cl}` : null);
    return stamp == null && cl == null ? null : { stamp, size: cl ? Number(cl) : null };
  } catch {
    return null;
  }
}

// Read bytes. Upstream serves some files as application/octet-stream (with
// nosniff) — the browser can't render those, so map the extension when the
// upstream type is useless.
export async function read(addr, name, kind = "output") {
  if (!assertSafeName(name)) return { status: 400 };
  let r;
  try {
    r = await fetch(viewUrl(addr, name, kind), { signal: AbortSignal.timeout(HOST_TIMEOUT_MS) });
  } catch {
    return { status: 502 };
  }
  if (!r.ok) return { status: r.status };
  const headers = new Headers();
  const mime = EXT_MIME[name.split(".").pop().toLowerCase()];
  const ct = r.headers.get("Content-Type");
  if (mime && (!ct || /octet-stream/i.test(ct))) headers.set("Content-Type", mime);
  else if (ct) headers.set("Content-Type", ct);
  const cl = r.headers.get("Content-Length");
  if (cl) headers.set("Content-Length", cl);
  return { status: 200, body: r.body, headers };
}

// Upload one image into the input dir (the same mechanism the ComfyUI web
// UI uses). No overwrite flag: ComfyUI answers 409 when the name exists —
// an upload must never silently clobber the input dir.
export async function write(addr, name, bytes) {
  if (!assertSafeName(name)) return { ok: false, status: 400, error: "bad filename" };
  const form = new FormData();
  form.append("image", new Blob([bytes]), name);
  try {
    const r = await fetch(`http://${addr}/api/upload/image`, {
      method: "POST", body: form, signal: AbortSignal.timeout(HOST_TIMEOUT_MS),
    });
    if (!r.ok) return { ok: false, status: r.status, error: `ComfyUI ${r.status}` };
    const d = await r.json().catch(() => ({}));
    return { ok: true, name: d.name ?? name };
  } catch (e) {
    return { ok: false, status: 502, error: `upload failed: ${e.message}` };
  }
}

// --- deletion ------------------------------------------------------------------
//
// ComfyUI core has no file-delete API. The assets_plus extension adds one
// (POST /api/assets_plus/output/delete, mode "trash" = recoverable). Delete
// without it is impossible — the engine then only hides the image (the
// routes) and tidies Comfy's history on a best-effort basis.

// Capability probe cache: addr -> { v, t }. Only DEFINITIVE answers are
// cached (true, or an HTTP 404 from the extension endpoint) for a 60 s TTL;
// network errors and odd shapes fall through uncached.
const ASSETS_PLUS_TTL_MS = 60_000;
const assetsPlusCache = new Map();

export async function hasAssetsPlus(addr) {
  const c = assetsPlusCache.get(addr);
  if (c && Date.now() - c.t < ASSETS_PLUS_TTL_MS) return c.v;
  try {
    const r = await fetch(`http://${addr}/api/assets_plus/output/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ relpaths: ["__kosmozoo_capability_probe__"], mode: "trash" }),
      signal: AbortSignal.timeout(HOST_TIMEOUT_MS),
    });
    if (r.ok) {
      const d = await r.json();
      if (Array.isArray(d?.removed) && Array.isArray(d?.failed)) {
        assetsPlusCache.set(addr, { v: true, t: Date.now() });
        return true;
      }
    } else if (r.status === 404) {
      assetsPlusCache.set(addr, { v: false, t: Date.now() }); // no extension
    }
  } catch { /* unreachable — not definitive, not cached */ }
  return false;
}

// Trash one image via assets_plus. { ok, mode, detail }.
export async function remove(addr, name) {
  if (!assertSafeName(name)) return { ok: false, mode: null, detail: "bad filename" };
  let r;
  try {
    r = await fetch(`http://${addr}/api/assets_plus/output/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ relpaths: [name], mode: "trash" }),
      signal: AbortSignal.timeout(HOST_TIMEOUT_MS),
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
  if (d.removed.includes(name)) return { ok: true, mode: "trash" };
  return { ok: false, mode: null, detail: d.failed.includes(name) ? "not found on host" : "delete failed on host" };
}

// Best-effort history cleanup for the hide path: find the prompt that
// produced the file and delete its history entry. The file itself is
// untouched — this only tidies Comfy's own history panel.
export async function historyDelete(addr, name) {
  try {
    const r = await fetch(`http://${addr}/api/history`, { signal: AbortSignal.timeout(HOST_TIMEOUT_MS) });
    if (!r.ok) return false;
    const history = await r.json();
    let promptId = null;
    for (const [pid, entry] of Object.entries(history)) {
      for (const nodeOut of Object.values(entry?.outputs ?? {})) {
        const items = [...(nodeOut?.images ?? []), ...(nodeOut?.gifs ?? [])];
        if (items.some((o) => o?.filename === name)) { promptId = pid; break; }
      }
      if (promptId) break;
    }
    if (!promptId) return false;
    const dr = await fetch(`http://${addr}/api/history`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delete: [promptId] }),
      signal: AbortSignal.timeout(HOST_TIMEOUT_MS),
    });
    return dr.ok;
  } catch {
    return false;
  }
}
