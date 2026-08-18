// src/routes.mjs — dispatch table for the public engine API.
//
// Resource-shaped, documented, public. Plugin routes live under
// /api/plugins/<name>/... and are registered by the plugin host (Phase 10).

import { splitHostKey, probeHost, proxyImage, validateHost, addHost, removeHost } from "./hosts.mjs";

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
    const out = {};
    for (const [name, addr] of Object.entries(ctx.hosts)) {
      out[name] = { address: addr, online: await probeHost(addr) };
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
    // File listing comes from the host; metadata is overlaid from the store.
    const r = await fetch(`http://${ctx.hosts[host]}/internal/files/output`);
    const raw = await r.json();
    // Strip the real listing's " [size]" suffix (clean_file_name quirk).
    const names = raw.map((n) => String(n).replace(/\s+\[[^\]]+\]$/, ""));
    return Response.json(names.map((filename) => ({
      id: `${host}:${filename}`,
      host,
      filename,
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

  add("GET", "/api/images/<id>/bytes", async (_req, { id }) => {
    const [host, filename] = splitHostKey(id);
    if (!ctx.hosts[host]) return new Response("unknown host", { status: 404 });
    const r = await proxyImage(ctx.hosts[host], filename);
    if (r.status !== 200) return new Response("upstream error", { status: r.status });
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
