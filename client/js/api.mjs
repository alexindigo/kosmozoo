// client/js/api.mjs — engine API client. The SPA is one client of the
// engine's public API (docs/spec.md §2).

const BASE = ""; // same origin

async function req(method, path, body) {
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
async function postRaw(path, body) {
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
  inputList: (collection) => req("GET", `/api/collections/${enc(collection)}/entries?kind=input`),
  // per-collection judgment export (generated on demand)
  feedbackExportUrl: (collection) => `${BASE}/api/collections/${enc(collection)}/feedback.json`,
  // variations plugin
  variationsProbe: (id) => req("GET", `/api/plugins/variations/probe/${enc(id)}`),
  // multipart upload — not the JSON helper: the browser sets the boundary.
  // Throws on !ok; the modal's per-file catch turns that into the error line.
  // A 409 carries the conflicting name — the upload refused to overwrite it.
  uploadInput: (collection, form) => fetch(BASE + `/api/collections/${enc(collection)}/entries`, { method: "POST", body: form })
    .then(async (r) => {
      if (r.ok) return r.json();
      if (r.status === 409) {
        const d = await r.json().catch(() => ({}));
        throw new Error(`already exists on the host: ${d.name ?? "name conflict"}`);
      }
      throw new Error(`POST entries/${collection}: ${r.status}`);
    }),
  variationsRun: (payload) => postRaw("/api/plugins/variations/run", payload),
  // byte size isn't in every listing — a HEAD on the bytes route fills it;
  // resolves null when the entry is unknown
  entrySizeProbe: (collection, name) => fetch(`${BASE}${entryUrl(collection, name)}/bytes`, { method: "HEAD" })
    .then((r) => (r.ok ? Number(r.headers.get("content-length")) || null : null))
    .catch(() => null),
};
