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
  #store;
  #settings;
  #hosts;
  #cache;
  #ingest;
  #route;

  // route: (method, path, handler) — where plugin routes are mounted. The
  // context hands a collector in before the router exists (E1); the router
  // mounts the collected routes after it is built.
  constructor({ store, settings, hosts, cache, ingest, route }) {
    this.#store = store;
    this.#settings = settings;
    this.#hosts = hosts;
    this.#cache = cache;
    this.#ingest = ingest;
    this.#route = route;
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
    return {
      // composition modes (client) / alignment contributions are announced
      // as capabilities and picked up by the client half
      mode: (id, def) => caps.push({ kind: "mode", id, ...def }),
      alignment: (id, def) => caps.push({ kind: "alignment", id, ...def }),
      // server route under /api/plugins/<name>/...
      route: (method, path, handler) => {
        this.#route(method, `/api/plugins/${name}${path}`, handler);
        caps.push({ kind: "route", method, path: `/api/plugins/${name}${path}` });
      },
      // plugin-scoped persistence, namespaced so core need not know it exists
      settings: {
        get: (k, fb) => this.#settings.get(`plugins.${name}`, k, fb),
        set: (k, v) => this.#settings.set(`plugins.${name}`, k, v),
        ns: () => this.#settings.getNs(`plugins.${name}`),
      },
      store: {
        getField: (host, filename, field) =>
          this.#store.judgmentGet(host, filename)?.plugins?.[name]?.[field] ?? null,
        setField: (host, filename, field, value) =>
          this.#store.judgmentSet(host, filename, `plugins.${name}.${field}`, value),
      },
      // engine-mediated content access (the public surface — no plugin
      // talks to a host or the cache directly)
      content: {
        bytes: (hash) => this.#cache.get(hash),
        graph: (hash) => this.#ingest.graph(hash),
        // bytes by entry address (hash resolution + cache read in one)
        bytesForEntry: async (collection, fname) => {
          const hash = this.#store.hashFor(collection, fname);
          return hash ? this.#cache.get(hash) : null;
        },
      },
      // the core judgment record, per entry (no batch consumer today —
      // kz.judgments.all was deleted with its zero callers)
      judgments: {
        get: (host, filename) => this.#store.judgmentGet(host, filename),
        set: (host, filename, field, value) => this.#store.judgmentSet(host, filename, field, value),
      },
      // the shared {error, reason} response shape (detector, critic, …)
      reason: (status, error, reason) => Response.json({ error, reason }, { status }),
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
