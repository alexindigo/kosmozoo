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

export const api = {
  hosts: () => req("GET", "/api/hosts"),
  images: (host) => req("GET", `/api/images?host=${encodeURIComponent(host)}`),
  image: (id) => req("GET", `/api/images/${encodeURIComponent(id)}`),
  imageBytesUrl: (id) => `${BASE}/api/images/${encodeURIComponent(id)}/bytes`,
  judgment: (id) => req("GET", `/api/judgments/${encodeURIComponent(id)}`),
  setJudgment: (id, fields) => req("PUT", `/api/judgments/${encodeURIComponent(id)}`, fields),
  clearJudgment: (id) => req("DELETE", `/api/judgments/${encodeURIComponent(id)}`),
  settings: (ns) => req("GET", `/api/settings/${encodeURIComponent(ns)}`),
  setSettings: (ns, kv) => req("PATCH", `/api/settings/${encodeURIComponent(ns)}`, kv),
  plugins: () => req("GET", "/api/plugins"),
};
