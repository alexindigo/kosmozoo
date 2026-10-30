// client-solid/features/variations/api.js — the feature's endpoint paths.
// The transport itself is the shared one from /js/api.mjs.

import { req, postRaw, collectionEntriesUrl, entryBytesUrl } from "/js/api.mjs";

export const probe = (image) =>
  req("GET", `/api/features/variations/probe/${encodeURIComponent(image.id)}${image.origin ? `?origin=${encodeURIComponent(JSON.stringify(image.origin))}` : ""}`);

// raw POST: { ok, status, text }, no throw — the run report's error bodies
// carry per-permutation detail the modal parses
export const run = (payload) => postRaw("/api/features/variations/run", payload);

const pathRequest = async (route, body, origin) => {
  const response = await fetch(`/api/features/variations/${route}`, { method: "POST", body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...(origin ? { "X-Kosmozoo-Origin": JSON.stringify(origin) } : {}) } });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || "Folder images unavailable"), { uploaded: data.uploaded });
  return data;
};
export const listFolder = path => pathRequest("folder-images", { path });
export const folderCapability = () => req("GET", "/api/features/variations/folder-chooser");
export const chooseFolder = async (path, signal) => {
  const response = await fetch("/api/features/variations/choose-folder", { method: "POST", signal,
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Folder chooser unavailable");
  return result;
};
export const pathThumbnail = path => `/api/features/variations/folder-image?path=${encodeURIComponent(path)}`;
export const inspectPath = (collection, path, current, kind, origin, names = []) =>
  pathRequest(`inspect-path/${encodeURIComponent(collection)}`, { path, current, kind, names }, origin);
export const uploadPath = (collection, path, hash, origin) =>
  pathRequest(`upload-path/${encodeURIComponent(collection)}`, { path, hash }, origin);

export const inputThumbnail = (collection, name, origin, kind = "input") =>
  entryBytesUrl(collection, name, { kind, origin });

export const inspectImage = async (collection, file, current, kind, origin, names = []) => {
  const form = new FormData(); form.append("image", file, file.name); form.append("current", current); form.append("kind", kind);
  form.append("names", JSON.stringify(names));
  const response = await fetch(`/api/features/variations/inspect-image/${encodeURIComponent(collection)}`, {
    method: "POST", headers: { "X-Kosmozoo-Origin": JSON.stringify(origin) }, body: form,
  });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || "Image comparison unavailable"); return data;
};

export const inputList = (collection, origin) =>
  fetch(`${collectionEntriesUrl(collection)}?kind=input`, { headers: { "X-Kosmozoo-Origin": JSON.stringify(origin) } })
    .then(async response => { if (!response.ok) throw new Error(`Input catalogue: ${response.status}`); return response.json(); });

// multipart upload — a 409 carries the conflicting name (never an overwrite)
export const uploadInput = (collection, form, origin) =>
  fetch(collectionEntriesUrl(collection), { method: "POST", body: form, headers: { "X-Kosmozoo-Origin": JSON.stringify(origin) } })
    .then(async (r) => {
      if (r.ok) return r.json();
      if (r.status === 412) {
        const data = await r.json().catch(() => ({}));
        throw Object.assign(new Error("Source changed during upload; no follow-up was authorized. Your files have been kept."), { uploaded: data.uploaded });
      }
      if (r.status === 409) {
        const d = await r.json().catch(() => ({}));
        throw new Error(`already exists on the host: ${d.name ?? "name conflict"}`);
      }
      throw new Error(`POST entries/${collection}: ${r.status}`);
    });
