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

export const api = {
  hosts: () => req("GET", "/api/hosts"),
  addHost: (name, address) => req("POST", "/api/hosts", { name, address }),
  removeHost: (name) => req("DELETE", `/api/hosts/${encodeURIComponent(name)}`),
  images: (host) => req("GET", `/api/images?host=${encodeURIComponent(host)}`),
  image: (id) => req("GET", `/api/images/${encodeURIComponent(id)}`),
  deleteImage: (id) => req("DELETE", `/api/images/${encodeURIComponent(id)}`),
  imageBytesUrl: (id) => `${BASE}/api/images/${encodeURIComponent(id)}/bytes`,
  judgment: (id) => req("GET", `/api/judgments/${encodeURIComponent(id)}`),
  setJudgment: (id, fields) => req("PUT", `/api/judgments/${encodeURIComponent(id)}`, fields),
  clearJudgment: (id) => req("DELETE", `/api/judgments/${encodeURIComponent(id)}`),
  settings: (ns) => req("GET", `/api/settings/${encodeURIComponent(ns)}`),
  setSettings: (ns, kv) => req("PATCH", `/api/settings/${encodeURIComponent(ns)}`, kv),
  plugins: () => req("GET", "/api/plugins"),
  scraper: () => req("GET", "/api/scraper"),
  nodes: () => req("GET", "/api/nodes"),
  setScraper: (kv) => req("POST", "/api/scraper", kv),
  metadata: (host) => req("GET", `/api/metadata?host=${encodeURIComponent(host)}`),
  metaWant: (host, files) => req("POST", "/api/meta-want", { host, files }),
  downloadsCheck: (files) => req("POST", "/api/downloads-check", { files }),
  feedbackPath: (path) => req("PUT", "/api/feedback-path", { path }),
  // variations plugin
  variationsProbe: (id) => req("GET", `/api/plugins/variations/probe/${encodeURIComponent(id)}`),
  inputList: (host) => req("GET", `/api/input-list/${encodeURIComponent(host)}`),
  // multipart upload — not the JSON helper: the browser sets the boundary.
  // Throws on !ok; the modal's per-file catch turns that into the error line.
  uploadInput: (host, form) => fetch(BASE + `/api/upload-input/${encodeURIComponent(host)}`, { method: "POST", body: form })
    .then((r) => {
      if (!r.ok) throw new Error(`POST upload-input/${host}: ${r.status}`);
      return r.json();
    }),
  variationsRun: (payload) => postRaw("/api/plugins/variations/run", payload),
  // byte size isn't in every host's listing — a HEAD on the bytes route
  // fills it; resolves null when the host can't say
  imageSizeProbe: (id) => fetch(`${BASE}/api/images/${encodeURIComponent(id)}/bytes`, { method: "HEAD" })
    .then((r) => (r.ok ? Number(r.headers.get("content-length")) || null : null))
    .catch(() => null),
};
