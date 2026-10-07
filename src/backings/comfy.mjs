// src/backings/comfy.mjs — the ComfyUI backing: a host's output/input dirs
// over HTTP. One timeout for every fetch; every fetch checks r.ok.

import { RENDERABLE, EXT_MIME } from "./mime.mjs";
import { assertSafeName } from "./folder.mjs";
import { isEntryPath, splitEntryPath, inventoryFolders } from "../entry-path.mjs";

const HOST_TIMEOUT_MS = 10_000;

export const validName = isEntryPath;

export function viewUrl(addr, name, kind) {
  const { filename, subfolder } = splitEntryPath(name);
  const query = new URLSearchParams({ type: kind, filename });
  if (subfolder) query.set("subfolder", subfolder);
  return `http://${addr}/api/view?${query}`;
}

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
export async function list(addr, kind = "output", options = {}) {
  if (kind === "output") return (await inventory(addr, options)).items;
  const r = await fetch(`http://${addr}/internal/files/${kind}`, { signal: AbortSignal.timeout(HOST_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`ComfyUI listing: ${r.status}`); // E8: a down host is not an empty dir
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
  if (!validName(name)) return null;
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

// Read bytes. `range: [start, end]` (inclusive) asks for a head slice (the
// dims pass, ): aiohttp's FileResponse honors Range and answers 206; a
// server that ignores it answers 200 with the full body — callers accept
// both. Upstream serves some files as application/octet-stream (with
// nosniff) — the browser can't render those, so map the extension when the
// upstream type is useless.
export async function read(addr, name, kind = "output", { range } = {}) {
  if (!validName(name)) return { status: 400 };
  let r;
  try {
    r = await fetch(viewUrl(addr, name, kind), {
      headers: range ? { Range: `bytes=${range[0]}-${range[1]}` } : undefined,
      signal: AbortSignal.timeout(HOST_TIMEOUT_MS),
    });
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
  return { status: r.status, body: r.body, headers };
}

// Upload one image into the input dir (the same mechanism the ComfyUI web
// UI uses). No overwrite flag: ComfyUI answers 409 when the name exists —
// an upload must never silently clobber the input dir.
export async function write(addr, name, bytes) {
  if (!validName(name) || !assertSafeName(name)) return { ok: false, status: 400, error: "bad filename" };
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

// Capability probe (assets_plus extension) for one address. Only DEFINITIVE
// answers are cached (true, or an HTTP 404 from the extension endpoint) for
// a 60 s TTL; network errors and odd shapes fall through uncached.
const ASSETS_PLUS_TTL_MS = 60_000;

export async function hasAssetsPlus(addr, cache = new Map()) {
  const c = cache.get(addr);
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
        cache.set(addr, { v: true, t: Date.now() });
        return true;
      }
    } else if (r.status === 404) {
      cache.set(addr, { v: false, t: Date.now() }); // no extension
    }
  } catch { /* unreachable — not definitive, not cached */ }
  return false;
}

// Trash one image via assets_plus. { ok, mode, detail }.
export async function remove(addr, name) {
  if (!validName(name)) return { ok: false, mode: null, detail: "bad filename" };
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
  if (!validName(name)) return false;
  try {
    const r = await fetch(`http://${addr}/api/history`, { signal: AbortSignal.timeout(HOST_TIMEOUT_MS) });
    if (!r.ok) return false;
    const history = await r.json();
    let promptId = null;
    for (const [pid, entry] of Object.entries(history)) {
      for (const nodeOut of Object.values(entry?.outputs ?? {})) {
        const items = [...(nodeOut?.images ?? []), ...(nodeOut?.gifs ?? [])];
        if (items.some((o) => o?.type === "output" &&
            (o.subfolder ? `${o.subfolder}/${o.filename}` : o.filename) === name)) {
          promptId = pid; break;
        }
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

// --- the prompt/graph surface (variations feature) ----------------------------

// object_info cache for one address: { types: Map<paramId,"INT"|"FLOAT"> |
// null, outputClasses: Set<class_type> | null, enums:
// Map<"<type>.<input>", string[]> | null, t }. TTL'd (a host's node set
// is stable per version); misses are not cached forever.
const OBJECT_INFO_TTL_MS = 60_000;

// Filesystem inventory is independent of retained prompt history and delete
// preferences. The pinned AssetsPlus handler treats limit=0 as an unsliced
// scan and negative scan_depth as unlimited depth.
export function normalizeInventory(payload) {
  if (!payload || !Array.isArray(payload.items) || payload.has_more !== false ||
      typeof payload.cursor !== "string" || !Number.isFinite(payload.latest_mtime)) {
    throw new Error("ComfyUI inventory: malformed or incomplete scan");
  }
  const entries = new Map();
  for (const item of payload.items) {
    if (!item || !validName(item.relpath) || !RENDERABLE.has(item.relpath.split(".").pop().toLowerCase()) ||
        !Number.isSafeInteger(item.size) || item.size < 0 || !Number.isFinite(item.mtime)) {
      throw new Error("ComfyUI inventory: invalid record");
    }
    const next = { name: item.relpath, size: item.size, mtime: item.mtime };
    const prior = entries.get(next.name);
    if (prior && (prior.size !== next.size || prior.mtime !== next.mtime)) {
      throw new Error("ComfyUI inventory: conflicting duplicate");
    }
    entries.set(next.name, next);
  }
  return [...entries.values()].sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function normalizeRootInventory(raw) {
  if (!Array.isArray(raw) || raw.some((name) => typeof name !== "string")) throw new Error("ComfyUI listing: invalid array");
  const entries = new Map();
  for (const item of raw.map(parseListingEntry)) {
    if (!validName(item.name) || item.name.includes("/")) throw new Error("ComfyUI root listing: invalid name");
    if (!RENDERABLE.has(item.name.split(".").pop().toLowerCase())) continue;
    if (item.size !== null && (!Number.isSafeInteger(item.size) || item.size < 0)) throw new Error("ComfyUI root listing: invalid size");
    const prior = entries.get(item.name);
    if (prior && prior.size !== item.size) throw new Error("ComfyUI root listing: conflicting duplicate");
    entries.set(item.name, item);
  }
  return [...entries.values()];
}

export async function inventory(addr, { client, ...options } = {}) {
  if (client) return client(addr).inventory(options);
  // Compatibility for stateless standalone driver consumers. Production
  // discovery receives the context's existing address owner.
  const owner = comfyClient(addr);
  try { return await owner.inventory(options); }
  finally { owner.disposeInventory(); }
}

export async function objectInfo(addr, cache = new Map()) {
  const c = cache.get(addr);
  if (c && Date.now() - c.t < OBJECT_INFO_TTL_MS) return c;
  let out = { types: null, outputClasses: null, enums: null };
  try {
    const r = await fetch(`http://${addr}/api/object_info`, { signal: AbortSignal.timeout(HOST_TIMEOUT_MS) });
    if (r.ok) {
      const info = await r.json();
      out = { types: new Map(), outputClasses: new Set(), enums: new Map() };
      for (const [type, def] of Object.entries(info)) {
        if (def?.output_node) out.outputClasses.add(type);
        for (const section of ["required", "optional"]) {
          for (const [key, spec] of Object.entries(def?.input?.[section] ?? {})) {
            const t = Array.isArray(spec) ? spec[0] : spec;
            if (t === "INT" || t === "FLOAT") out.types.set(`${type}.${key}`, t);
            // combo widget: the host publishes THIS field's option list —
            // either as the spec type itself ([["a","b"], {}]) or as
            // "COMBO" with an options list in the widget config
            const raw = Array.isArray(t) ? t
              : (Array.isArray(spec) && t === "COMBO" ? spec[1]?.options : null);
            if (Array.isArray(raw) && raw.length) {
              const list = [...new Set(raw.filter((v) => typeof v === "string"))];
              if (list.length) out.enums.set(`${type}.${key}`, list);
            }
          }
        }
      }
    }
  } catch { /* offline — the null maps stand */ }
  cache.set(addr, { ...out, t: Date.now() });
  return out;
}

// ONE stateful client per address: the caches are instance state created by
// the context, never module globals. Stateless I/O stays with the module
// functions above.
export function comfyClient(addr, { fetcher = fetch, clock = Date.now, epoch = crypto.randomUUID() } = {}) {
  const assetsPlus = new Map();
  const objectInfoCache = new Map();
  let disposed = false, config = null, configTask = null, recursiveKnown = false;
  let requested = 1, published = 0, revision = 0, snapshot = null, scanTask = null, sampledAt = 0;
  const lifecycle = new AbortController();
  const assertAlive = () => { if (disposed) throw new Error("ComfyUI inventory owner removed"); };
  const request = (path) => fetcher(`http://${addr}${path}`, {
    signal: AbortSignal.any([lifecycle.signal, AbortSignal.timeout(HOST_TIMEOUT_MS)]),
  });
  async function discover() {
    assertAlive();
    if (config && clock() - config.at < ASSETS_PLUS_TTL_MS) return config.value;
    if (configTask) return configTask;
    configTask = (async () => {
      const r = await request("/api/assets_plus/config");
      assertAlive();
      let value;
      if (r.status === 404 && !recursiveKnown) {
        value = { supported: false, reason: "AssetsPlus is unavailable; stock ComfyUI lists output root only" };
      } else {
        if (!r.ok) throw new Error(`ComfyUI inventory config: ${r.status}`);
        const d = await r.json();
        assertAlive();
        if (!d || typeof d.recursive !== "boolean" || !Array.isArray(d.allowed_extensions) ||
            d.allowed_extensions.some((x) => typeof x !== "string") ||
            !Number.isInteger(d.list_limit) || d.list_limit <= 0 ||
            (d.scan_depth !== null && !Number.isInteger(d.scan_depth))) {
          throw new Error("ComfyUI inventory config: incompatible response");
        }
        value = { supported: true, reason: null };
      }
      config = { at: clock(), value };
      return value;
    })().finally(() => { configTask = null; });
    return configTask;
  }

  async function scan() {
    let support = await discover();
    const rootResponse = await request("/internal/files/output");
    if (!rootResponse.ok) throw new Error(`ComfyUI listing: ${rootResponse.status}`);
    const roots = normalizeRootInventory(await rootResponse.json());
    assertAlive();
    if (support.supported) {
      // The native search runs before AssetsPlus opens images for metadata.
      // '/' matches every descendant and no root, so oversized root images
      // cannot poison nested discovery. Roots retain stock visibility/order.
      const query = new URLSearchParams({ recursive: "1", scan_depth: "-1", limit: "0", extensions: [...RENDERABLE].join(","), query: "/" });
      const r = await request(`/api/assets_plus/output/list?${query}`);
      assertAlive();
      if (r.status === 404 && !recursiveKnown) {
        support = { supported: false, reason: "AssetsPlus output listing is unavailable; stock output root only" };
        config = { at: clock(), value: support };
      } else {
        if (!r.ok) throw new Error(`ComfyUI inventory: ${r.status}`);
        const nested = normalizeInventory(await r.json());
        if (nested.some(({ name }) => !name.includes("/"))) throw new Error("ComfyUI descendant inventory: unexpected root entry");
        const items = [...roots, ...nested];
        assertAlive();
        recursiveKnown = true;
        return { coverage: "recursive", subfolders: support, folders: inventoryFolders(items), items };
      }
    }
    return { coverage: "root-only", subfolders: support, folders: [""], items: roots };
  }

  function outputInventory({ maxAgeMs = 0 } = {}) {
    assertAlive();
    if (scanTask) return scanTask;
    if (snapshot && published === requested && maxAgeMs > 0 && clock() - sampledAt < maxAgeMs) {
      return Promise.resolve(snapshot);
    }
    scanTask = (async () => {
      while (true) {
        const generation = requested;
        const result = await scan();
        assertAlive();
        // A finish during the scan invalidates its generation. Coalesce every
        // such finish into a follow-up before any waiter consumes the result.
        if (generation !== requested) continue;
        snapshot = Object.freeze({ ...result, revision: `${epoch}:${++revision}`,
          items: Object.freeze(result.items.map((item) => Object.freeze(item))),
          folders: Object.freeze(result.folders), subfolders: Object.freeze(result.subfolders) });
        published = generation;
        sampledAt = clock();
        return snapshot;
      }
    })().finally(() => { scanTask = null; });
    return scanTask;
  }
  const telemetry = async (path, signal) => {
    const timeout = AbortSignal.timeout(HOST_TIMEOUT_MS);
    const r = await fetcher(`http://${addr}${path}`, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!r.ok) throw new Error(`ComfyUI telemetry ${path}: ${r.status}`);
    return r.json();
  };
  const object = (v) => v && typeof v === "object" && !Array.isArray(v);
  return {
    addr,
    inventory: outputInventory,
    invalidateInventory() { if (!disposed) requested++; },
    async subfolders() {
      try { return await discover(); }
      catch (error) { return { supported: recursiveKnown ? true : null, reason: error.message }; }
    },
    disposeInventory() {
      disposed = true;
      lifecycle.abort();
      return Promise.allSettled([configTask, scanTask].filter(Boolean));
    },
    hasAssetsPlus: () => hasAssetsPlus(addr, assetsPlus),
    objectInfo: () => objectInfo(addr, objectInfoCache),
    enqueue: (prompt) => enqueue(addr, prompt),
    async queue({ signal } = {}) {
      const d = await telemetry("/api/queue", signal);
      const ids = (rows) => {
        if (!Array.isArray(rows) || rows.some((r) => !Array.isArray(r) || typeof r[1] !== "string" || !r[1])) {
          throw new Error("ComfyUI queue: invalid prompt identities");
        }
        return rows.map((r) => r[1]);
      };
      return { running: ids(d?.queue_running), pending: ids(d?.queue_pending) };
    },
    async history({ maxItems, promptId, signal } = {}) {
      const path = promptId ? `/api/history/${encodeURIComponent(promptId)}`
        : `/api/history${maxItems === undefined ? "" : `?max_items=${maxItems}`}`;
      const d = await telemetry(path, signal);
      if (!object(d)) throw new Error("ComfyUI history: invalid object");
      return Object.entries(d).map(([id, entry]) => {
        if (!object(entry) || (entry.status !== undefined && !object(entry.status))) {
          throw new Error("ComfyUI history: invalid entry");
        }
        const status = entry.status;
        if (status && (typeof status.completed !== "boolean" || typeof status.status_str !== "string" || !Array.isArray(status.messages))) {
          throw new Error("ComfyUI history: invalid status");
        }
        const messages = status?.messages ?? [];
        const interrupted = messages.some((m) => Array.isArray(m) && m[0] === "execution_interrupted");
        const failed = messages.some((m) => Array.isArray(m) && m[0] === "execution_error");
        const terminal = !!status && (status.completed || status.status_str === "error" || interrupted || failed);
        return { id, terminal, outcome: interrupted ? "interrupted" : failed || status?.status_str === "error" ? "error" : terminal ? "success" : null };
      });
    },
    async logs({ signal } = {}) {
      const d = await telemetry("/internal/logs/raw", signal);
      if (!object(d) || !Array.isArray(d.entries) || !Number.isInteger(d.size) || d.size < 0 ||
          d.entries.some((e) => !object(e) || typeof e.m !== "string" || !["string", "number"].includes(typeof e.t))) {
        throw new Error("ComfyUI logs: invalid buffer");
      }
      return { entries: d.entries.map(({ t, m }) => ({ t, m })), size: d.size };
    },
  };
}

// Queue a prompt graph. Returns { ok, status, error? } — the caller owns
// permutation-level error reporting. Failures log the host's FULL body to
// the engine console: the response error is capped for display, but a
// validation detail truncated at the boundary is undiagnosable.
export async function enqueue(addr, prompt) {
  try {
    const resp = await fetch(`http://${addr}/api/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(prompt),
      signal: AbortSignal.timeout(HOST_TIMEOUT_MS),
    });
    if (!resp.ok) {
      const text = await resp.text();
      console.error(`[comfy] enqueue ${addr} → ${resp.status}: ${text}`);
      return { ok: false, status: resp.status, error: `ComfyUI ${resp.status}: ${text.slice(0, 200)}` };
    }
    return { ok: true, status: resp.status };
  } catch (e) {
    console.error(`[comfy] enqueue ${addr} → fetch failed: ${e.message}`);
    return { ok: false, status: 502, error: `fetch failed: ${e.message}` };
  }
}
