// client/js/api.mjs — engine API client. The SPA is one client of the
// engine's public API (docs/spec.md ).
import { subscribeSources } from "./source-events.mjs";
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
export async function req(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
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
const entryUrl = (c, name) => `/api/collections/${enc(c)}/entries/${enc(name)}`;

export const api = {
  subscribeSources,
  runtime: () => req("GET", "/api/runtime"),
  collections: () => req("GET", "/api/collections"),
  addCollection: (name, address) => req("POST", "/api/collections", { name, address }),
  removeCollection: (name) => req("DELETE", `/api/collections/${enc(name)}`),
  patchCollection: (name, attributes) => req("PATCH", `/api/collections/${enc(name)}`, attributes),
  entries: (collection) => req("GET", `/api/collections/${enc(collection)}/entries`),
  inventory: (collection) => req("GET", `/api/collections/${enc(collection)}/entries?inventory=1`),
  entryBytesUrl: (collection, name) => `${BASE}${entryUrl(collection, name)}/bytes`,
  inputBytesUrl: (collection, name) => `${BASE}${entryUrl(collection, name)}/bytes?kind=input`,
  setJudgment: (collection, name, fields) => req("PATCH", `${entryUrl(collection, name)}/judgment`, fields),
  deleteEntry: (collection, name) => req("DELETE", entryUrl(collection, name)),
  settings: (ns) => req("GET", `/api/settings/${enc(ns)}`),
  setSettings: (ns, kv) => req("PATCH", `/api/settings/${enc(ns)}`, kv),
  prefetch: () => req("GET", "/api/prefetch"),
  nodes: () => req("GET", "/api/nodes"),
  setPrefetch: (kv) => req("POST", "/api/prefetch", kv),
  meta: (collection, since) => req("GET", `/api/collections/${enc(collection)}/meta?since=${since}`),
  want: (collection, files) => req("POST", `/api/collections/${enc(collection)}/want`, { files }),
  // byte size isn't in every listing — a HEAD on the bytes route fills it;
  // resolves null when the entry is unknown
  entrySizeProbe: (collection, name) => fetch(`${BASE}${entryUrl(collection, name)}/bytes`, { method: "HEAD" })
    .then((r) => (r.ok ? Number(r.headers.get("content-length")) || null : null))
    .catch(() => null),
};
