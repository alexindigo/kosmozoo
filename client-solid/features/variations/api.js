// client-solid/features/variations/api.js — the feature's endpoint paths.
// The transport itself is the shared one from /js/api.mjs.

import { req, postRaw, collectionEntriesUrl, entryBytesUrl } from "/js/api.mjs";
import { parseExactJson, stringifyExactJson } from "/shared/parameters.mjs";
const json = { parse: parseExactJson, stringify: stringifyExactJson };
export const readRunResult = parseExactJson;
const historyPath = id => `/api/features/variations/history${id ? `/${encodeURIComponent(id)}` : ""}`;
export const historyList = before => req("GET", historyPath() + (before ? `?before=${encodeURIComponent(before)}` : ""), undefined, { json });
export const historyDetail = id => req("GET", historyPath(id), undefined, { json });
export const historyBegin = capture => req("POST", historyPath(), capture, { json });
export const historyPrepare = id => req("POST", historyPath(id) + "/prepare", {}, { json });
export const historyOpen = id => req("POST", historyPath(id) + "/open", {}, { json });
export const historyRelease = (id, leaseId) => req("DELETE", historyPath(id) + `/leases/${encodeURIComponent(leaseId)}`, undefined, { json });
export const historyRemove = id => req("DELETE", historyPath(id), undefined, { json });
export const historyFinish = (id, error) => req("POST", historyPath(id) + "/finish", { error }, { json });
export const historyMaterialize = (id, binding) => req("POST", historyPath(id) + `/uploads/${binding.targetIndex}-${encodeURIComponent(binding.resourceId)}`, binding, { json });
export const historyTarget = (id, binding) => req("POST", historyPath(id) + "/prepare-target", binding, { json });
export const historyThumbnail = item => historyPath(item.runId) + `/resources/${encodeURIComponent(item.resourceId)}/bytes${item.leaseId ? `?lease=${encodeURIComponent(item.leaseId)}` : ""}`;
export async function historyBytes(id, resourceId, file) {
  const response = await fetch(historyPath(id) + `/resources/${encodeURIComponent(resourceId)}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: file });
  const data = parseExactJson(await response.text());
  if (!response.ok) throw new Error(data.error ?? `Archive failed (${response.status})`);
  return data;
}

export const probe = (image) =>
  req("GET", `/api/features/variations/probe/${encodeURIComponent(image.id)}${image.origin ? `?origin=${encodeURIComponent(JSON.stringify(image.origin))}` : ""}`, undefined, { json });

// raw POST: { ok, status, text }, no throw — the run report's error bodies
// carry per-permutation detail the modal parses
export const run = (payload) => postRaw("/api/features/variations/run", payload, { json });

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

export const readInput = async (origin, name, root = "input") => {
  const response = await fetch(entryBytesUrl(origin.source, name, { kind: root, origin }));
  if (!response.ok) throw new Error(`Image unavailable (${response.status})`);
  const blob = await response.blob();
  return new File([blob], name, { type: blob.type });
};

export const inspectImage = async (collection, file, current, kind, origin, names = []) => {
  const form = new FormData(); form.append("image", file, file.name); form.append("current", current); form.append("kind", kind);
  form.append("names", JSON.stringify(names));
  const response = await fetch(`/api/features/variations/inspect-image/${encodeURIComponent(collection)}`, {
    method: "POST", headers: { "X-Kosmozoo-Origin": JSON.stringify(origin) }, body: form,
  });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || "Image comparison unavailable"); return data;
};

export const inputList = (collection, origin, root = "input") =>
  fetch(`${collectionEntriesUrl(collection)}?kind=${encodeURIComponent(root)}&catalogue=images-v1`, { headers: { "X-Kosmozoo-Origin": JSON.stringify(origin) } })
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
