// Pexels-compatible photo services as a Variations image source.
//
// The engine alone talks to a service: the browser lists services without
// their keys, browses through these routes and receives proxied bytes. Image
// URLs are resolved only from photo records this module fetched itself, so
// the routes are never a general fetch proxy.

import { dirname, join } from "node:path";
import { SerializedWriter } from "../../writer.mjs";
import { sniffMime } from "../../extractor.mjs";
import { readJson, mediaHeaders } from "../../routes.mjs";
import { variationProblem, problemError } from "./problems.mjs";

export const PEXELS_PAGE_SIZE = 40;
export const MAX_PEXELS_SERVICES = 32;
export const MAX_PEXELS_IMAGE_BYTES = 50 * 1024 * 1024;
// Memory bound for a service's JSON replies; a normal page is well under 1 MB.
export const MAX_PEXELS_JSON_BYTES = 32 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const PHOTO_CACHE_LIMIT = 4000;
const IMAGE_MIME = new Map([["image/jpeg", "jpg"], ["image/png", "png"], ["image/webp", "webp"], ["image/gif", "gif"], ["image/avif", "avif"]]);
// Imported photos prefer large2x; picker tiles prefer medium. A service may send
// any subset of sizes (or its own names): every size can serve either role.
export const PHOTO_SIZES = Object.freeze({
  image: ["large2x", "large", "original", "landscape", "portrait", "medium", "small", "tiny"],
  thumbnail: ["medium", "small", "tiny", "landscape", "portrait", "large", "large2x", "original"],
});
const pickSize = (src, kind) => PHOTO_SIZES[kind].map(size => src[size]).find(Boolean) ?? Object.values(src)[0];

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
// Structured service problems: what was being loaded, from which service, and why.
const problem = (code, context, status = 502) => Object.assign(problemError(variationProblem(code, { phase: "pexels", ...context })), { status });
const controls = /[\x00-\x1f\x7f]/;
const cause = error => String(error?.message ?? error).replace(/^error sending request for url \([^)]*\):\s*/, "");

// The API root, with or without the documented /v1 segment.
export function serviceBase(raw) {
  if (typeof raw !== "string" || !raw.trim()) throw fail("Enter the service URL");
  let url;
  try { url = new URL(raw.trim()); } catch { throw fail("Enter a valid http or https URL"); }
  if (!["http:", "https:"].includes(url.protocol)) throw fail("Use an http or https URL");
  if (url.username || url.password) throw fail("Put the API key in the key field, not in the URL");
  if (url.search || url.hash) throw fail("The service URL can't include a query or fragment");
  const path = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
  return `${url.origin}${path}`;
}

const validName = raw => {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name || name.length > 60 || controls.test(name)) throw problem("pexels-name", { field: "Name", numbers: { length: name.length },
    detail: typeof raw !== "string" ? "not text" : !name ? "blank" : controls.test(name) ? "contains line breaks or control characters" : "too long" }, 400);
  return name;
};
// Never echoes the key: only why it was refused.
const validKey = raw => {
  const key = typeof raw === "string" ? raw.trim() : "";
  if (!key || controls.test(key)) throw problem("pexels-key", { field: "API key", detail: !key ? "the replacement key is empty" : "it contains line breaks or control characters" }, 400);
  return key;
};
export const redactService = ({ id, name, url, key }) => ({ id, name, url, hasKey: !!key });

const writeOwnerOnly = async (path, bytes) => {
  await Deno.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${crypto.randomUUID()}`;
  try {
    await Deno.writeFile(tmp, bytes, { mode: 0o600 });
    await Deno.chmod(tmp, 0o600);
    await Deno.rename(tmp, path);
  } catch (error) { await Deno.remove(tmp).catch(() => {}); throw error; }
};

// Engine-owned registry. Keys never leave this module except as the
// Authorization header of an upstream request.
export class PexelsServices {
  #path; #writer; #loading = null; #services = null; #changed; #mutations = Promise.resolve();
  constructor(path, { write = writeOwnerOnly, changed = () => {} } = {}) {
    this.#path = path; this.#writer = new SerializedWriter(path, write); this.#changed = changed;
  }

  // Registration is IO-free; the first request loads. An unreadable file is
  // reported and never overwritten.
  #load() {
    this.#loading ??= (async () => {
      let text;
      try { text = await Deno.readTextFile(this.#path); }
      catch (error) {
        if (error instanceof Deno.errors.NotFound) { this.#services = []; return; }
        throw problem("pexels-config", { path: this.#path, detail: cause(error) }, 500);
      }
      let doc;
      try { doc = JSON.parse(text); } catch { doc = null; }
      const services = doc?.version === 1 && Array.isArray(doc.data?.services) ? doc.data.services : null;
      if (!services || services.some(item => !item || typeof item.id !== "string" || typeof item.name !== "string" || typeof item.url !== "string" ||
          !(item.key === undefined || typeof item.key === "string")))
        throw problem("pexels-config", { path: this.#path, detail: "the file is not a valid Pexels services document; fix or remove it" }, 500);
      this.#services = services.map(({ id, name, url, key }) => ({ id, name, url, ...(key ? { key } : {}) }));
    })().catch(error => { this.#loading = null; throw error; });
    return this.#loading;
  }

  // Each mutation reads, validates and persists inside one queue, so
  // concurrent requests always build on the previous result.
  #mutate(operation) {
    const run = this.#mutations.then(async () => { await this.#load(); return operation(); });
    this.#mutations = run.catch(() => {});
    return run;
  }

  // The writer replaces the file atomically: a failed save leaves the old list.
  async #save(next, operation, name) {
    try { await this.#writer.write(new TextEncoder().encode(JSON.stringify({ version: 1, data: { services: next } }, null, 2))); }
    catch (error) { throw problem("pexels-storage", { operation, source: name, path: this.#path, detail: cause(error) }, 500); }
    this.#services = next;
  }

  async list() { await this.#load(); return this.#services.map(redactService); }

  #find(id) {
    const service = this.#services.find(item => item.id === id);
    if (!service) throw problem("pexels-removed", { service: id }, 404);
    return { ...service };
  }

  async get(id) { await this.#load(); return this.#find(id); }

  #unique(name, except = null) {
    if (this.#services.some(item => item.id !== except && item.name.toLowerCase() === name.toLowerCase())) throw fail("A service with this name already exists", 409);
  }

  create(body) { return this.#mutate(async () => {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw problem("pexels-request", { operation: "save", field: "service details", detail: "Service details must be an object" }, 400);
    if (this.#services.length >= MAX_PEXELS_SERVICES) throw problem("pexels-limit", { numbers: { used: this.#services.length, limit: MAX_PEXELS_SERVICES } }, 400);
    const name = validName(body.name), url = serviceBase(body.url);
    const key = body.key === undefined || body.key === null || body.key === "" ? null : validKey(body.key);
    this.#unique(name);
    const service = { id: crypto.randomUUID(), name, url, ...(key ? { key } : {}) };
    await this.#save([...this.#services, service], "save", name);
    return redactService(service);
  }); }

  // Omitted key keeps the saved one, null clears it, a string replaces it.
  update(id, body) { return this.#mutate(async () => {
    const current = this.#find(id);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw problem("pexels-request", { operation: "save", source: current.name, field: "service details", detail: "Service details must be an object" }, 400);
    const next = { ...current };
    if (body.name !== undefined) next.name = validName(body.name);
    if (body.url !== undefined) next.url = serviceBase(body.url);
    if (body.key === null) delete next.key;
    else if (body.key !== undefined) next.key = validKey(body.key);
    this.#unique(next.name, id);
    await this.#save(this.#services.map(item => item.id === id ? next : item), "save", next.name);
    this.#changed(id);
    return redactService(next);
  }); }

  remove(id) { return this.#mutate(async () => {
    const { name } = this.#find(id);
    await this.#save(this.#services.filter(item => item.id !== id), "remove", name);
    this.#changed(id);
  }); }
}

const photoId = value => {
  const id = typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : value;
  // Compatible services use their own opaque IDs (e.g. "film-…:frame-…"); the
  // ID is only ever an encoded path segment and a lookup key, never a filename.
  // "." and ".." would be resolved as path steps even when encoded.
  return typeof id === "string" && id.length > 0 && !controls.test(id) && id !== "." && id !== ".." ? id : null;
};
const text = (value, limit) => typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, limit) : "";
const dimension = value => Number.isSafeInteger(value) && value > 0 ? value : null;

// One upstream photo record, or null when it is unusable.
export function normalizePhoto(raw, base) {
  const id = photoId(raw?.id);
  if (!id || !raw.src || typeof raw.src !== "object") return null;
  const src = {};
  for (const [size, value] of Object.entries(raw.src)) {
    if (typeof value !== "string") continue;
    try {
      const url = new URL(value, `${base}/`);
      if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) src[size] = url.href;
    } catch { /* unusable size */ }
  }
  if (!Object.keys(src).length) return null;
  return { id, alt: text(raw.alt, 300), photographer: text(raw.photographer, 120), width: dimension(raw.width), height: dimension(raw.height), src };
}

// `what` names the request in user terms: `search "cat", page 2` or `photo 42`.
const upstreamError = (service, status, what, { photo, retryAfter } = {}) => {
  const context = { source: service.name, what, numbers: { status } };
  if (status === 401 || status === 403) return problem("pexels-auth", { ...context, hasKey: !!service.key });
  if (status === 429) {
    const seconds = Number(retryAfter);
    return problem("pexels-rate", { ...context, numbers: { status, ...(Number.isSafeInteger(seconds) && seconds >= 0 ? { retryAfter: seconds } : {}) } });
  }
  if (status === 404 && photo !== undefined) return problem("pexels-missing", { ...context, photo }, 404);
  return problem("pexels-http", context);
};

// Waiting for a response, and each gap while its body streams, has a deadline.
// A slow but steadily progressing download never expires; a stalled one does.
const watchdog = timeoutMs => {
  const controller = new AbortController();
  let timer = null, expired = false;
  return { signal: controller.signal, expired: () => expired,
    arm() { clearTimeout(timer); timer = setTimeout(() => { expired = true; controller.abort(); }, timeoutMs); },
    stop() { clearTimeout(timer); } };
};

// Upstream transport. The key accompanies a request only while its URL stays
// on the service's own origin, including across redirects.
// One bounded body reader for JSON and image replies: each chunk re-arms the
// stall deadline, and an oversized body is cancelled before it is buffered.
async function readBody(response, { limit, dog, signal, service, what, timeoutMs }) {
  const tooLarge = (bytes, declared) => problem("pexels-size", { source: service.name, what, declared, numbers: { bytes, limit } });
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) { await response.body?.cancel(); throw tooLarge(declared, true); }
  const chunks = [], reader = response.body?.getReader();
  let size = 0;
  dog.arm();
  try {
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      dog.arm();
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw tooLarge(size, false); }
      chunks.push(value);
    }
  } catch (error) {
    if (error.status || signal?.aborted) throw error;
    throw problem("pexels-stalled", { source: service.name, what, timeout: dog.expired(), numbers: { received: size, seconds: timeoutMs / 1000 } });
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export function makePexelsClient({ fetch = globalThis.fetch, timeoutMs = UPSTREAM_TIMEOUT_MS, maxJsonBytes = MAX_PEXELS_JSON_BYTES } = {}) {
  const photos = new Map();
  const cacheKey = (service, id) => JSON.stringify([service.id, service.url, id]);
  const remember = (service, photo) => {
    const key = cacheKey(service, photo.id);
    photos.delete(key); photos.set(key, photo);
    while (photos.size > PHOTO_CACHE_LIMIT) photos.delete(photos.keys().next().value);
  };

  async function request(service, href, signal, accept, dog, what) {
    const origin = new URL(service.url).origin;
    const combined = signal ? AbortSignal.any([signal, dog.signal]) : dog.signal;
    let url = href;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      dog.arm();
      const target = new URL(url);
      const headers = new Headers({ Accept: accept });
      if (service.key && target.origin === origin) headers.set("Authorization", service.key);
      let response;
      try { response = await fetch(target.href, { headers, signal: combined, redirect: "manual" }); }
      catch (error) {
        if (signal?.aborted) throw error;
        throw problem("pexels-unreachable", { source: service.name, what, timeout: dog.expired(), numbers: { seconds: timeoutMs / 1000 }, detail: cause(error) });
      }
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel();
        let next;
        try { next = new URL(location, target); }
        catch { throw problem("pexels-redirect", { source: service.name, what, detail: "the redirect location is not a valid address" }); }
        if (!["http:", "https:"].includes(next.protocol)) throw problem("pexels-redirect", { source: service.name, what, detail: `it redirected to an unsupported ${next.protocol} address` });
        url = next.href; continue;
      }
      return response;
    }
    throw problem("pexels-redirect", { source: service.name, what, detail: `it redirected more than ${MAX_REDIRECTS} times` });
  }

  async function json(service, path, params, signal, what) {
    const url = new URL(`${service.url}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    const dog = watchdog(timeoutMs);
    try {
      const response = await request(service, url.href, signal, "application/json", dog, what);
      if (!response.ok) { await response.body?.cancel(); return { status: response.status, retryAfter: response.headers.get("retry-after") }; }
      const bytes = await readBody(response, { limit: maxJsonBytes, dog, signal, service, what: `the reply for ${what}`, timeoutMs });
      try { return { status: response.status, data: JSON.parse(new TextDecoder().decode(bytes)) }; }
      catch { throw problem("pexels-reply", { source: service.name, what, detail: "the reply is not valid JSON" }); }
    } finally { dog.stop(); }
  }
  const listing = (query, page) => `${query ? `search ${JSON.stringify(query)}` : "curated photos"}, page ${page}`;
  // Curated or empty-search browsing is absent, not failing, only for these.
  const unsupported = status => [400, 404, 405, 501].includes(status);

  return {
    // Empty query browses curated photos. A compatible service without the
    // curated endpoint is a normal state, not an error.
    // Without a curated endpoint, an empty search may still list the catalogue
    // (self-hosted services often allow it); otherwise the picker asks for text.
    async photos(service, { query = "", page = 1, signal } = {}) {
      const search = query.trim(), params = { page, per_page: PEXELS_PAGE_SIZE }, what = listing(search, page);
      let mode = search ? "search" : "curated", { status, data, retryAfter } = await json(service, search ? "/v1/search" : "/v1/curated",
        { ...(search ? { query: search } : {}), ...params }, signal, what);
      if (!search && (status < 200 || status >= 300) && ![401, 403, 429].includes(status)) {
        const curatedStatus = status;
        ({ status, data, retryAfter } = await json(service, "/v1/search", { query: "", ...params }, signal, `the catalogue listing, page ${page}`));
        // A key or rate-limit problem is the real answer, never "search only".
        if ([401, 403, 429].includes(status)) throw upstreamError(service, status, `the catalogue listing, page ${page}`, { retryAfter });
        const listed = status >= 200 && status < 300 && Array.isArray(data?.photos) && !(page === 1 && !data.photos.length);
        if (!listed) {
          // "Search only" only when neither browse route exists; a failing server is an error.
          if (unsupported(curatedStatus) && (status >= 200 && status < 300 || unsupported(status)))
            return { mode: "curated", curated: false, page, more: false, photos: [] };
          throw problem("pexels-browse", { source: service.name, numbers: { curated: curatedStatus, listing: status },
            detail: `curated photos answered HTTP ${curatedStatus} and the catalogue listing answered HTTP ${status}` });
        }
        mode = "browse";
      }
      if (status < 200 || status >= 300) throw upstreamError(service, status, what, { retryAfter });
      if (!data || !Array.isArray(data.photos)) throw problem("pexels-reply", { source: service.name, what, detail: "it has no photo list" });
      const seen = new Set(), list = []; let invalid = 0, duplicates = 0;
      for (const raw of data.photos) {
        const photo = normalizePhoto(raw, service.url);
        if (!photo) { invalid++; continue; }
        if (seen.has(photo.id)) { duplicates++; continue; }
        seen.add(photo.id); remember(service, photo);
        list.push({ id: photo.id, alt: photo.alt, photographer: photo.photographer, width: photo.width, height: photo.height });
      }
      // Dropped records are never presented as "no matches".
      if (data.photos.length && !list.length) throw problem("pexels-records", { source: service.name, what, numbers: { received: data.photos.length } });
      const more = typeof data.next_page === "string" ? !!data.next_page
        : Number.isSafeInteger(data.total_results) ? data.total_results > page * PEXELS_PAGE_SIZE
        : data.photos.length >= PEXELS_PAGE_SIZE;
      return { mode, curated: true, page, more: more && data.photos.length > 0, photos: list,
        ...(invalid || duplicates ? { skipped: { source: service.name, received: data.photos.length, shown: list.length, invalid, duplicates, page } } : {}) };
    },

    async photo(service, id, signal) {
      if (!photoId(id)) throw problem("pexels-missing", { source: service.name, photo: String(id), what: "the photo", numbers: { status: 404 } }, 404);
      const cached = photos.get(cacheKey(service, id));
      if (cached) return cached;
      const { status, data, retryAfter } = await json(service, `/v1/photos/${encodeURIComponent(id)}`, {}, signal, `photo ${id}`);
      if (status < 200 || status >= 300) throw upstreamError(service, status, `photo ${id}`, { photo: id, retryAfter });
      // The requested ID names the record, however the service spells its own.
      const normalized = normalizePhoto({ ...data, id }, service.url);
      if (!normalized) throw problem("pexels-photo", { source: service.name, photo: id, field: data?.src && typeof data.src === "object" ? "http(s) image URL" : "image list (src)" });
      remember(service, normalized);
      return normalized;
    },

    async bytes(service, id, kind, signal) {
      const photo = await this.photo(service, id, signal);
      const dog = watchdog(timeoutMs);
      let bytes;
      try {
        const what = `photo ${id}`;
        const response = await request(service, pickSize(photo.src, kind), signal, "image/*", dog, what);
        if (!response.ok) { await response.body?.cancel(); throw upstreamError(service, response.status, what, { photo: id, retryAfter: response.headers.get("retry-after") }); }
        bytes = await readBody(response, { limit: MAX_PEXELS_IMAGE_BYTES, dog, signal, service, what, timeoutMs });
      } finally { dog.stop(); }
      const mime = sniffMime(bytes);
      if (!IMAGE_MIME.has(mime)) throw problem("pexels-mime", { source: service.name, photo: id, detected: bytes.length ? mime ?? "unrecognized content" : "empty file" });
      return { bytes, mime, extension: IMAGE_MIME.get(mime) };
    },

    // One real first-page query, the same one the picker makes first.
    async check(service, signal) {
      try {
        const first = await this.photos(service, { signal });
        if (!first.curated) await this.photos(service, { query: "a", signal });
        return { ok: true, browse: first.curated };
      } catch (error) {
        if (signal?.aborted) throw error;
        return { ok: false, error: error.message, ...(error.problem ? { problem: error.problem } : {}) };
      }
    },

    forget(serviceId) { for (const key of [...photos.keys()]) if (JSON.parse(key)[0] === serviceId) photos.delete(key); },
  };
}

const errorResponse = error => Response.json({ error: error.message, ...(error.problem ? { problem: error.problem } : {}) }, { status: error.status ?? 500 });

// Routes mount under /api/features/variations/pexels.
export function registerPexels(app, { services: injected = null, client: injectedClient = null } = {}) {
  const client = injectedClient ?? makePexelsClient({ fetch: app.fetch });
  const services = injected ?? (app.paths?.state ? new PexelsServices(join(app.paths.state, "pexels-services.json"), { changed: id => client.forget(id) }) : null);
  const route = (method, path, handler) => app.route(method, `/pexels${path}`, async (req, params) => {
    if (!services) return errorResponse(problem("pexels-config", { detail: "Pexels services need an engine state directory; none is configured" }, 503));
    try { return await handler(req, params); } catch (error) { return errorResponse(error); }
  });
  const body = async req => { try { return await readJson(req); } catch { throw problem("pexels-request", { operation: "save", field: "service details", detail: "Service details must be JSON" }, 400); } };
  const page = (req, service) => {
    const raw = new URL(req.url).searchParams.get("page") ?? "1", value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1) throw problem("pexels-request", { operation: "load photos from", source: service.name, field: "page", value: raw, detail: "Page must be a whole number from 1" }, 400);
    return value;
  };

  route("GET", "/services", async () => Response.json({ services: await services.list() }));
  route("POST", "/services", async req => Response.json(await services.create(await body(req)), { status: 201 }));
  route("PATCH", "/services/<id>", async (req, { id }) => Response.json(await services.update(id, await body(req))));
  route("DELETE", "/services/<id>", async (_req, { id }) => { await services.remove(id); return Response.json({ removed: true }); });
  route("GET", "/services/<id>/status", async (req, { id }) => Response.json(await client.check(await services.get(id), req.signal)));
  route("GET", "/services/<id>/photos", async (req, { id }) => {
    const query = new URL(req.url).searchParams.get("query") ?? "";
    const service = await services.get(id);
    return Response.json(await client.photos(service, { query, page: page(req, service), signal: req.signal }));
  });
  // Photo addresses carry the service URL they were listed from, so a cached
  // response can never stand in for a photo after the service changes.
  for (const kind of ["thumbnail", "image"]) route("GET", `/services/<id>/photos/<photo>/${kind}`, async (req, { id, photo }) => {
    const listed = new URL(req.url).searchParams.get("service"), service = await services.get(id);
    if (listed === null) throw problem("pexels-binding", { source: service.name, photo, detail: "the photo address does not name its service URL" }, 400);
    if (listed !== service.url) throw problem("pexels-binding", { source: service.name, photo, detail: `${service.name}'s URL changed since this photo was listed` }, 409);
    const { bytes, mime } = await client.bytes(service, photo, kind, req.signal);
    return new Response(bytes, { headers: mediaHeaders({ "Content-Type": mime, "Cache-Control": "private, max-age=3600" }) });
  });
  return { services, client };
}
