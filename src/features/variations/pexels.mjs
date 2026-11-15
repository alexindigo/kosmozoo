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
const controls = /[\x00-\x1f\x7f]/;

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
  if (!name || name.length > 60 || controls.test(name)) throw fail("Enter a name of up to 60 characters");
  return name;
};
const validKey = raw => {
  const key = typeof raw === "string" ? raw.trim() : "";
  if (!key || controls.test(key)) throw fail("An API key can't contain line breaks or control characters");
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
      catch (error) { if (error instanceof Deno.errors.NotFound) { this.#services = []; return; } throw error; }
      let doc;
      try { doc = JSON.parse(text); } catch { doc = null; }
      const services = doc?.version === 1 && Array.isArray(doc.data?.services) ? doc.data.services : null;
      if (!services || services.some(item => !item || typeof item.id !== "string" || typeof item.name !== "string" || typeof item.url !== "string" ||
          !(item.key === undefined || typeof item.key === "string")))
        throw fail(`Pexels services file ${this.#path} is unreadable; fix or remove it`, 500);
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

  async #save(next) {
    await this.#writer.write(new TextEncoder().encode(JSON.stringify({ version: 1, data: { services: next } }, null, 2)));
    this.#services = next;
  }

  async list() { await this.#load(); return this.#services.map(redactService); }

  #find(id) {
    const service = this.#services.find(item => item.id === id);
    if (!service) throw fail("This Pexels service was removed", 404);
    return { ...service };
  }

  async get(id) { await this.#load(); return this.#find(id); }

  #unique(name, except = null) {
    if (this.#services.some(item => item.id !== except && item.name.toLowerCase() === name.toLowerCase())) throw fail("A service with this name already exists", 409);
  }

  create(body) { return this.#mutate(async () => {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw fail("Service details must be an object");
    if (this.#services.length >= MAX_PEXELS_SERVICES) throw fail(`Up to ${MAX_PEXELS_SERVICES} services can be added`);
    const name = validName(body.name), url = serviceBase(body.url);
    const key = body.key === undefined || body.key === null || body.key === "" ? null : validKey(body.key);
    this.#unique(name);
    const service = { id: crypto.randomUUID(), name, url, ...(key ? { key } : {}) };
    await this.#save([...this.#services, service]);
    return redactService(service);
  }); }

  // Omitted key keeps the saved one, null clears it, a string replaces it.
  update(id, body) { return this.#mutate(async () => {
    const current = this.#find(id);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw fail("Service details must be an object");
    const next = { ...current };
    if (body.name !== undefined) next.name = validName(body.name);
    if (body.url !== undefined) next.url = serviceBase(body.url);
    if (body.key === null) delete next.key;
    else if (body.key !== undefined) next.key = validKey(body.key);
    this.#unique(next.name, id);
    await this.#save(this.#services.map(item => item.id === id ? next : item));
    this.#changed(id);
    return redactService(next);
  }); }

  remove(id) { return this.#mutate(async () => {
    this.#find(id);
    await this.#save(this.#services.filter(item => item.id !== id));
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

const upstreamError = (service, status) => status === 401 || status === 403 ? fail(service.key ? `${service.name} rejected the API key` : `${service.name} needs an API key`, 502)
  : status === 429 ? fail(`${service.name} rate limit reached; try again later`, 502)
  : status === 404 ? fail(`${service.name} doesn't have this photo`, 404)
  : fail(`${service.name} answered HTTP ${status}`, 502);

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
async function readBody(response, { limit, dog, signal, service, what }) {
  const tooLarge = () => fail(`${service.name} sent ${what} larger than ${Math.round(limit / 1024 / 1024)} MB`, 502);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) { await response.body?.cancel(); throw tooLarge(); }
  const chunks = [], reader = response.body?.getReader();
  let size = 0;
  dog.arm();
  try {
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      dog.arm();
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw tooLarge(); }
      chunks.push(value);
    }
  } catch (error) {
    if (error.status || signal?.aborted) throw error;
    throw fail(dog.expired() ? `${service.name} stopped sending ${what}` : `${service.name} broke off sending ${what}`, 502);
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

  async function request(service, href, signal, accept, dog) {
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
        throw fail(dog.expired() ? `${service.name} didn't answer in time` : `Couldn't reach ${service.name}`, 502);
      }
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel();
        const next = new URL(location, target);
        if (!["http:", "https:"].includes(next.protocol)) throw fail(`${service.name} redirected to an unsupported address`, 502);
        url = next.href; continue;
      }
      return response;
    }
    throw fail(`${service.name} redirected too many times`, 502);
  }

  async function json(service, path, params, signal) {
    const url = new URL(`${service.url}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    const dog = watchdog(timeoutMs);
    try {
      const response = await request(service, url.href, signal, "application/json", dog);
      if (!response.ok) { await response.body?.cancel(); return { status: response.status }; }
      const bytes = await readBody(response, { limit: maxJsonBytes, dog, signal, service, what: "a reply" });
      try { return { status: response.status, data: JSON.parse(new TextDecoder().decode(bytes)) }; }
      catch { throw fail(`${service.name} sent an unreadable answer`, 502); }
    } finally { dog.stop(); }
  }

  return {
    // Empty query browses curated photos. A compatible service without the
    // curated endpoint is a normal state, not an error.
    // Without a curated endpoint, an empty search may still list the catalogue
    // (self-hosted services often allow it); otherwise the picker asks for text.
    async photos(service, { query = "", page = 1, signal } = {}) {
      const search = query.trim(), params = { page, per_page: PEXELS_PAGE_SIZE };
      let mode = search ? "search" : "curated", { status, data } = await json(service, search ? "/v1/search" : "/v1/curated",
        { ...(search ? { query: search } : {}), ...params }, signal);
      if (!search && (status < 200 || status >= 300) && ![401, 403, 429].includes(status)) {
        ({ status, data } = await json(service, "/v1/search", { query: "", ...params }, signal));
        // A key or rate-limit problem is the real answer, never "search only".
        if ([401, 403, 429].includes(status)) throw upstreamError(service, status);
        if (status < 200 || status >= 300 || !Array.isArray(data?.photos) || page === 1 && !data.photos.length)
          return { mode: "curated", curated: false, page, more: false, photos: [] };
        mode = "browse";
      }
      if (status < 200 || status >= 300) throw upstreamError(service, status);
      if (!data || !Array.isArray(data.photos)) throw fail(`${service.name} sent no photo list`, 502);
      const seen = new Set(), list = [];
      for (const raw of data.photos) {
        const photo = normalizePhoto(raw, service.url);
        if (!photo || seen.has(photo.id)) continue;
        seen.add(photo.id); remember(service, photo);
        list.push({ id: photo.id, alt: photo.alt, photographer: photo.photographer, width: photo.width, height: photo.height });
      }
      // Dropped records are never presented as "no matches".
      if (data.photos.length && !list.length) throw fail(`${service.name} sent ${data.photos.length} photos without a usable ID, image or thumbnail link`, 502);
      const more = typeof data.next_page === "string" ? !!data.next_page
        : Number.isSafeInteger(data.total_results) ? data.total_results > page * PEXELS_PAGE_SIZE
        : data.photos.length >= PEXELS_PAGE_SIZE;
      return { mode, curated: true, page, more: more && data.photos.length > 0, photos: list };
    },

    async photo(service, id, signal) {
      if (!photoId(id)) throw fail("Unknown photo", 404);
      const cached = photos.get(cacheKey(service, id));
      if (cached) return cached;
      const { status, data } = await json(service, `/v1/photos/${encodeURIComponent(id)}`, {}, signal);
      if (status < 200 || status >= 300) throw upstreamError(service, status);
      // The requested ID names the record, however the service spells its own.
      const normalized = normalizePhoto({ ...data, id }, service.url);
      if (!normalized) throw fail(`${service.name} sent an unusable photo`, 502);
      remember(service, normalized);
      return normalized;
    },

    async bytes(service, id, kind, signal) {
      const photo = await this.photo(service, id, signal);
      const dog = watchdog(timeoutMs);
      let bytes;
      try {
        const response = await request(service, pickSize(photo.src, kind), signal, "image/*", dog);
        if (!response.ok) { await response.body?.cancel(); throw upstreamError(service, response.status); }
        bytes = await readBody(response, { limit: MAX_PEXELS_IMAGE_BYTES, dog, signal, service, what: "the photo" });
      } finally { dog.stop(); }
      const mime = sniffMime(bytes);
      if (!IMAGE_MIME.has(mime)) throw fail(`${service.name} sent a file that isn't a supported image`, 502);
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
        return { ok: false, error: error.message };
      }
    },

    forget(serviceId) { for (const key of [...photos.keys()]) if (JSON.parse(key)[0] === serviceId) photos.delete(key); },
  };
}

const errorResponse = error => Response.json({ error: error.message }, { status: error.status ?? 500 });

// Routes mount under /api/features/variations/pexels.
export function registerPexels(app, { services: injected = null, client: injectedClient = null } = {}) {
  const client = injectedClient ?? makePexelsClient({ fetch: app.fetch });
  const services = injected ?? (app.paths?.state ? new PexelsServices(join(app.paths.state, "pexels-services.json"), { changed: id => client.forget(id) }) : null);
  const route = (method, path, handler) => app.route(method, `/pexels${path}`, async (req, params) => {
    if (!services) return Response.json({ error: "Pexels services need an engine state directory" }, { status: 503 });
    try { return await handler(req, params); } catch (error) { return errorResponse(error); }
  });
  const body = async req => { try { return await readJson(req); } catch { throw fail("Service details must be JSON"); } };
  const page = req => {
    const value = Number(new URL(req.url).searchParams.get("page") ?? 1);
    if (!Number.isSafeInteger(value) || value < 1) throw fail("Page must be a whole number from 1");
    return value;
  };

  route("GET", "/services", async () => Response.json({ services: await services.list() }));
  route("POST", "/services", async req => Response.json(await services.create(await body(req)), { status: 201 }));
  route("PATCH", "/services/<id>", async (req, { id }) => Response.json(await services.update(id, await body(req))));
  route("DELETE", "/services/<id>", async (_req, { id }) => { await services.remove(id); return Response.json({ removed: true }); });
  route("GET", "/services/<id>/status", async (req, { id }) => Response.json(await client.check(await services.get(id), req.signal)));
  route("GET", "/services/<id>/photos", async (req, { id }) => {
    const query = new URL(req.url).searchParams.get("query") ?? "";
    return Response.json(await client.photos(await services.get(id), { query, page: page(req), signal: req.signal }));
  });
  for (const kind of ["thumbnail", "image"]) route("GET", `/services/<id>/photos/<photo>/${kind}`, async (req, { id, photo }) => {
    const { bytes, mime } = await client.bytes(await services.get(id), photo, kind, req.signal);
    return new Response(bytes, { headers: mediaHeaders({ "Content-Type": mime, "Cache-Control": "private, max-age=3600" }) });
  });
  return { services, client };
}
