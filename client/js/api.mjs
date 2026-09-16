// client/js/api.mjs — engine API client. The SPA is one client of the
// engine's public API (docs/spec.md §2).

const BASE = ""; // same origin

// the ONE JSON transport — exported so feature modules (variations) share it
export async function req(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status}`);
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
  collections: () => req("GET", "/api/collections"),
  addCollection: (name, address) => req("POST", "/api/collections", { name, address }),
  removeCollection: (name) => req("DELETE", `/api/collections/${enc(name)}`),
  entries: (collection) => req("GET", `/api/collections/${enc(collection)}/entries`),
  entryBytesUrl: (collection, name) => `${BASE}${entryUrl(collection, name)}/bytes`,
  inputBytesUrl: (collection, name) => `${BASE}${entryUrl(collection, name)}/bytes?kind=input`,
  setJudgment: (collection, name, fields) => req("PATCH", `${entryUrl(collection, name)}/judgment`, fields),
  deleteEntry: (collection, name) => req("DELETE", entryUrl(collection, name)),
  settings: (ns) => req("GET", `/api/settings/${enc(ns)}`),
  setSettings: (ns, kv) => req("PATCH", `/api/settings/${enc(ns)}`, kv),
  plugins: () => req("GET", "/api/plugins"),
  prefetch: () => req("GET", "/api/prefetch"),
  nodes: () => req("GET", "/api/nodes"),
  setPrefetch: (kv) => req("POST", "/api/prefetch", kv),
  meta: (collection, since) => req("GET", `/api/collections/${enc(collection)}/meta?since=${since}`),
  want: (collection, files) => req("POST", `/api/collections/${enc(collection)}/want`, { files }),
  // per-collection judgment export (generated on demand)
  feedbackExportUrl: (collection) => `${BASE}/api/collections/${enc(collection)}/feedback.json`,
  // byte size isn't in every listing — a HEAD on the bytes route fills it;
  // resolves null when the entry is unknown
  entrySizeProbe: (collection, name) => fetch(`${BASE}${entryUrl(collection, name)}/bytes`, { method: "HEAD" })
    .then((r) => (r.ok ? Number(r.headers.get("content-length")) || null : null))
    .catch(() => null),
};
