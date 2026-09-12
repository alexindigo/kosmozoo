// src/plugins.mjs — the plugin host.
//
// Drop a folder in, restart, live. No manifest, no versioning ceremony.
// Discovery: KOZMOZOO_PLUGINS → $XDG_DATA_HOME/kosmozoo/plugins/ →
// repo-local ./plugins/ for development. A plugin is trusted and in-process.
//
//   <name>/plugin.ts (or .mjs)  — export function register(kz)   engine hooks
//   <name>/client.js            — optional, served to the browser  UI hooks
//
// The kz surface is what a plugin can touch. Core knows the config surface,
// never the plugin's internals.

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { backingFor } from "./backings/index.mjs";

export function pluginDirs(env = Deno.env.toObject()) {
  const dirs = [];
  if (env.KOZMOZOO_PLUGINS) dirs.push(env.KOZMOZOO_PLUGINS);
  const xdg = env.XDG_DATA_HOME ?? join(env.HOME ?? ".", ".local", "share");
  dirs.push(join(xdg, "kosmozoo", "plugins"));
  dirs.push(new URL("../plugins", import.meta.url).pathname); // repo-local dev tier
  return dirs;
}

export class PluginHost {
  #plugins = new Map(); // name -> { name, dir, capabilities, hasClient }

  constructor(ctx) {
    this.ctx = ctx; // { store, settings, router, hosts }
  }

  async discover() {
    for (const dir of pluginDirs()) {
      let entries;
      try {
        entries = await readdir(dir);
      } catch { continue; } // absent tier is fine
      for (const name of entries) {
        const pdir = join(dir, name);
        if (!(await stat(pdir)).isDirectory()) continue;
        await this.load(name, pdir);
      }
    }
    return this.list();
  }

  async load(name, dir) {
    const caps = [];
    const kz = this.#kz(name, caps);
    let hasClient = false;
    try {
      await stat(join(dir, "client.js"));
      hasClient = true;
    } catch { /* no client half */ }

    for (const entry of ["plugin.ts", "plugin.mjs", "plugin.js"]) {
      const candidate = join(dir, entry);
      try {
        if (!(await stat(candidate)).isFile()) continue;
      } catch { continue; }
      try {
        const mod = await import(candidate);
        if (typeof mod.register === "function") await mod.register(kz);
      } catch (e) {
        console.error(`plugin ${name}: register failed —`, e.message);
        this.#plugins.set(name, { name, dir, capabilities: caps, hasClient, error: String(e?.message ?? e) });
        return;
      }
      break;
    }
    this.#plugins.set(name, { name, dir, capabilities: caps, hasClient });
  }

  // The kz surface handed to a plugin at register() time.
  #kz(name, caps) {
    const { store, settings, router } = this.ctx;
    return {
      // composition modes (client) / alignment contributions are announced
      // as capabilities and picked up by the client half
      mode: (id, def) => caps.push({ kind: "mode", id, ...def }),
      alignment: (id, def) => caps.push({ kind: "alignment", id, ...def }),
      // exporter stays until the export plugin is deleted (cruft-cleanup §3.4)
      exporter: (def) => caps.push({ kind: "exporter", ...def }),
      // server route under /api/plugins/<name>/...
      route: (method, path, handler) => {
        router.add(method, `/api/plugins/${name}${path}`, handler);
        caps.push({ kind: "route", method, path: `/api/plugins/${name}${path}` });
      },
      // plugin-scoped persistence, namespaced so core need not know it exists
      settings: {
        get: (k, fb) => settings.get(`plugins.${name}`, k, fb),
        set: (k, v) => settings.set(`plugins.${name}`, k, v),
        ns: () => settings.getNs(`plugins.${name}`),
      },
      store: {
        getField: (host, filename, field) =>
          store.judgmentGet(host, filename)?.plugins?.[name]?.[field] ?? null,
        setField: (host, filename, field, value) =>
          store.judgmentSet(host, filename, `plugins.${name}.${field}`, value),
      },
      judgments: {
        get: (host, filename) => store.judgmentGet(host, filename),
        set: (host, filename, field, value) => store.judgmentSet(host, filename, field, value),
        _all: () => store.judgmentsAll(), // batch exporters iterate this
      },
      // engine-mediated host fetch so plugins never talk to ComfyUI directly
      _fetchImageBytes: async (hostFilenameKey) => {
        const i = hostFilenameKey.indexOf(":");
        const host = hostFilenameKey.slice(0, i), filename = hostFilenameKey.slice(i + 1);
        const addr = this.ctx.hosts[host];
        if (!addr) return null;
        const r = await backingFor(addr).read(addr, filename, "output");
        if (r.status !== 200) return null;
        return new Uint8Array(await new Response(r.body).arrayBuffer());
      },
      // hash + cache access for plugins that need the ingested bytes
      _hashFor: (host, filename) => store.hashFor(host, filename),
      _cacheGet: (hash) => this.ctx.cache.get(hash),
      _hostAddr: (host) => this.ctx.hosts[host] ?? null,
    };
  }

  list() {
    return [...this.#plugins.values()].map(({ name, capabilities, hasClient, error }) => ({
      name, hasClient, ...(error ? { error } : {}),
      // needs.ok may be a function — evaluated HERE, per request, never
      // frozen at register (F13)
      capabilities: capabilities.map((c) => ({
        ...c,
        needs: c.needs?.map((n) => ({ ...n, ok: typeof n.ok === "function" ? !!n.ok() : !!n.ok })),
      })),
    }));
  }

}
