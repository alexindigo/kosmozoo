// src/routes.mjs — dispatch table for the public engine API.
//
// Collections + entries are the resources (spec ). Plugin routes live
// under /api/plugins/<name>/... and are registered by the plugin host.
// The context arrives fully built (plugins included) — makeRouter never
// reassigns or guards it (E1).

import { backingFor as defaultBackingFor, isFolderHost, EXT_MIME, validEntryName } from "./backings/index.mjs";
import { capabilities, normalizeAddress, validateCollection, validateAttributes, sourceAttributes } from "./collections.mjs";
import { sniffMime } from "./extractor.mjs";
import { sourceOrigin, sameOrigin, expectedOrigin } from "./source-origin.mjs";
import { waitFor } from "./lifetime.mjs";
import { isContentHash } from "./cache.mjs";
import { isResourceRoot } from "./parameters.mjs";
import { mediaKind } from "./backings/mime.mjs";

// Byte routes name the resource root explicitly; absent keeps the historical
// output meaning, an unknown root fails instead of falling back to another root.
const byteRoot = url => { const kind = url.searchParams.get("kind") ?? "output"; return isResourceRoot(kind) ? kind : null; };

// The bounded wait of one shown entry's record for its own ingestion.
const ENTRY_META_WAIT_MS = 8000;

const mediaType = req => (req.headers.get("Content-Type") ?? "").split(";", 1)[0].trim().toLowerCase();
class UnsupportedMediaType extends Error {}

// JSON parsing is an HTTP boundary, not just JSON.parse on arbitrary bytes.
// Features share it so a multipart/binary exception cannot bypass JSON policy.
export function readJson(req, { parse = JSON.parse } = {}) {
  if (mediaType(req) !== "application/json") throw new UnsupportedMediaType("Content-Type must be application/json");
  return req.text().then(parse);
}

// Original contributor bytes may be active documents on direct navigation.
// Keep native image/media display while removing script and origin authority.
export function mediaHeaders(init) {
  const headers = new Headers(init);
  headers.set("Content-Security-Policy", "sandbox");
  headers.set("X-Content-Type-Options", "nosniff");
  return headers;
}

// One media/validator/range owner for live resources and durable archive members.
export function bytesResponse(req, bytes, hash, mime) {
  const etag = `"${hash}"`;
  const h = mediaHeaders({ ETag: etag, "Cache-Control": "no-cache" });
  if (req.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers: h });
  if (mime) h.set("Content-Type", mime);
  h.set("Content-Length", String(bytes.length));
  h.set("Accept-Ranges", "bytes");
  const range = req.headers.get("Range"), ifRange = req.headers.get("If-Range");
  const match = range && (!ifRange || ifRange === etag) && /^bytes=(\d*)-(\d*)$/.exec(range);
  if (match && (match[1] || match[2])) {
    const size = bytes.length;
    const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
    const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
      h.set("Content-Range", `bytes */${size}`); h.set("Content-Length", "0");
      return new Response(null, { status: 416, headers: h });
    }
    h.set("Content-Range", `bytes ${start}-${end}/${size}`); h.set("Content-Length", String(end - start + 1));
    return new Response(bytes.subarray(start, end + 1), { status: 206, headers: h });
  }
  return new Response(bytes, { headers: h });
}

function mutationError(req, url) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return null;
  const origin = req.headers.get("Origin"), site = req.headers.get("Sec-Fetch-Site");
  if ((origin !== null && origin !== url.origin) || (site !== null && !["same-origin", "none"].includes(site))) {
    return Response.json({ error: "Mutations require the engine's own browser origin" }, { status: 403 });
  }
  // A server Request may expose an empty stream even for bodyless DELETE.
  // Reject explicit simple/unknown media types here; readJson enforces the
  // required JSON type at its parser, without guessing body presence or reading
  // upload streams. Origin-less API clients and bodyless operations still work.
  const type = mediaType(req);
  if (type && !["application/json", "multipart/form-data", "application/octet-stream"].includes(type)) {
    return Response.json({ error: "Use application/json, multipart/form-data or application/octet-stream" }, { status: 415 });
  }
  return null;
}

export function makeRouter(ctx) {
  const routes = [];
  const backingFor = ctx.backings?.backingFor ?? defaultBackingFor;
  const addressFor = id => Object.hasOwn(ctx.hosts, id) ? ctx.hosts[id] : null;

  const add = (method, pattern, handler) => {
    // pattern: "/api/collections/<id>/entries/<name>" — segments, "<x>" captures one segment
    const parts = pattern.split("/").filter(Boolean);
    routes.push({ method, parts, handler, namedEntry: pattern.startsWith("/api/collections/<id>/entries/<name>") });
  };

  const match = (method, pathname) => {
    const segs = pathname.split("/").filter(Boolean);
    for (const r of routes) {
      if (r.method !== method) continue;
      if (r.parts.length !== segs.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < segs.length; i++) {
        const p = r.parts[i];
        if (p.startsWith("<") && p.endsWith(">")) params[p.slice(1, -1)] = decodeURIComponent(segs[i]);
        else if (p !== segs[i]) { ok = false; break; }
      }
      if (ok) return { handler: r.handler, params, namedEntry: r.namedEntry };
    }
    return null;
  };

  const useAssetsPlus = () => ctx.settings.get("core.delete", "useAssetsPlus", true);
  const byteOriginError = (req, id) => {
    let expected;
    try { expected = expectedOrigin(req); } catch (error) { return Response.json({ error: error.message }, { status: 400 }); }
    if (expected && !sameOrigin(expected, sourceOrigin(id, ctx.sourceActivity.source(id)))) return Response.json({ error: "Source origin changed" }, { status: 412 });
    return null;
  };

  // One joined row (entry ⟕ content, judgment columns included) → the wire
  // shape. No further queries: the listing maps rows from ONE statement, and
  // a name with no row is a fresh entry (state 'seen').
  const entryShape = (collection, name, size, row = null,
    modified = ctx.inventory.peek?.(collection)?.items.find((item) => item.name === name)?.modified ?? null) => {
    const r = row;
    let meta = null;
    if (r?.meta) { try { meta = JSON.parse(r.meta); } catch { /* corrupt */ } }
    let judgment = null;
    if (r && (r.vote != null || r.favorite != null || r.bookmark != null || r.notes != null || r.plugin_fields != null)) {
      judgment = {};
      if (r.vote != null) judgment.vote = r.vote;
      if (r.favorite != null) judgment.favorite = !!r.favorite;
      if (r.bookmark != null) judgment.bookmark = !!r.bookmark;
      if (r.notes != null) { try { judgment.notes = JSON.parse(r.notes); } catch { /* corrupt */ } }
      if (r.plugin_fields != null) { try { judgment.plugins = JSON.parse(r.plugin_fields); } catch { /* corrupt */ } }
    }
    return {
      name,
      size: size ?? r?.bytes ?? null,
      hash: r?.hash ?? null,
      state: r?.state ?? "seen",
      meta,
      extracted: r?.hash != null,
      judgment,
      // dims: content (ingested) wins; the entry's own columns carry the
      // dims pass's head-read result before the hash exists
      width: r?.width ?? null,
      height: r?.height ?? null,
      modified,
    };
  };

  // --- collections -----------------------------------------------------------

  add("GET", "/api/events", req => ctx.sourceActivity.open(req));

  add("GET", "/api/collections", async () => {
    const out = [];
    // Capture identity and committed attributes before any asynchronous probe.
    for (const [id, source] of Object.entries(ctx.sourceActivity.snapshot().sources)) {
      const { address, kind, pinned, autoRefresh, incarnation, sourceVersion } = source;
      const c = { address, kind };
      const comfy = ctx.inventory.binding(address);
      const online = await backingFor(address).probe(address);
      out.push([id, {
        address, kind, pinned, autoRefresh, incarnation, sourceVersion,
        online,
        capabilities: await capabilities(c, {
          online,
          useAssetsPlus: useAssetsPlus(),
          comfy,
        }),
      }]);
    }
    return Response.json(Object.fromEntries(out));
  });

  // Collections are user-managed at runtime (source-backed only in this plan).
  add("POST", "/api/collections", async (req) => {
    let body;
    try {
      body = await readJson(req);
    } catch {
      return Response.json({ error: "JSON body: {name, address}" }, { status: 400 });
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json({ error: "JSON body: {name, address}" }, { status: 400 });
    }
    const { name, address: inputAddress, ...attributes } = body;
    const { address, error } = normalizeAddress(inputAddress);
    const err = validateAttributes(attributes) ?? error ?? await validateCollection(name, address);
    if (err) return Response.json({ error: err }, { status: 400 });
    if (!ctx.sourceActivity.acceptingChanges()) return Response.json({ error: "sources are stopping" }, { status: 503 });
    // an existing id with a different address is a conflict, not a silent
    // re-point (every entry/judgment under the id would change host)
    const existing = ctx.store.collectionGet(name);
    if (existing && existing.address !== address) {
      return Response.json(
        { error: `collection "${name}" already exists with address ${existing.address}` },
        { status: 409 },
      );
    }
    ctx.store.collectionAdd(name, address, attributes);
    const { activity: _activity, ...source } = ctx.sourceActivity.source(name);
    const sourceCursor = ctx.sourceActivity.cursor();
    return Response.json({
      name,
      ...source,
      sourceCursor,
      online: await backingFor(address).probe(address),
    });
  });

  add("PATCH", "/api/collections/<id>", async (req, { id }) => {
    let patch;
    try { patch = await readJson(req); }
    catch { return Response.json({ error: "source attributes must be JSON" }, { status: 400 }); }
    const error = validateAttributes(patch);
    if (error) return Response.json({ error }, { status: 400 });
    if (!ctx.sourceActivity.acceptingChanges()) return Response.json({ error: "sources are stopping" }, { status: 503 });
    if (!ctx.store.collectionGet(id)) return Response.json({ error: "unknown collection" }, { status: 404 });
    const row = ctx.store.collectionPatch(id, patch);
    const sourceVersion = ctx.sourceActivity.source(id)?.sourceVersion ?? null;
    return Response.json({ id, ...sourceAttributes(row), sourceVersion });
  });

  add("DELETE", "/api/collections/<id>", async (_req, { id }) => {
    if (!ctx.sourceActivity.acceptingChanges()) return Response.json({ error: "sources are stopping" }, { status: 503 });
    if (!Object.hasOwn(ctx.hosts, id)) return Response.json({ error: "unknown collection" }, { status: 404 });
    if (Object.keys(ctx.hosts).length === 1) {
      return Response.json({ error: "cannot remove the last collection" }, { status: 400 });
    }
    const before = ctx.sourceActivity.source(id);
    ctx.store.collectionRemove(id);
    return Response.json({ removed: id, sourceCursor: ctx.sourceActivity.cursor(),
      sourceVersion: { ...before.sourceVersion, attributesRevision: ctx.store.collectionRevision(id) } });
  });

  // The portable judgment document, generated on demand per collection.
  add("GET", "/api/collections/<id>/feedback.json", async (_req, { id }) => {
    const doc = ctx.store.feedbackExport(id);
    if (!doc) return Response.json({ error: "unknown collection" }, { status: 404 });
    return new Response(JSON.stringify(doc, null, 2), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="kosmozoo_${id}_feedback.json"`,
      },
    });
  });

  // Engine-owned cached identity only: no SQL/source/plugin inspection here.
  add("GET", "/api/runtime", () => {
    const runtime = ctx.runtime?.();
    return runtime ? Response.json({ ...runtime, app: ctx.appVersion }) : Response.json({ error: "Runtime identity unavailable" }, { status: 503 });
  });

  // --- entries ----------------------------------------------------------------

  // The feed listing (kind=output, the default) or the input-dir listing
  // (kind=input). Hidden/gone entries stay out of every output listing.
  add("GET", "/api/collections/<id>/entries", async (req, { id }, url) => {
    const addr = addressFor(id);
    if (!addr) return Response.json({ error: "unknown collection" }, { status: 404 });
    const token = ctx.inventory.capture?.(id);
    const kind = url.searchParams.get("kind") ?? "output";
    // Only the output inventory and the input listing exist; other roots never
    // fall back to the output listing.
    if (kind !== "input" && kind !== "output") return Response.json({ error: "no listing for this resource root" }, { status: 400 });
    const catalogue = url.searchParams.get("catalogue") === "images-v1";
    let catalogueOrigin = null;
    if (catalogue) {
      let expected;
      try { expected = expectedOrigin(req); } catch (error) { return Response.json({ error: error.message }, { status: 400 }); }
      if (!expected) return Response.json({ error: "Image catalogue requires an expected origin" }, { status: 400 });
      catalogueOrigin = sourceOrigin(id, ctx.sourceActivity.source(id));
      if (!sameOrigin(expected, catalogueOrigin)) return Response.json({ error: "Source origin changed" }, { status: 412 });
    }
    const catalogueCurrent = () => (!token || ctx.inventory.isCurrent(token)) && sameOrigin(catalogueOrigin, sourceOrigin(id, ctx.sourceActivity.source(id)));
    const images = files => files.filter(file => mediaKind(typeof file === "string" ? file : file.name) === "image");
    if (kind === "input") {
      let expected;
      try { expected = expectedOrigin(req); } catch (error) { return Response.json({ error: error.message }, { status: 400 }); }
      const origin = sourceOrigin(id, ctx.sourceActivity.source(id));
      if (expected && !sameOrigin(expected, origin)) return Response.json({ error: "Source origin changed" }, { status: 412 });
      try {
        const files = await backingFor(addr).list(addr, "input");
        if (catalogue) return catalogueCurrent() ? Response.json({ files: images(files), origin: catalogueOrigin, root: kind }) : Response.json({ error: "Source origin changed" }, { status: 412 });
        if (!ctx.inventory.isCurrent(token)) return Response.json({ error: "Source origin changed" }, { status: 412 });
        return Response.json(expected ? { files, origin } : files);
      } catch (e) {
        return Response.json({ error: `collection unreachable: ${e.message}` }, { status: 502 });
      }
    }
    // The listing comes from the backing; the store overlays judgment + dims
    // in ONE joined statement (no per-entry queries). A backing-listed name
    // with a gone/hidden row is dropped here; a name with no row is fresh.
    let inventory;
    try { inventory = await ctx.inventory(id); }
    catch (error) { return Response.json({ error: `collection unreachable: ${error.message}` }, { status: 502 }); }
    if (catalogue && !catalogueCurrent()) return Response.json({ error: "Source origin changed" }, { status: 412 });
    if (token && !ctx.inventory.isCurrent(token)) return Response.json({ error: "Source incarnation changed" }, { status: 409 });
    inventory = ctx.inventory.accepted?.(token) ?? inventory;
    const list = inventory.items;
    // The rows below reflect every metadata write up to this version: a reader
    // that accepted this listing continues the delta stream from it.
    const metaVersion = ctx.store.metaVersion;
    const rows = new Map(ctx.store.entriesForCollection(id).map((r) => [r.name, r]));
    const visible = list.filter((f) => {
      const r = rows.get(f.name);
      return !r || (r.state !== "gone" && r.hidden !== 1);
    });
    const entries = visible.map((f) => entryShape(id, f.name, f.size, rows.get(f.name), f.modified));
    if (catalogue) return Response.json({ files: images(entries), origin: catalogueOrigin, root: kind });
    const arrivals = ctx.store.arrivals.inventory(id);
    for (const entry of entries) entry.arrivalSeq = arrivals?.sequences[entry.name] ?? null;
    const items = url.searchParams.get('arrivals') === 'items-v1';
    return Response.json(url.searchParams.get("inventory") === "1"
      ? { revision: inventory.revision, generation: inventory.generation, coverage: inventory.coverage, subfolders: inventory.subfolders,
          folders: inventory.folders, unavailable: inventory.unavailable, chronology: inventory.chronology, metaVersion,
          ...(items ? { origin: sourceOrigin(id, ctx.sourceActivity.source(id)) } : {}),
          arrivals: arrivals ? { sequence: arrivals.sequence, latestVisibleSeq: arrivals.latestVisibleSeq,
            ...(items ? { revision: arrivals.revision, visibleRanges: arrivals.visibleRanges } : {}) } : null, entries } : entries);
  });

  add("GET", "/api/collections/<id>/entries/<name>", async (_req, { id, name }) => {
    if (!addressFor(id)) return Response.json({ error: "unknown collection" }, { status: 404 });
    return Response.json(entryShape(id, name, null, ctx.store.entryJoined(id, name)));
  });

  // Upload one image into a comfy collection's input dir (multipart field
  // "image") — the browser can't post to ComfyUI directly (cross-origin).
  add("POST", "/api/collections/<id>/entries", async (req, { id }) => {
    if (!ctx.sourceActivity.acceptingChanges()) return Response.json({ error: "Sources are stopping; no upload was admitted" }, { status: 503 });
    const addr = addressFor(id);
    if (!addr) return Response.json({ error: "unknown collection" }, { status: 404 });
    const token = ctx.inventory.capture(id);
    const origin = sourceOrigin(id, ctx.sourceActivity.source(id));
    let expected;
    try { expected = expectedOrigin(req); } catch (error) { return Response.json({ error: error.message }, { status: 400 }); }
    if (expected && !sameOrigin(expected, origin)) return Response.json({ error: "Source origin changed" }, { status: 412 });
    let form;
    try { form = await req.formData(); }
    catch { return Response.json({ error: "multipart form required" }, { status: 400 }); }
    const file = form.get("image");
    if (!file || typeof file === "string") {
      return Response.json({ error: "no image file in form" }, { status: 400 });
    }
    const backing = backingFor(addr);
    if (!backing.write) return Response.json({ error: "this collection has no upload" }, { status: 400 });
    if (!validEntryName(addr, file.name)) return Response.json({ error: "bad entry path" }, { status: 400 });
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!ctx.sourceActivity.acceptingChanges() || !ctx.inventory.isCurrent(token)) return Response.json({ error: "Source origin changed before upload" }, { status: 412 });
    const r = await backing.write(addr, file.name, bytes);
    if (!r.ok) {
      // 409: the name already exists in the input dir — say WHICH name
      return Response.json(
        { error: r.error, ...(r.status === 409 ? { name: file.name } : {}) },
        { status: r.status },
      );
    }
    if (!ctx.sourceActivity.acceptingChanges() || !ctx.inventory.isCurrent(token)) return Response.json({ error: "Source changed after upload; no follow-up was authorized", uploaded: { name: r.name, origin } }, { status: 412 });
    return Response.json(expected ? { name: r.name, origin } : { name: r.name });
  });

  // Delete an entry from its source, per the collection's delete capability:
  // folder → unlink; comfy + assets_plus → trash; else hide + history cleanup.
  add("DELETE", "/api/collections/<id>/entries/<name>", async (_req, { id, name }) => {
    const addr = addressFor(id);
    if (!addr) return Response.json({ error: "unknown collection" }, { status: 404 });
    const c = ctx.store.collectionGet(id) ?? { id, kind: isFolderHost(addr) ? "folder" : "comfy", address: addr };
    // DELETE probes too (cheap, cached by the assets-plus TTL): an
    // unreachable host answers "hide" — try and report, never guess trash
    const caps = await capabilities(c, {
      online: await backingFor(addr).probe(addr),
      useAssetsPlus: useAssetsPlus(),
      comfy: ctx.comfy?.(id) ?? null,
    });
    const backing = backingFor(addr);
    if (caps.delete === "unlink" || caps.delete === "trash") {
      const res = await backing.remove(addr, name);
      if (!res.ok) return Response.json({ error: res.detail }, { status: 409 });
      ctx.store.arrivals.remove(id, name);
      return Response.json({ deleted: true, mode: res.mode });
    }
    ctx.store.entryHide(id, name);
    const historyCleared = (await backing.historyDelete?.(addr, name)) ?? false;
    return Response.json({ deleted: true, mode: "hide", historyCleared });
  });

  add("HEAD", "/api/collections/<id>/entries/<name>/bytes", async (req, { id, name }, url) => {
    if (!addressFor(id)) return new Response(null, { status: 404 });
    const error = byteOriginError(req, id); if (error) return error;
    const kind = byteRoot(url);
    if (!kind) return new Response(null, { status: 400 });
    const e = ctx.store.entryGet(id, name, kind);
    if (!e?.hash) return new Response(null, { status: 404 }); // E7: unknown says so
    const c = ctx.store.contentGet(e.hash);
    return new Response(null, {
      status: 200,
      headers: c?.bytes != null ? { "content-length": String(c.bytes) } : {},
    });
  });

  // Bytes, cache-first, with validators (the URL never changes when content
  // is remapped: no-cache + ETag = the content hash).
  add("GET", "/api/collections/<id>/entries/<name>/bytes", async (req, { id, name }, url) => {
    if (!addressFor(id)) return new Response("unknown collection", { status: 404 });
    const token = ctx.inventory.capture?.(id);
    const error = byteOriginError(req, id); if (error) return error;
    const priority = url.searchParams.get("priority") ?? "foreground";
    if (!["foreground", "background"].includes(priority)) return Response.json({ error: "bad priority" }, { status: 400 });
    const kind = byteRoot(url);
    if (!kind) return Response.json({ error: "unknown resource root" }, { status: 400 });
    const mime = EXT_MIME[name.split(".").pop().toLowerCase()];
    const makeResponse = (bytes, hash) => bytesResponse(req, bytes, hash, mime);

    // Cache hit: serve + debounced revalidation (the NEXT request gets fresh
    // bytes if the source was rewritten under the same name).
    const info = kind === "output"
      ? ctx.store.fileInfo(id, name)
      : ctx.store.resourceCacheGet(id, name, kind);
    if (info?.hash) {
      const cached = await ctx.cache.get(info.hash);
      if (token && !ctx.inventory.isCurrent(token)) return Response.json({ error: "Source incarnation changed" }, { status: 409 });
      if (cached) {
        ctx.ingest.scheduleRevalidate(id, name, { kind });
        return makeResponse(cached, info.hash);
      }
    }

    // Read through the one ingestion path. Explicit background intent stays
    // low; legacy/foreground callers retain the reserved high lane.
    // A failing backing is a 502 carrying the reason; no direct backing
    // read in a route, no swallowed errors.
    const got = await ctx.ingest.ensure(id, name, kind, { priority: priority === "background" ? "low" : "high" });
    if (token && !ctx.inventory.isCurrent(token)) return Response.json({ error: "Source incarnation changed" }, { status: 409 });
    if (got.status === 200) return makeResponse(got.bytes, got.hash);
    if (got.status === 400) return new Response("bad filename", { status: 400 });
    if (got.status === 404) return new Response("not found", { status: 404 });
    return Response.json({ error: `backing read failed: status ${got.status}` }, { status: 502 });
  });

  // One shown entry's metadata record, independent of the collection delta
  // stream: an entry not yet ingested is ingested through the one single-flight
  // path (the high lane a human-visible image uses), for a bounded wait. The
  // reply is always the entry's current record; `extracted:false` means the
  // record is not available yet (unreachable source, or the wait elapsed).
  add("GET", "/api/collections/<id>/entries/<name>/meta", async (req, { id, name }) => {
    if (!addressFor(id)) return Response.json({ error: "unknown collection" }, { status: 404 });
    const originError = byteOriginError(req, id);
    if (originError) return originError;
    const token = ctx.inventory.capture?.(id);
    if (!ctx.store.entryJoined(id, name)?.hash) {
      const done = new AbortController();
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, done.signal]) : done.signal;
      try {
        await Promise.race([ctx.ingest.ensure(id, name, "output", { priority: "high" }).catch(() => null), waitFor(ENTRY_META_WAIT_MS, signal)]);
      } finally { done.abort(); }
      if (token && !ctx.inventory.isCurrent(token)) return Response.json({ error: "Source incarnation changed" }, { status: 409 });
    }
    const { name: entry, hash, extracted, meta, width, height } = entryShape(id, name, null, ctx.store.entryJoined(id, name), null);
    const generationTimeMs = await ctx.comfy?.(id)?.generationTime?.(name) ?? null;
    const finalOriginError = byteOriginError(req, id);
    if (finalOriginError) return finalOriginError;
    if (token && !ctx.inventory.isCurrent(token)) return Response.json({ error: "Source incarnation changed" }, { status: 409 });
    if (hash !== (ctx.store.entryJoined(id, name)?.hash ?? null)) return Response.json({ error: "Entry content changed" }, { status: 409 });
    return Response.json({ name: entry, hash, extracted, meta, width, height, generationTimeMs });
  });

  // --- judgments (entry columns) ------------------------------------------------

  add("PATCH", "/api/collections/<id>/entries/<name>/judgment", async (req, { id, name }) => {
    if (!addressFor(id)) return Response.json({ error: "unknown collection" }, { status: 404 });
    const body = await readJson(req);
    const r = ctx.store.judgmentPatch(id, name, body);
    if (!r.ok) return Response.json({ error: r.error }, { status: 400 });
    return Response.json(r.judgment ?? {});
  });

  // --- content by hash -----------------------------------------------------------

  add("GET", "/api/content/<hash>", async (_req, { hash }) => {
    const c = ctx.store.contentGet(hash);
    if (!c) return Response.json({ error: "unknown content" }, { status: 404 });
    const instances = ctx.store.instancesOf(hash);
    return Response.json({ ...c, instances });
  });

  add("GET", "/api/content/<hash>/bytes", async (req, { hash }) => {
    const bytes = await ctx.cache.get(hash);
    if (!bytes) return new Response("not found", { status: 404 });
    return bytesResponse(req, bytes, hash, sniffMime(bytes) ?? "application/octet-stream");
  });

  // --- settings + nodes + plugins -------------------------------------------------

  add("GET", "/api/settings/<ns>", async (_req, { ns }) => {
    return Response.json(ctx.settings.getNs(ns));
  });

  add("PATCH", "/api/settings/<ns>", async (req, { ns }) => {
    let body;
    try { body = await readJson(req); }
    catch { return Response.json({ error: "Settings patch must be a JSON object" }, { status: 400 }); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: "Settings patch must be a JSON object" }, { status: 400 });
    await ctx.settings.patch(ns, body);
    return Response.json(ctx.settings.getNs(ns));
  });

  add("GET", "/api/plugins", async () => {
    return Response.json(ctx.plugins.list());
  });

  add("GET", "/api/nodes", async () => {
    return Response.json(ctx.store.nodeRegistry());
  });

  add("GET", "/api/features", async () => {
    return Response.json(ctx.features);
  });

  // --- prefetch control (the menu's "metadata scan" row) --------------------------

  add("GET", "/api/prefetch", async () => {
    const pending = {};
    const lastError = {};
    let dimsPending = 0;
    let ingestPending = 0;
    for (const name of Object.keys(ctx.hosts)) {
      pending[name] = ctx.prefetch.pending(name);
      ingestPending += pending[name];
      dimsPending += ctx.prefetch.dimsPending(name);
      lastError[name] = ctx.prefetch.lastError(name);
    }
    return Response.json({
      enabled: ctx.settings.get("core.prefetch", "enabled", true),
      paused: ctx.settings.get("core.prefetch", "paused", false),
      pending,
      // the two-pass totals: pass 1 dims heads, pass 2 full ingests
      dimsPending,
      ingestPending,
      lastError,
    });
  });

  add("POST", "/api/prefetch", async (req) => {
    const body = await readJson(req);
    if (typeof body.enabled === "boolean") {
      await ctx.settings.set("core.prefetch", "enabled", body.enabled);
    }
    if (typeof body.paused === "boolean") {
      await ctx.settings.set("core.prefetch", "paused", body.paused);
    }
    return Response.json({
      enabled: ctx.settings.get("core.prefetch", "enabled", true),
      paused: ctx.settings.get("core.prefetch", "paused", false),
    });
  });

  // --- metadata channel -------------------------------------------------------------

  // Versioned poll: `since` replaces the client's version compare — the
  // answer says whether anything moved; items ship only when it did.
  add("GET", "/api/collections/<id>/meta", async (_req, { id }, url) => {
    if (!addressFor(id)) return Response.json({ error: "unknown collection" }, { status: 404 });
    const since = url.searchParams.get("since");
    return Response.json({
      ...ctx.store.metadataSince(id, since),
      pending: ctx.prefetch.pending(id) + ctx.prefetch.dimsPending(id),
    });
  });

  // Scroll-driven extraction: the client reports rendered-but-meta-less
  // names; they jump the queue (the prio lane drains first).
  add("POST", "/api/collections/<id>/want", async (req, { id }) => {
    if (!addressFor(id)) return Response.json({ error: "unknown collection" }, { status: 404 });
    let body;
    try { body = await readJson(req); }
    catch { return Response.json({ error: "files must be JSON" }, { status: 400 }); }
    const files = body?.files;
    if (!Array.isArray(files)) return Response.json({ error: "files must be an array" }, { status: 400 });
    const interest = body.interest === undefined ? "full" : body.interest;
    const priority = body.priority === undefined ? "foreground" : body.priority;
    if (!["full", "dimensions"].includes(interest) || !["foreground", "background"].includes(priority)) {
      return Response.json({ error: "bad interest or priority" }, { status: 400 });
    }
    if (files.some((name) => !validEntryName(addressFor(id), name))) {
      return Response.json({ error: "bad entry path" }, { status: 400 });
    }
    ctx.prefetch.feed(id, files, priority === "foreground", { interest });
    // Legacy full wants retain their ingest count; dimension interest must
    // keep polling even when it has no ingestion obligation. The reply also
    // acknowledges with the demanded names' already-known state.
    return Response.json({ pending: interest === "dimensions" ? ctx.prefetch.dimsPending(id) : ctx.prefetch.pending(id),
      ...ctx.store.metadataFor(id, files, { meta: interest === "full" }) });
  });

  return {
    ctx,
    async handle(req) {
      const url = new URL(req.url);
      let m;
      try { m = match(req.method, url.pathname); }
      catch (error) {
        if (error instanceof URIError) return Response.json({ error: "malformed path escape" }, { status: 400 });
        throw error;
      }
      if (!m) return new Response("not found", { status: 404 });
      const denied = mutationError(req, url);
      if (denied) return denied;
      if (Object.hasOwn(m.params, "hash") && !isContentHash(m.params.hash)) {
        return Response.json({ error: "Invalid SHA-256 content hash" }, { status: 400 });
      }
      // Every named-entry operation crosses this one boundary before touching
      // stored/cached data or a backing, including HEAD and judgment writes.
      if (m.namedEntry) {
        const addr = addressFor(m.params.id);
        if (addr && !validEntryName(addr, m.params.name)) {
          return Response.json({ error: "bad entry path" }, { status: 400 });
        }
      }
      try { return await m.handler(req, m.params, url); }
      catch (error) {
        if (error instanceof UnsupportedMediaType) return Response.json({ error: error.message }, { status: 415 });
        throw error;
      }
    },
    add, // plugin host registers its routes here
  };
}
