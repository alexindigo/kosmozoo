// src/context.mjs — the engine context, fully constructed before the router
// (audit E1: no router.ctx reassignment, no ctx.x?. guards downstream).
//
//   { settings, store, hosts, backings, cache, ingest, prefetch, plugins,
//     features, comfy, paths: { state } }
//
// Tests build the same shape with fakes: buildContext({ env, fakes }).

import { resolveStateDir, ensureStateDir } from "./state.mjs";
import { Settings } from "./settings.mjs";
import { Store } from "./store.mjs";
import { loadCollections } from "./collections.mjs";
import * as backings from "./backings/index.mjs";
import * as comfyBacking from "./backings/comfy.mjs";
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
  const ingest = fakes.ingest ?? new Ingest(store, hosts, {
    cache,
    // the default lives in ingest.mjs; the env override is the only knob
    ...(env.KOZMOZOO_REVALIDATE_MS == null ? {} : { revalidateMs: Number(env.KOZMOZOO_REVALIDATE_MS) }),
  });
  const prefetch = fakes.prefetch ?? new Prefetch({ hosts, store, settings, ingest });

  // one comfy client per address — its assets-plus and object_info caches
  // are instance state, so nothing outlives the address it belongs to
  const comfyClients = new Map(); // addr → client
  const comfy = (collection) => {
    const addr = hosts[collection];
    let client = comfyClients.get(addr);
    if (!client) {
      client = comfyBacking.comfyClient(addr);
      comfyClients.set(addr, client);
    }
    return client;
  };

  // plugin routes are collected here and mounted once the router exists —
  // the context (plugin host included) is fully built before the router,
  // and nothing is reassigned afterwards (E1)
  const pluginRoutes = [];
  const plugins = fakes.plugins ?? new PluginHost({
    store, settings, hosts, cache, ingest,
    route: (method, path, handler) => pluginRoutes.push({ method, path, handler }),
  });
  const discovered = plugins === fakes.plugins ? [] : await plugins.discover();

  const ctx = {
    settings, store, hosts, backings, cache, ingest, prefetch, plugins,
    features: [],
    comfy,
    paths: { state: stateDir },
  };
  const router = makeRouter(ctx);
  for (const { method, path, handler } of pluginRoutes) router.add(method, path, handler);

  // feature modules: isolated core features on the engine surface
  const featureApp = {
    store, cache, hosts, ingest, comfy,
    // a backing bound to one collection (engine-mediated; the feature never
    // fetches a host directly)
    backings: {
      comfy: (collection) => comfy(collection),
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
