// client-solid/features/variations/api.js — the feature's transport to the
// engine's /api/features/variations/* endpoints (moved out of the global
// api registry with the feature).

const BASE = "";

async function req(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status}`);
  return r.json();
}

export const probe = (id) =>
  req("GET", `/api/features/variations/probe/${encodeURIComponent(id)}`);

// raw POST: { ok, status, text }, no throw — the run report's error bodies
// carry per-permutation detail the modal parses
export const run = async (payload) => {
  const r = await fetch(BASE + "/api/features/variations/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { ok: r.ok, status: r.status, text: await r.text() };
};

export const inputList = (collection) =>
  req("GET", `/api/collections/${encodeURIComponent(collection)}/entries?kind=input`).catch(() => []);

// multipart upload — a 409 carries the conflicting name (never an overwrite)
export const uploadInput = (collection, form) =>
  fetch(BASE + `/api/collections/${encodeURIComponent(collection)}/entries`, { method: "POST", body: form })
    .then(async (r) => {
      if (r.ok) return r.json();
      if (r.status === 409) {
        const d = await r.json().catch(() => ({}));
        throw new Error(`already exists on the host: ${d.name ?? "name conflict"}`);
      }
      throw new Error(`POST entries/${collection}: ${r.status}`);
    });
