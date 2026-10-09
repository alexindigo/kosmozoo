// client-solid/features/variations/api.js — the feature's endpoint paths.
// The transport itself is the shared one from /js/api.mjs.

import { req, postRaw } from "/js/api.mjs";

export const probe = (image) =>
  req("GET", `/api/features/variations/probe/${encodeURIComponent(image.id)}${image.origin ? `?origin=${encodeURIComponent(JSON.stringify(image.origin))}` : ""}`);

// raw POST: { ok, status, text }, no throw — the run report's error bodies
// carry per-permutation detail the modal parses
export const run = (payload) => postRaw("/api/features/variations/run", payload);

export const inputList = (collection, origin) =>
  fetch(`/api/collections/${encodeURIComponent(collection)}/entries?kind=input`, { headers: { "X-Kosmozoo-Origin": JSON.stringify(origin) } })
    .then(async response => { if (!response.ok) throw new Error(`Input catalogue: ${response.status}`); return response.json(); });

// multipart upload — a 409 carries the conflicting name (never an overwrite)
export const uploadInput = (collection, form, origin) =>
  fetch(`/api/collections/${encodeURIComponent(collection)}/entries`, { method: "POST", body: form, headers: { "X-Kosmozoo-Origin": JSON.stringify(origin) } })
    .then(async (r) => {
      if (r.ok) return r.json();
      if (r.status === 412) throw new Error("Source changed during upload; no follow-up was authorized. Your files have been kept.");
      if (r.status === 409) {
        const d = await r.json().catch(() => ({}));
        throw new Error(`already exists on the host: ${d.name ?? "name conflict"}`);
      }
      throw new Error(`POST entries/${collection}: ${r.status}`);
    });
