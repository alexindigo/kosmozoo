// tests/helpers/rig.mjs — the shared state rig: a temp state dir with
// settings + store + cache + ingest wired the way buildContext wires them.
// Replaces the ~50 hand-rolled mkdtemp + Settings.open + Store.open +
// Ingest + Cache setups across the suite.
//
//   const rig = await mkStateRig("name", { hosts, revalidateMs });
//   … use rig.store / rig.ingest / rig.settings …
//   await rig.close();

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings } from "../../src/settings.mjs";
import { Store } from "../../src/store.mjs";
import { Cache } from "../../src/cache.mjs";
import { Ingest } from "../../src/ingest.mjs";
import { makeCollectionInventory } from "../../src/backings/index.mjs";

// Same injected inventory surface as the real context: driver dispatch stays
// in the registry, state/config/scan flights belong to the address client.
export function makeTestInventory(hosts) {
  return makeCollectionInventory(hosts);
}

export async function mkStateRig(name, { hosts = {}, revalidateMs, feedbackPath, dir } = {}) {
  const ownDir = dir ?? await mkdtemp(join(tmpdir(), `kz-${name}-`));
  const settings = await Settings.open(ownDir);
  const store = await Store.open(ownDir, {
    settings,
    ...(feedbackPath ? { feedbackPath: join(ownDir, feedbackPath) } : {}),
  });
  const cache = new Cache(join(ownDir, "cache"));
  const inventory = makeTestInventory(hosts);
  const ingest = new Ingest(store, hosts, {
    cache,
    capture: inventory.capture, isCurrent: inventory.isCurrent,
    ...(revalidateMs === undefined ? {} : { revalidateMs }),
  });
  return {
    dir: ownDir, settings, store, cache, ingest, hosts, inventory,
    async close() {
      await inventory.stop();
      try { store.close(); } catch { /* already closed */ }
      await rm(ownDir, { recursive: true, force: true });
    },
  };
}
