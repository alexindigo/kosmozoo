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
      try {
        const mod = await import(join(dir, entry));
        if (typeof mod.register === "function") await mod.register(kz);
        break;
      } catch (e) {
        if (e.code === "ERR_MODULE_NOT_FOUND" || /Cannot find/.test(String(e))) continue;
        console.error(`plugin ${name}: register failed —`, e.message);
      }
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
      // server route under /api/plugins/<name>/...
      route: (method, path, handler) => {
        router.add(method, `/api/plugins/${name}${path}`, handler);
        caps.push({ kind: "route", method, path: `/api/plugins/${name}${path}` });
      },
      probe: (def) => caps.push({ kind: "probe", ...def }),
      exporter: (def) => caps.push({ kind: "exporter", ...def }),
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
        _all: () => store.feedbackAll(), // batch exporters iterate this
      },
      // engine-mediated host fetch so plugins never talk to ComfyUI directly
      _fetchImageBytes: async (hostFilenameKey) => {
        const i = hostFilenameKey.indexOf(":");
        const host = hostFilenameKey.slice(0, i), filename = hostFilenameKey.slice(i + 1);
        const { proxyImage } = await import("./hosts.mjs");
        const r = await proxyImage(ctx.hosts[host], filename);
        if (r.status !== 200) return null;
        return new Uint8Array(await new Response(r.body).arrayBuffer());
      },
    };
  }

  list() {
    return [...this.#plugins.values()].map(({ name, capabilities, hasClient }) => ({
      name, capabilities, hasClient,
    }));
  }

  clientUrl(name) {
    const p = this.#plugins.get(name);
    return p?.hasClient ? `/plugins/${name}/client.js` : null;
  }
}
