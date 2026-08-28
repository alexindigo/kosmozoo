// src/routes.mjs — dispatch table for the public engine API.
//
// Resource-shaped, documented, public. Plugin routes live under
// /api/plugins/<name>/... and are registered by the plugin host (Phase 10).

import { splitHostKey, probeHost, hostList, hostReadBytes, hostHeadSize, hostInputBytes, validateHost, addHost, removeHost, isFolderHost, hostHasAssetsPlus, hostDelete, comfyHistoryDelete, EXT_MIME } from "./hosts.mjs";
import { cacheGet } from "./cache.mjs";
import { scheduleRevalidate } from "./revalidate.mjs";

export function makeRouter(ctx) {
  // ctx: { hosts, store, settings, plugins } — `router.ctx` is settable so
  // main.mjs can hand the plugin host back in after construction.
  const routes = [];

  const add = (method, pattern, handler) => {
    // pattern: "/api/images/<id>/bytes" — segments, "<x>" captures one segment
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

  // --- core resources -----------------------------------------------------

  add("GET", "/api/hosts", async () => {
    const useAssetsPlus = ctx.settings.get("core.delete", "useAssetsPlus", true);
    const out = {};
    for (const [name, addr] of Object.entries(ctx.hosts)) {
      const online = await probeHost(addr);
      // deleteMode drives the card's delete affordance: folder hosts unlink
      // (permanent); Comfy hosts trash via assets_plus when allowed and
      // available; everything else can only be hidden from kosmozoo.
      let deleteMode = "hide";
      if (isFolderHost(addr)) deleteMode = "unlink";
      else if (online && useAssetsPlus && await hostHasAssetsPlus(addr)) deleteMode = "trash";
      out[name] = { address: addr, online, deleteMode };
    }
    return Response.json(out);
  });

  // Hosts are user-managed at runtime (the outgoing app's menu add/remove).
  // Persisted to settings core.hosts.map; env only seeds the first boot.
  add("POST", "/api/hosts", async (req) => {
    let body;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "JSON body: {name, address}" }, { status: 400 });
    }
    const err = validateHost(body.name, body.address);
    if (err) return Response.json({ error: err }, { status: 400 });
    addHost(ctx.hosts, body.name, body.address);
    await ctx.settings.set("core.hosts", "map", ctx.hosts);
    return Response.json({ name: body.name, address: body.address, online: await probeHost(body.address) });
  });

  add("DELETE", "/api/hosts/<name>", async (_req, { name }) => {
    if (!(name in ctx.hosts)) return Response.json({ error: "unknown host" }, { status: 404 });
    if (Object.keys(ctx.hosts).length === 1) {
      return Response.json({ error: "cannot remove the last host" }, { status: 400 });
    }
    removeHost(ctx.hosts, name);
    await ctx.settings.set("core.hosts", "map", ctx.hosts);
    return Response.json({ removed: name });
  });

  add("GET", "/api/images", async (req, _params, url) => {
    const host = url.searchParams.get("host");
    if (!host || !ctx.hosts[host]) return Response.json({ error: "unknown host" }, { status: 400 });
    // File listing comes from the host (HTTP or folder adapter); metadata
    // is overlaid from the store.
    const list = await hostList(ctx.hosts[host]);
    // Hidden images (the delete fallback on hosts that can't delete files)
    // stay out of every listing — feed, lightbox and diff all walk this.
    const hidden = new Set(ctx.settings.get("core.delete", "hidden", {})?.[host] ?? []);
    const visible = hidden.size ? list.filter((f) => !hidden.has(f.name)) : list;
    const names = visible.map((f) => f.name);
    // The listing feeds the background walk (deduped + meta_fresh-filtered
    // inside feed()); on-screen names would use feed(host, names, true).
    ctx.scraper?.feed(host, names);
    const size = new Map(visible.map((f) => [f.name, f.size]));
    return Response.json(names.map((filename) => ({
      id: `${host}:${filename}`,
      host,
      filename,
      size: size.get(filename) ?? null,
      meta: ctx.store.metaGet(host, filename),
      judgment: ctx.store.judgmentGet(host, filename),
    })));
  });

  add("GET", "/api/images/<id>", async (_req, { id }) => {
    const [host, filename] = splitHostKey(id);
    if (!ctx.hosts[host]) return Response.json({ error: "unknown host" }, { status: 404 });
    return Response.json({
      id, host, filename,
      meta: ctx.store.metaGet(host, filename),
      judgment: ctx.store.judgmentGet(host, filename),
    });
  });

  // Delete an image from its source. folder -> unlink (permanent);
  // Comfy + assets_plus (toggle permitting) -> trash (recoverable);
  // anything else -> hide from kosmozoo + best-effort Comfy history cleanup
  // (the file stays on the host — ComfyUI core has no file-delete API).
  add("DELETE", "/api/images/<id>", async (_req, { id }) => {
    const [host, filename] = splitHostKey(id);
    const addr = ctx.hosts[host];
    if (!addr) return Response.json({ error: "unknown host" }, { status: 404 });
    const useAssetsPlus = ctx.settings.get("core.delete", "useAssetsPlus", true);

    if (isFolderHost(addr) || (useAssetsPlus && await hostHasAssetsPlus(addr))) {
      const res = await hostDelete(addr, filename);
      if (!res.ok) return Response.json({ error: res.detail }, { status: 409 });
      return Response.json({ deleted: true, mode: res.mode });
    }

    const hiddenMap = ctx.settings.get("core.delete", "hidden", {}) ?? {};
    const list = new Set(hiddenMap[host] ?? []);
    list.add(filename);
    hiddenMap[host] = [...list];
    await ctx.settings.set("core.delete", "hidden", hiddenMap);
    const historyCleared = isFolderHost(addr) ? false : await comfyHistoryDelete(addr, filename);
    return Response.json({ deleted: true, mode: "hide", historyCleared });
  });

  add("HEAD", "/api/images/<id>/bytes", async (_req, { id }) => {
    const [host, filename] = splitHostKey(id);
    if (!ctx.hosts[host]) return new Response(null, { status: 404 });
    const size = await hostHeadSize(ctx.hosts[host], filename);
    return new Response(null, {
      status: 200,
      headers: size != null ? { "content-length": String(size) } : {},
    });
  });

  // Input-dir image bytes for node references (LoadImage-style): folder
  // hosts read from the directory; ComfyUI hosts proxy /api/view?type=input.
  add("GET", "/api/input-bytes/<host>/<filename>", async (_req, { host, filename }) => {
    if (!ctx.hosts[host]) return new Response("unknown host", { status: 404 });
    const r = await hostInputBytes(ctx.hosts[host], filename);
    if (r.status === 400) return new Response("bad filename", { status: 400 });
    if (r.status !== 200) return new Response("not found", { status: r.status });
    return new Response(r.body, { headers: r.headers });
  });

  add("GET", "/api/images/<id>/bytes", async (_req, { id }) => {
    const [host, filename] = splitHostKey(id);
    if (!ctx.hosts[host]) return new Response("unknown host", { status: 404 });

    const ext = filename.split(".").pop().toLowerCase();
    const mime = EXT_MIME[ext];
    const makeResponse = (bytes) => {
      const h = new Headers();
      if (mime) h.set("Content-Type", mime);
      h.set("Content-Length", String(bytes.length));
      return new Response(bytes, { headers: h });
    };

    // Cache-first: resolve address → hash, serve from cache. A hit also
    // fires a debounced async revalidation for non-durable remotes — the
    // source may have changed in place; the NEXT request gets fresh bytes.
    const hash = ctx.store.hashFor(host, filename);
    if (hash) {
      const cached = await cacheGet(hash);
      if (cached) {
        scheduleRevalidate(ctx, host, filename);
        return makeResponse(cached);
      }
    }

    // Not in cache: read through ingestion (read → hash → cache → index).
    if (ctx.ingest) {
      const ingested = await ctx.ingest.ensure(host, filename);
      if (ingested) {
        const cached = await cacheGet(ingested);
        if (cached) return makeResponse(cached);
      }
    }

    // Ingestion failed (host down, bad filename): proxy as last resort.
    const r = await hostReadBytes(ctx.hosts[host], filename);
    if (r.status === 400) return new Response("bad filename", { status: 400 });
    if (r.status !== 200) return new Response("upstream error", { status: r.status });

    // Ingest in the background for next time.
    if (ctx.ingest && r.body) {
      const bytes = new Uint8Array(await new Response(r.body).arrayBuffer());
      const h = makeResponse(bytes);
      ctx.ingest.ensureBytes(host, filename, bytes).catch(() => {});
      return h;
    }
    return new Response(r.body, { headers: r.headers });
  });

  add("GET", "/api/judgments/<id>", async (_req, { id }) => {
    const [host, filename] = splitHostKey(id);
    return Response.json(ctx.store.judgmentGet(host, filename) ?? {});
  });

  add("PUT", "/api/judgments/<id>", async (req, { id }) => {
    const [host, filename] = splitHostKey(id);
    const body = await req.json();
    for (const [field, value] of Object.entries(body)) {
      await ctx.store.judgmentSet(host, filename, field, value);
    }
    return Response.json(ctx.store.judgmentGet(host, filename) ?? {});
  });

  add("DELETE", "/api/judgments/<id>", async (_req, { id }) => {
    const [host, filename] = splitHostKey(id);
    for (const f of ["notes", "vote", "favorite"]) {
      await ctx.store.judgmentSet(host, filename, f, null);
    }
    return Response.json({});
  });

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

  // --- scraper control (the menu's "metadata scan" row) ---------------------
  // The discovered node registry: class_type → { title, inputs→types }.
  add("GET", "/api/nodes", async () => {
    return Response.json(ctx.store.nodeRegistry());
  });

  add("GET", "/api/scraper", async () => {
    const pending = {};
    for (const name of Object.keys(ctx.hosts)) {
      pending[name] = ctx.scraper ? ctx.scraper.pending(name) : 0;
    }
    return Response.json({
      enabled: ctx.settings.get("core.scraper", "enabled", true),
      paused: ctx.settings.get("core.scraper", "paused", false),
      pending,
    });
  });

  add("POST", "/api/scraper", async (req) => {
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

  // --- feedback document ----------------------------------------------------
  // Download the exact feedback.json as stored (the outgoing dlFeedback link).
  add("GET", "/api/feedback", async () => {
    const { readFile } = await import("node:fs/promises");
    try {
      const body = await readFile(ctx.store.feedbackPath);
      return new Response(body, {
        headers: {
          "Content-Type": "application/json",
          "Content-Disposition": "attachment; filename=\"kosmozoo_feedback.json\"",
        },
      });
    } catch {
      return Response.json({ error: "no feedback document yet" }, { status: 404 });
    }
  });

  // Where judgments live. Applied live: the store re-opens at the new path.
  add("PUT", "/api/feedback-path", async (req) => {
    const { path } = await req.json();
    if (!path || typeof path !== "string") {
      return Response.json({ error: "path required" }, { status: 400 });
    }
    await ctx.store.setFeedbackPath(path);
    await ctx.settings.set("core", "feedbackPath", path);
    return Response.json({ feedbackPath: ctx.store.feedbackPath });
  });

  // --- metadata channel -------------------------------------------------------
  // Versioned poll: the client merges when v moves (in-place card patching),
  // and drives the scan chip off pending.
  add("GET", "/api/metadata", async (_req, _params, url) => {
    const host = url.searchParams.get("host");
    if (!host || !ctx.hosts[host]) return Response.json({ error: "unknown host" }, { status: 400 });
    return Response.json({
      items: ctx.store.metaForHost(host),
      pending: ctx.scraper ? ctx.scraper.pending(host) : 0,
      v: ctx.store.metaVersion,
    });
  });

  // Scroll-driven extraction: the client reports rendered-but-meta-less
  // filenames; they jump the queue (priority lane drains before the walk).
  add("POST", "/api/meta-want", async (req) => {
    const { host, files } = await req.json();
    if (!host || !ctx.hosts[host]) return Response.json({ error: "unknown host" }, { status: 400 });
    if (!Array.isArray(files)) return Response.json({ error: "files must be an array" }, { status: 400 });
    const pending = ctx.scraper?.feed(host, files, true) ?? 0;
    return Response.json({ pending });
  });

  // Save-button greying: which filenames already exist in the downloads dir.
  add("POST", "/api/downloads-check", async (req) => {
    const { files } = await req.json();
    if (!Array.isArray(files)) return Response.json({ error: "files must be an array" }, { status: 400 });
    const { readdir } = await import("node:fs/promises");
    let present = new Set();
    try {
      present = new Set(await readdir(ctx.downloadsDir));
    } catch { /* dir missing -> nothing exists */ }
    const exists = {};
    for (const f of files) exists[f] = present.has(f);
    return Response.json({ exists });
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
