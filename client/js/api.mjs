// client/js/api.mjs — engine API client. The SPA is one client of the
// engine's public API (docs/spec.md ).
import { subscribeSources } from "./source-events.mjs";
import { collectionEntriesUrl, entryUrl, entryBytesUrl } from "./entry-url.mjs";
export { collectionEntriesUrl, entryUrl, entryBytesUrl } from "./entry-url.mjs";
export { compareSourceVersions, validSourceVersion, validSourceCursor, validateSourceSnapshot } from "./source-events.mjs";

const BASE = ""; // same origin

export class ApiError extends Error {
  constructor(method, path, status, detail = "") {
    super(`${method} ${path}: ${status}${detail ? ` — ${detail}` : ""}`);
    this.name = "ApiError";
    this.method = method;
    this.path = path;
    this.status = status;
    this.detail = detail;
  }
}

// the ONE JSON transport — exported so feature modules (variations) share it
export async function req(method, path, body, { priority, signal, raw = false } = {}) {
  const r = await fetch(BASE + path, {
    method,
    headers: body ? { "Content-Type": raw ? "application/octet-stream" : "application/json" } : undefined,
    body: body ? raw ? body : JSON.stringify(body) : undefined,
    signal,
    priority: priority === "background" ? "low" : "auto",
  });
  if (!r.ok) {
    let detail = "";
    try {
      const payload = JSON.parse(await r.text());
      const error = typeof payload?.error === "string" ? payload.error : payload?.error?.message;
      const reason = typeof payload?.reason === "string" ? payload.reason : "";
      detail = [typeof error === "string" ? error : "", reason].filter(Boolean).join(": ").trim().slice(0, 1024);
    } catch { /* malformed/non-JSON bodies still retain their HTTP failure */ }
    throw new ApiError(method, path, r.status, detail);
  }
  return r.json();
}

// raw POST: { ok, status, text }, no throw — for endpoints whose error
// bodies carry detail the caller parses (the variations run report)
export async function postRaw(path, body) {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { ok: r.ok, status: r.status, text: await r.text() };
}

const enc = encodeURIComponent;

export const api = {
  subscribeSources,
  runtime: (options) => req("GET", "/api/runtime", undefined, options),
  collections: (options) => req("GET", "/api/collections", undefined, options),
  addCollection: (name, address) => req("POST", "/api/collections", { name, address }),
  removeCollection: (name) => req("DELETE", `/api/collections/${enc(name)}`),
  patchCollection: (name, attributes) => req("PATCH", `/api/collections/${enc(name)}`, attributes),
  entries: (collection) => req("GET", collectionEntriesUrl(collection)),
  inventory: (collection) => req("GET", `${collectionEntriesUrl(collection)}?inventory=1`),
  entryBytesUrl,
  inputBytesUrl: (collection, name) => entryBytesUrl(collection, name, { kind: "input" }),
  setJudgment: (collection, name, fields) => req("PATCH", `${entryUrl(collection, name)}/judgment`, fields),
  deleteEntry: (collection, name) => req("DELETE", entryUrl(collection, name)),
  settings: (ns) => req("GET", `/api/settings/${enc(ns)}`),
  setSettings: (ns, kv) => req("PATCH", `/api/settings/${enc(ns)}`, kv),
  prefetch: (options) => req("GET", "/api/prefetch", undefined, options),
  nodes: (options) => req("GET", "/api/nodes", undefined, options),
  setPrefetch: (kv) => req("POST", "/api/prefetch", kv),
  meta: (collection, since, options) => req("GET", `/api/collections/${enc(collection)}/meta?since=${since}`, undefined, options),
  want: (collection, files, options = {}) => req("POST", `/api/collections/${enc(collection)}/want`, { files, ...options }, options),
  // one shown entry's record: {name, hash, extracted, meta, width, height}
  entryMeta: (collection, name, options) => req("GET", `${entryUrl(collection, name)}/meta`, undefined, options),
  // byte size isn't in every listing — a HEAD on the bytes route fills it;
  // resolves null when the entry is unknown
  entrySizeProbe: (collection, name, { priority } = {}) => fetch(entryBytesUrl(collection, name), {
    method: "HEAD", priority: priority === "background" ? "low" : "auto",
  })
    .then((r) => (r.ok ? Number(r.headers.get("content-length")) || null : null))
    .catch(() => null),
};
