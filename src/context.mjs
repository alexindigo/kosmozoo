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
import { ContentArchive } from "./content-archive.mjs";
import { FEATURES } from "./features/index.mjs";
import { directoryPortal } from "./desktop/portal.mjs";
import { EngineLifetime } from "./lifetime.mjs";

export async function buildContext({ env = Deno.env.toObject(), fakes = {}, start = true, runtime = null, appVersion = null, lifetime = new EngineLifetime() } = {}) {
  const owned = {};
  let closeTask;
  const remember = (name, value, borrowed) => { if (!borrowed) owned[name] = value; return value; };
  const close = ({ drainHttp = async () => {} } = {}) => {
    if (closeTask) return closeTask;
    const failures = [];
    // Fence source/Variations admission and streams synchronously at entry.
    try { owned.sourceActivity?.stop(); } catch (error) { failures.push(error); }
    try { owned.desktop?.stop(); } catch (error) { failures.push(error); }
    lifetime.stop();
    // Start every child's retirement before waiting for any one child. A
    // worker waiting on another owner must never delay that owner's abort.
    const stops = ["jobs", "inventory", "prefetch"].map(name => {
      try { return lifetime.track(`${name} cleanup`, owned[name]?.stop()); }
      catch (error) { failures.push(error); }
    });
    closeTask = (async () => {
      for (const result of await Promise.allSettled(stops)) if (result.status === "rejected") failures.push(result.reason);
      try { await drainHttp(); } catch (error) { failures.push(error); }
      try { await lifetime.drain(); } catch (error) { failures.push(error); }
      try { await settings?.flush?.(); } catch (error) { failures.push(error); }
      try { owned.store?.close(); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, "Context resource cleanup failed");
    })();
    return closeTask;
  };
  let settings;
  const scopedBackings = backings.withTransport(lifetime.fetch);
  try {
  const stateDir = fakes.stateDir ?? await ensureStateDir(resolveStateDir(env));
  settings = fakes.settings ?? await Settings.open(stateDir);
  const store = remember("store", fakes.store ?? await Store.open(stateDir, {
    settings,
    feedbackPath: settings.get("core", "feedbackPath", null)
      ?? env.KOZMOZOO_FEEDBACK
      ?? `${env.HOME}/Documents/kosmozoo_feedback.json`,
  }), fakes.store != null);
  const hosts = fakes.hosts ?? await loadCollections(store, env);
  const cache = fakes.cache ?? new Cache(
    env.KOZMOZOO_CACHE ?? `${env.HOME ?? "/tmp"}/.local/share/kosmozoo/cache`,
  );
  const inventory = remember("inventory", fakes.inventory ?? backings.makeCollectionInventory(hosts, {
    bindingFactory: scopedBackings.createBindingFor,
    onSnapshot: (id, _address, snapshot, token) => store.arrivals.observe(id, snapshot.items.map(item => item.name), token),
    onRetire: token => store.arrivals.forget(token.id),
  }), fakes.inventory != null);
  const ingest = fakes.ingest ?? new Ingest(store, hosts, {
    cache,
    backingFor: scopedBackings.backingFor, lifetime,
    capture: inventory.capture, isCurrent: inventory.isCurrent,
    // the default lives in ingest.mjs; the env override is the only knob
    ...(env.KOZMOZOO_REVALIDATE_MS == null ? {} : { revalidateMs: Number(env.KOZMOZOO_REVALIDATE_MS) }),
  });
  // Registry dispatch creates both driver bindings. All consumers share the
  // same address owner and collection-incarnation validation seam.
  const clientAt = inventory.binding;
  const comfy = (collection) => clientAt(hosts[collection]);
  const prefetch = remember("prefetch", fakes.prefetch ?? new Prefetch({ hosts, store, settings, ingest, inventory, signal: lifetime.signal }), fakes.prefetch != null);
  const jobs = remember("jobs", fakes.jobs ?? new Jobs({
    hosts, client: clientAt,
    onFinish(address, sources) {
      clientAt(address).invalidateInventory();
      for (const id of sources) {
        if (store.collectionGet(id)?.auto_refresh) prefetch.requestRelist(id);
      }
    },
  }), fakes.jobs != null);
  const sourceActivity = remember("sourceActivity", fakes.sourceActivity ?? new SourceActivity({ store, hosts, inventory, jobs,
    onMembership: () => prefetch.reconcile?.(),
  }), fakes.sourceActivity != null);
  const desktop = remember("desktop", fakes.desktop ?? directoryPortal({ mode: () => runtime?.()?.mode, env }), fakes.desktop != null);

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
    settings, store, hosts, backings: scopedBackings, cache, ingest, prefetch, jobs, sourceActivity, plugins, runtime, appVersion, signal: lifetime.signal,
    features: [],
    comfy, inventory,
    paths: { state: stateDir },
  };
  const router = makeRouter(ctx);
  for (const { method, path, handler } of pluginRoutes) router.add(method, path, handler);

  // feature modules: isolated core features on the engine surface
  const featureApp = {
    store, cache, hosts, ingest, comfy, desktop, lifetime,
    archive: fakes.archive ?? new ContentArchive(`${stateDir}/archives`),
    // a backing bound to one collection (engine-mediated; the feature never
    // fetches a host directly)
    backings: {
      backingFor: scopedBackings.backingFor,
      comfy: (collection) => comfy(collection),
      capture: inventory.capture,
      isCurrent: token => sourceActivity.acceptingChanges() && inventory.isCurrent(token),
      source: (collection) => sourceActivity.source(collection),
      accepting: () => sourceActivity.acceptingChanges(),
    },
    route: (method, path, handler) => router.add(method, path, handler),
  };
  // Store recovery retires dead execution ownership transactionally. Durable
  // unreferenced asset rows survive failed collection and are retried on startup.
  // Compose the existing SQL/byte owners here, never during feature registration.
  for (const { hash } of store.variationUnreferencedAssets()) {
    await featureApp.archive.collect(hash, () => store.variationAssetRefs(hash) > 0, () => store.variationForgetAsset(hash));
  }
  const features = fakes.features ?? FEATURES;
  for (const f of features) {
    f.register({
      ...featureApp,
      route: (method, path, handler) => featureApp.route(method, `/api/features/${f.name}${path}`, handler),
    });
  }
  ctx.features = features.map((f) => f.name);

  if (start) { prefetch.start(); jobs.start(); }
  return { ctx, router, discovered, close };
  } catch (error) {
    try { await close(); }
    catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Context initialization and resource cleanup failed", { cause: error });
    }
    throw error;
  }
}
