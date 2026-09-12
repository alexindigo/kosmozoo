// src/context.mjs — the engine context, fully constructed before the router
// (audit E1: no router.ctx reassignment, no ctx.x?. guards downstream).
//
//   { settings, store, hosts, backings, ingest, prefetch, plugins, features,
//     paths: { state } }
//
// Tests build the same shape with fakes: buildContext({ env, fakes }).

import { resolveStateDir, ensureStateDir } from "./state.mjs";
import { Settings } from "./settings.mjs";
import { Store } from "./store.mjs";
import { loadCollections } from "./collections.mjs";
import * as backings from "./backings/index.mjs";
import * as comfyBacking from "./backings/comfy.mjs";
import * as folderBacking from "./backings/folder.mjs";
import { Ingest } from "./ingest.mjs";
import { Prefetch } from "./prefetch.mjs";
import { PluginHost } from "./plugins.mjs";
import { makeRouter } from "./routes.mjs";
import { Cache } from "./cache.mjs";
import { FEATURES } from "./features/index.mjs";

export async function buildContext({ env = Deno.env.toObject(), fakes = {}, start = true } = {}) {
  const stateDir = fakes.stateDir ?? await ensureStateDir(resolveStateDir(env));
  const settings = fakes.settings ?? await Settings.open(stateDir);
  const store = fakes.store ?? await Store.open(stateDir, {
    settings,
    feedbackPath: settings.get("core", "feedbackPath", null)
      ?? env.KOZMOZOO_FEEDBACK
      ?? `${env.HOME}/Documents/kosmozoo_feedback.json`,
  });
  const hosts = fakes.hosts ?? await loadCollections(store, env);
  const cache = fakes.cache ?? new Cache(
    env.KOZMOZOO_CACHE ?? `${env.HOME ?? "/tmp"}/.local/share/kosmozoo/cache`,
  );
  const revalidateMs = Number(env.KOZMOZOO_REVALIDATE_MS ?? 60_000);
  const ingest = fakes.ingest ?? new Ingest(store, hosts, { cache, revalidateMs });
  const prefetch = fakes.prefetch ?? new Prefetch({ hosts, store, settings, ingest });

  // one object, fields known up front; plugins fill before serving
  const ctx = {
    settings, store, hosts, backings, cache, ingest, prefetch,
    plugins: null, features: [],
    paths: { state: stateDir },
  };
  const router = makeRouter(ctx);
  const plugins = fakes.plugins ?? new PluginHost({ store, settings, router, hosts, cache });
  const discovered = plugins === fakes.plugins ? [] : await plugins.discover();
  ctx.plugins = plugins;

  // feature modules: isolated core features on the engine surface
  const featureApp = {
    store, cache, hosts,
    // a backing bound to one collection (engine-mediated; the feature never
    // fetches a host directly)
    backings: {
      comfy: (collection) => {
        const addr = hosts[collection];
        return {
          objectInfo: () => comfyBacking.objectInfo(addr),
          enqueue: (prompt) => comfyBacking.enqueue(addr, prompt),
        };
      },
      folder: (collection) => {
        const addr = hosts[collection];
        return {
          read: (name, kind) => folderBacking.read(addr, name, kind),
          stat: (name, kind) => folderBacking.stat(addr, name, kind),
        };
      },
    },
    route: (method, path, handler) => router.add(method, path, handler),
  };
  const features = fakes.features ?? FEATURES;
  for (const f of features) {
    f.register({
      ...featureApp,
      route: (method, path, handler) => featureApp.route(method, `/api/features/${f.name}${path}`, handler),
    });
  }
  ctx.features = features.map((f) => f.name);

  if (start) prefetch.start();
  return { ctx, router, discovered };
}
