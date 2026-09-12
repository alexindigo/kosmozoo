// src/routes.mjs — dispatch table for the public engine API.
//
// Collections + entries are the resources (spec §2). Plugin routes live
// under /api/plugins/<name>/... and are registered by the plugin host.

import { probeHost, hostList, hostInputList, hostInputBytes, hostUploadInput, hostReadBytes, validateHost, addHost, removeHost, isFolderHost, hostDelete, comfyHistoryDelete, EXT_MIME } from "./hosts.mjs";
import { cacheGet, sha256 } from "./cache.mjs";
import { capabilities } from "./collections.mjs";

export function makeRouter(ctx) {
  // ctx: { hosts, store, settings, plugins, ingest, prefetch } — `router.ctx`
  // is settable so main.mjs can hand the plugin host back in after construction.
  const routes = [];

  const add = (method, pattern, handler) => {
    // pattern: "/api/collections/<id>/entries/<name>" — segments, "<x>" captures one segment
    const parts = pattern.split("/").filter(Boolean);
    routes.push({ method, parts, handler });
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
      if (ok) return { handler: r.handler, params };
    }
    return null;
  };

  const useAssetsPlus = () => ctx.settings.get("core.delete", "useAssetsPlus", true);

  const entryShape = (collection, name, size) => {
    const e = ctx.store.entryGet(collection, name);
    const st = ctx.store.metaState(collection, name);
    const c = e?.hash ? ctx.store.contentGet(e.hash) : null;
    return {
      name,
      size: size ?? c?.bytes ?? null,
      hash: e?.hash ?? null,
      state: e?.state ?? "seen",
      meta: st.meta,
      extracted: st.extracted,
      judgment: ctx.store.judgmentGet(collection, name),
      width: c?.width ?? null,
      height: c?.height ?? null,
    };
  };

  // --- collections -----------------------------------------------------------

  add("GET", "/api/collections", async () => {
    const out = {};
    for (const [id, address] of Object.entries(ctx.hosts)) {
      const online = await probeHost(address);
      const c = ctx.store.collectionGet(id) ?? { id, kind: isFolderHost(address) ? "folder" : "comfy", address };
      out[id] = {
        address,
        kind: c.kind,
        online,
        capabilities: await capabilities(c, { online, useAssetsPlus: useAssetsPlus() }),
      };
    }
    return Response.json(out);
  });

  // Collections are user-managed at runtime (source-backed only in this plan).
  add("POST", "/api/collections", async (req) => {
    let body;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "JSON body: {name, address}" }, { status: 400 });
    }
    const err = validateHost(body.name, body.address);
    if (err) return Response.json({ error: err }, { status: 400 });
    addHost(ctx.store, ctx.hosts, body.name, body.address);
    const c = ctx.store.collectionGet(body.name);
    return Response.json({
      name: body.name,
      address: body.address,
      kind: c.kind,
      online: await probeHost(body.address),
    });
  });

  add("DELETE", "/api/collections/<id>", async (_req, { id }) => {
    if (!(id in ctx.hosts)) return Response.json({ error: "unknown collection" }, { status: 404 });
    if (Object.keys(ctx.hosts).length === 1) {
      return Response.json({ error: "cannot remove the last collection" }, { status: 400 });
    }
    removeHost(ctx.store, ctx.hosts, id);
    return Response.json({ removed: id });
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

  // --- entries ----------------------------------------------------------------

  // The feed listing (kind=output, the default) or the input-dir listing
  // (kind=input). Hidden entries stay out of every output listing.
  add("GET", "/api/collections/<id>/entries", async (req, { id }, url) => {
    const addr = ctx.hosts[id];
    if (!addr) return Response.json({ error: "unknown collection" }, { status: 404 });
    const kind = url.searchParams.get("kind") ?? "output";
    if (kind === "input") {
      try {
        return Response.json(await hostInputList(addr));
      } catch {
        return Response.json([]);
      }
    }
    // The listing comes from the backing; the store overlays judgment + dims.
    const list = await hostList(addr);
    const hidden = ctx.store.hiddenNames(id);
    const visible = hidden.size ? list.filter((f) => !hidden.has(f.name)) : list;
    ctx.prefetch?.feed(id, visible.map((f) => f.name));
    const size = new Map(visible.map((f) => [f.name, f.size]));
    return Response.json(visible.map((f) => entryShape(id, f.name, size.get(f.name))));
  });

  add("GET", "/api/collections/<id>/entries/<name>", async (_req, { id, name }) => {
    if (!ctx.hosts[id]) return Response.json({ error: "unknown collection" }, { status: 404 });
    return Response.json(entryShape(id, name));
  });

  // Upload one image into a comfy collection's input dir (multipart field
  // "image") — the browser can't post to ComfyUI directly (cross-origin).
  add("POST", "/api/collections/<id>/entries", async (req, { id }) => {
    const addr = ctx.hosts[id];
    if (!addr) return Response.json({ error: "unknown collection" }, { status: 404 });
    let form;
    try { form = await req.formData(); }
    catch { return Response.json({ error: "multipart form required" }, { status: 400 }); }
    const file = form.get("image");
    if (!file || typeof file === "string") {
      return Response.json({ error: "no image file in form" }, { status: 400 });
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const r = await hostUploadInput(addr, file.name, bytes);
    if (!r.ok) {
      // 409: the name already exists in the input dir — say WHICH name
      return Response.json(
        { error: r.error, ...(r.status === 409 ? { name: file.name } : {}) },
        { status: r.status },
      );
    }
    return Response.json({ name: r.name });
  });

  // Delete an entry from its source, per the collection's delete capability:
  // folder → unlink; comfy + assets_plus → trash; else hide + history cleanup.
  add("DELETE", "/api/collections/<id>/entries/<name>", async (_req, { id, name }) => {
    const addr = ctx.hosts[id];
    if (!addr) return Response.json({ error: "unknown collection" }, { status: 404 });
    const c = ctx.store.collectionGet(id) ?? { id, kind: isFolderHost(addr) ? "folder" : "comfy", address: addr };
    const caps = await capabilities(c, { useAssetsPlus: useAssetsPlus() });
    if (caps.delete === "unlink" || caps.delete === "trash") {
      const res = await hostDelete(addr, name);
      if (!res.ok) return Response.json({ error: res.detail }, { status: 409 });
      return Response.json({ deleted: true, mode: res.mode });
    }
    ctx.store.entryHide(id, name);
    const historyCleared = isFolderHost(addr) ? false : await comfyHistoryDelete(addr, name);
    return Response.json({ deleted: true, mode: "hide", historyCleared });
  });

  add("HEAD", "/api/collections/<id>/entries/<name>/bytes", async (_req, { id, name }) => {
    if (!ctx.hosts[id]) return new Response(null, { status: 404 });
    const e = ctx.store.entryGet(id, name);
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
    if (!ctx.hosts[id]) return new Response("unknown collection", { status: 404 });
    const kind = url.searchParams.get("kind") === "input" ? "input" : "output";
    const mime = EXT_MIME[name.split(".").pop().toLowerCase()];
    const inm = req.headers.get("If-None-Match");
    const makeResponse = (bytes, hash) => {
      const etag = `"${hash}"`;
      if (inm === etag) return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "no-cache" } });
      const h = new Headers();
      if (mime) h.set("Content-Type", mime);
      h.set("Content-Length", String(bytes.length));
      h.set("ETag", etag);
      h.set("Cache-Control", "no-cache");
      return new Response(bytes, { headers: h });
    };

    // Cache hit: serve + debounced revalidation (the NEXT request gets fresh
    // bytes if the source was rewritten under the same name).
    const info = kind === "input"
      ? ctx.store.inputCacheGet(id, name)
      : ctx.store.fileInfo(id, name);
    if (info?.hash) {
      const cached = await cacheGet(info.hash);
      if (cached) {
        ctx.ingest?.scheduleRevalidate(id, name, { input: kind === "input" });
        return makeResponse(cached, info.hash);
      }
    }

    // Read through ingestion.
    if (ctx.ingest) {
      const got = await ctx.ingest.ensure(id, name, kind);
      if (got.status === 200) return makeResponse(got.bytes, got.hash);
      if (got.status === 400) return new Response("bad filename", { status: 400 });
    }

    // Last resort: proxy from the backing (+ ingest in the background for
    // the next request).
    const r = kind === "input"
      ? await hostInputBytes(ctx.hosts[id], name)
      : await hostReadBytes(ctx.hosts[id], name);
    if (r.status === 400) return new Response("bad filename", { status: 400 });
    if (r.status !== 200) return new Response("not found", { status: r.status });
    const bytes = new Uint8Array(await new Response(r.body).arrayBuffer());
    const hash = await sha256(bytes);
    if (ctx.ingest) ctx.ingest.ensureBytes(id, name, bytes, { kind }).catch(() => {});
    return makeResponse(bytes, hash);
  });

  // --- judgments (entry columns) ------------------------------------------------

  add("PATCH", "/api/collections/<id>/entries/<name>/judgment", async (req, { id, name }) => {
    if (!ctx.hosts[id]) return Response.json({ error: "unknown collection" }, { status: 404 });
    const body = await req.json();
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
    const bytes = await cacheGet(hash);
    if (!bytes) return new Response("not found", { status: 404 });
    const etag = `"${hash}"`;
    if (req.headers.get("If-None-Match") === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "no-cache" } });
    }
    const c = ctx.store.contentGet(hash);
    const h = new Headers({ "Content-Length": String(bytes.length), ETag: etag, "Cache-Control": "no-cache" });
    if (c?.meta?.mime) h.set("Content-Type", c.meta.mime);
    return new Response(bytes, { headers: h });
  });

  // --- settings + nodes + plugins -------------------------------------------------

  add("GET", "/api/settings/<ns>", async (_req, { ns }) => {
    return Response.json(ctx.settings.getNs(ns));
  });

  add("PATCH", "/api/settings/<ns>", async (req, { ns }) => {
    const body = await req.json();
    for (const [key, value] of Object.entries(body)) {
      await ctx.settings.set(ns, key, value);
    }
    return Response.json(ctx.settings.getNs(ns));
  });

  add("GET", "/api/plugins", async () => {
    return Response.json(ctx.plugins ? ctx.plugins.list() : []);
  });

  add("GET", "/api/nodes", async () => {
    return Response.json(ctx.store.nodeRegistry());
  });

  add("GET", "/api/features", async () => {
    return Response.json([]); // feature modules land with the variations move
  });

  // --- prefetch control (the menu's "metadata scan" row) --------------------------

  add("GET", "/api/prefetch", async () => {
    const pending = {};
    for (const name of Object.keys(ctx.hosts)) {
      pending[name] = ctx.prefetch ? ctx.prefetch.pending(name) : 0;
    }
    return Response.json({
      enabled: ctx.settings.get("core.scraper", "enabled", true),
      paused: ctx.settings.get("core.scraper", "paused", false),
      pending,
    });
  });

  add("POST", "/api/prefetch", async (req) => {
    const body = await req.json();
    if (typeof body.enabled === "boolean") {
      await ctx.settings.set("core.scraper", "enabled", body.enabled);
    }
    if (typeof body.paused === "boolean") {
      await ctx.settings.set("core.scraper", "paused", body.paused);
    }
    return Response.json({
      enabled: ctx.settings.get("core.scraper", "enabled", true),
      paused: ctx.settings.get("core.scraper", "paused", false),
    });
  });

  // --- metadata channel -------------------------------------------------------------

  // Versioned poll: `since` replaces the client's version compare — the
  // answer says whether anything moved; items ship only when it did.
  add("GET", "/api/collections/<id>/meta", async (_req, { id }, url) => {
    if (!ctx.hosts[id]) return Response.json({ error: "unknown collection" }, { status: 404 });
    const v = ctx.store.metaVersion;
    const since = url.searchParams.get("since");
    if (since !== null && Number(since) === v) {
      return Response.json({ v, changed: false });
    }
    return Response.json({
      v,
      changed: true,
      items: ctx.store.metaForHost(id),
      pending: ctx.prefetch ? ctx.prefetch.pending(id) : 0,
    });
  });

  // Scroll-driven extraction: the client reports rendered-but-meta-less
  // names; they jump the queue (the prio lane drains first).
  add("POST", "/api/collections/<id>/want", async (req, { id }) => {
    if (!ctx.hosts[id]) return Response.json({ error: "unknown collection" }, { status: 400 });
    const { files } = await req.json();
    if (!Array.isArray(files)) return Response.json({ error: "files must be an array" }, { status: 400 });
    const pending = ctx.prefetch?.feed(id, files, true) ?? 0;
    return Response.json({ pending });
  });

  return {
    get ctx() { return ctx; },
    set ctx(v) { ctx = v; },
    async handle(req) {
      const url = new URL(req.url);
      const m = match(req.method, url.pathname);
      if (!m) return new Response("not found", { status: 404 });
      return m.handler(req, m.params, url);
    },
    add, // plugin host registers its routes here
  };
}
