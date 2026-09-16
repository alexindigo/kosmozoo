// client-solid/features/variations/api.js — the feature's endpoint paths.
// The transport itself is the shared one from /js/api.mjs.

import { req, postRaw } from "/js/api.mjs";

export const probe = (id) =>
  req("GET", `/api/features/variations/probe/${encodeURIComponent(id)}`);

// raw POST: { ok, status, text }, no throw — the run report's error bodies
// carry per-permutation detail the modal parses
export const run = (payload) => postRaw("/api/features/variations/run", payload);

export const inputList = (collection) =>
  req("GET", `/api/collections/${encodeURIComponent(collection)}/entries?kind=input`).catch(() => []);

// multipart upload — a 409 carries the conflicting name (never an overwrite)
export const uploadInput = (collection, form) =>
  fetch(`/api/collections/${encodeURIComponent(collection)}/entries`, { method: "POST", body: form })
    .then(async (r) => {
      if (r.ok) return r.json();
      if (r.status === 409) {
        const d = await r.json().catch(() => ({}));
        throw new Error(`already exists on the host: ${d.name ?? "name conflict"}`);
      }
      throw new Error(`POST entries/${collection}: ${r.status}`);
    });
