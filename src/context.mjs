// src/context.mjs — the engine context, fully constructed before the router
// (audit E1: no router.ctx reassignment, no ctx.x?. guards downstream).
//
// { settings, store, hosts, backings, cache, ingest, prefetch, jobs, plugins,
// features, comfy, paths: { state } }
//
// Tests build the same shape with fakes: buildContext({ env, fakes }).

import { resolveStateDir, ensureStateDir } from "./state.mjs";
import { Settings } from "./settings.mjs";
import { Store } from "./store.mjs";
import { loadCollections } from "./collections.mjs";
import * as backings from "./backings/index.mjs";
import { Ingest } from "./ingest.mjs";
import { Prefetch } from "./prefetch.mjs";
import { Jobs } from "./jobs.mjs";
import { SourceActivity } from "./source-activity.mjs";
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
  const inventory = fakes.inventory ?? backings.makeCollectionInventory(hosts);
  const ingest = fakes.ingest ?? new Ingest(store, hosts, {
    cache,
    capture: inventory.capture, isCurrent: inventory.isCurrent,
    // the default lives in ingest.mjs; the env override is the only knob
    ...(env.KOZMOZOO_REVALIDATE_MS == null ? {} : { revalidateMs: Number(env.KOZMOZOO_REVALIDATE_MS) }),
  });
  // Registry dispatch creates both driver bindings. All consumers share the
  // same address owner and collection-incarnation validation seam.
  const clientAt = inventory.binding;
  const comfy = (collection) => clientAt(hosts[collection]);
  const prefetch = fakes.prefetch ?? new Prefetch({ hosts, store, settings, ingest, inventory });
  const jobs = fakes.jobs ?? new Jobs({
    hosts, client: clientAt,
    onFinish(address, sources) {
      clientAt(address).invalidateInventory();
      for (const id of sources) {
        if (store.collectionGet(id)?.auto_refresh) prefetch.requestRelist(id);
      }
    },
  });
  const sourceActivity = fakes.sourceActivity ?? new SourceActivity({ store, hosts, inventory, jobs });

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
    settings, store, hosts, backings, cache, ingest, prefetch, jobs, sourceActivity, plugins,
    features: [],
    comfy, inventory,
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

  if (start) { prefetch.start(); jobs.start(); }
  return { ctx, router, discovered };
}
