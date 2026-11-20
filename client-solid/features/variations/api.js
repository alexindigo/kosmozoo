// client-solid/features/variations/api.js — the feature's endpoint paths.
// The transport itself is the shared one from /js/api.mjs.

import { req as request, postRaw, collectionEntriesUrl, entryUrl, entryBytesUrl } from "/js/api.mjs";
import { sourceFailure } from "./source-message.js";
import { parseExactJson, stringifyExactJson } from "/shared/parameters.mjs";
import { variationProblem, problemError, problemFrom } from "/shared/features/variations/problems.mjs";
const json = { parse: parseExactJson, stringify: stringifyExactJson };
export const readRunResult = parseExactJson;
const req = (method, path, body, options, host = body?.targets?.[0]?.host ?? body?.origin?.source ?? "Source", destination = body?.destination?.source) =>
  request(method, path, body, options).catch(error => {
    const detail = error.detail ?? error.message;
    const message = sourceFailure(error.status, detail, /^Run destination changed/.test(detail) ? destination ?? host : host);
    if (message !== (error.detail ?? error.message)) { error.message = message; error.detail = message; }
    throw error;
  });
const responseError = (response, data, host, fallback) => Object.assign(new Error(sourceFailure(response.status, data.error || fallback, host)), { status: response.status, uploaded: data.uploaded, problem: data.problem });
const historyPath = id => `/api/features/variations/history${id ? `/${encodeURIComponent(id)}` : ""}`;
export const historyList = before => req("GET", historyPath() + (before ? `?before=${encodeURIComponent(before)}` : ""), undefined, { json });
export const historyDetail = (id, signal) => req("GET", historyPath(id), undefined, { json, signal });
export const historyBegin = capture => req("POST", historyPath(), capture, { json });
export const plan = (capture, signal) => req("POST", "/api/features/variations/plan", capture, { json, signal });
export const historyPrepare = (id, host, destination) => req("POST", historyPath(id) + "/prepare", {}, { json }, host, destination);
export const historyOpen = id => req("POST", historyPath(id) + "/open", {}, { json });
export const historyRelease = (id, leaseId) => req("DELETE", historyPath(id) + `/leases/${encodeURIComponent(leaseId)}`, undefined, { json });
export const historyRemove = id => req("DELETE", historyPath(id), undefined, { json });
export const historyFinish = (id, error) => req("POST", historyPath(id) + "/finish", { error }, { json }).catch(error => { throw problemError(problemFrom(error, { code: "history-finish", phase: "history finish", runId: id })); });
export const historyMaterialize = (id, binding) => req("POST", historyPath(id) + `/uploads/${binding.targetIndex}-${encodeURIComponent(binding.resourceId)}`, binding, { json });
export const historyTarget = (id, binding) => req("POST", historyPath(id) + "/prepare-target", binding, { json });
export const historyThumbnail = item => historyPath(item.runId) + `/resources/${encodeURIComponent(item.resourceId)}/bytes${item.leaseId ? `?lease=${encodeURIComponent(item.leaseId)}` : ""}`;
export async function historyBytes(id, resourceId, file) {
  const response = await fetch(historyPath(id) + `/resources/${encodeURIComponent(resourceId)}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: file });
  let data;
  try { data = parseExactJson(await response.text()); }
  catch { throw problemError(variationProblem("history-upload", { runId: id, resource: file.name, numbers: { saved: "unknown", total: "unknown", status: response.status }, detail: `engine returned unreadable data (HTTP ${response.status})` })); }
  if (!response.ok) throw Object.assign(new Error(data.error ?? `Archive failed (${response.status})`), { status: response.status, problem: data.problem });
  return data;
}

export const probe = (image, destination = null) => {
  const query = [image.origin && `origin=${encodeURIComponent(JSON.stringify(image.origin))}`,
    destination && `destination=${encodeURIComponent(JSON.stringify(destination))}`].filter(Boolean).join("&");
  return req("GET", `/api/features/variations/probe/${encodeURIComponent(image.id)}${query ? `?${query}` : ""}`, undefined, { json }, image.host, destination?.source);
};
export const historyCatalogue = (id, leaseId, targetIndex, destination) => req("GET", historyPath(id) +
  `/catalogue?lease=${encodeURIComponent(leaseId)}&target=${targetIndex}&destination=${encodeURIComponent(JSON.stringify(destination))}`, undefined, { json }, destination?.source);

export const generationTime = (image, { signal } = {}) =>
  req("GET", `${entryUrl(image.host, image.filename)}/meta?origin=${encodeURIComponent(JSON.stringify(image.origin))}`, undefined, { signal }, image.host);

// raw POST: { ok, status, text }, no throw — the run report's error bodies
// carry per-permutation detail the modal parses
export const run = (payload) => postRaw("/api/features/variations/run", payload, { json });

const pathRequest = async (route, body, origin) => {
  const response = await fetch(`/api/features/variations/${route}`, { method: "POST", body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...(origin ? { "X-Kosmozoo-Origin": JSON.stringify(origin) } : {}) } });
  const data = await response.json();
  if (!response.ok) throw responseError(response, data, origin?.source, "Folder images unavailable");
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
  if (!response.ok) throw responseError(response, await response.json().catch(() => ({})), origin.source, `Image unavailable (${response.status})`);
  const blob = await response.blob();
  return new File([blob], name, { type: blob.type });
};

export const inspectImage = async (collection, file, current, kind, origin, names = []) => {
  const form = new FormData(); form.append("image", file, file.name); form.append("current", current); form.append("kind", kind);
  form.append("names", JSON.stringify(names));
  const response = await fetch(`/api/features/variations/inspect-image/${encodeURIComponent(collection)}`, {
    method: "POST", headers: { "X-Kosmozoo-Origin": JSON.stringify(origin) }, body: form,
  });
  const data = await response.json(); if (!response.ok) throw responseError(response, data, collection, "Image comparison unavailable"); return data;
};

export const inputList = (collection, origin, root = "input") =>
  fetch(`${collectionEntriesUrl(collection)}?kind=${encodeURIComponent(root)}&catalogue=images-v1`, { headers: { "X-Kosmozoo-Origin": JSON.stringify(origin) } })
    .then(async response => { if (!response.ok) throw responseError(response, await response.json().catch(() => ({})), collection, `Input catalogue: ${response.status}`); return response.json(); });

// multipart upload — a 409 carries the conflicting name (never an overwrite)
export const uploadInput = async (collection, form, origin) => {
  const resource = form.get("image")?.name ?? "selected file", context = { phase: "upload", destination: collection, resource };
  try {
      const r = await fetch(collectionEntriesUrl(collection), { method: "POST", body: form, headers: { "X-Kosmozoo-Origin": JSON.stringify(origin) } });
      if (r.ok) return await r.json();
      if (r.status === 412) {
        const data = await r.json().catch(() => ({}));
        throw Object.assign(problemError(variationProblem("upload-retired", { ...context, stage: data.uploaded ? "after" : "before", uploaded: data.uploaded })), { uploaded: data.uploaded });
      }
      if (r.status === 409) {
        const d = await r.json().catch(() => ({}));
        throw problemError(variationProblem("upload-conflict", { ...context, actual: d.name ?? "name conflict" }));
      }
      const data = await r.json().catch(() => ({}));
      throw problemError(variationProblem(r.status < 500 ? "upload-rejected" : "upload-unknown", { ...context, numbers: { status: r.status }, detail: data.error ?? `HTTP ${r.status}` }));
  } catch (error) { if (error.problem) throw error; throw problemError(problemFrom(error, { ...context, code: "upload-unknown" })); }
};

// Pexels-compatible services: the engine owns keys and upstream requests.
const pexelsPath = (id = null) => `/api/features/variations/pexels/services${id === null ? "" : `/${encodeURIComponent(id)}`}`;
export const pexelsServices = signal => req("GET", pexelsPath(), undefined, { signal });
export const createPexelsService = details => req("POST", pexelsPath(), details);
export const updatePexelsService = (id, details) => req("PATCH", pexelsPath(id), details);
export const removePexelsService = id => req("DELETE", pexelsPath(id));
export const pexelsStatus = (id, signal) => req("GET", `${pexelsPath(id)}/status`, undefined, { signal });
export const pexelsPhotos = (id, query, page, signal) =>
  req("GET", `${pexelsPath(id)}/photos?${new URLSearchParams({ query, page: String(page) })}`, undefined, { signal });
const pexelsPhotoPath = (id, photo, url, kind) => `${pexelsPath(id)}/photos/${encodeURIComponent(photo)}/${kind}?${new URLSearchParams({ service: url })}`;
export const pexelsThumbnail = (id, photo, url) => pexelsPhotoPath(id, photo, url, "thumbnail");
const PEXELS_EXTENSIONS = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif" };
// Photo IDs are opaque service data; the upload name is a portable slug of it.
export const pexelsFileName = (photo, extension) =>
  `pexels-${String(photo).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(-80) || "photo"}.${extension}`;
export async function readPexelsPhoto(id, photo, url) {
  const response = await fetch(pexelsPhotoPath(id, photo, url, "image"));
  if (!response.ok) {
    let message = `Photo unavailable (${response.status})`;
    try { message = (await response.json()).error ?? message; } catch { /* non-JSON body */ }
    throw new Error(message);
  }
  const blob = await response.blob(), extension = PEXELS_EXTENSIONS[blob.type];
  if (!extension) throw new Error("The service sent a file that isn't a supported image");
  return new File([blob], pexelsFileName(photo, extension), { type: blob.type });
}
