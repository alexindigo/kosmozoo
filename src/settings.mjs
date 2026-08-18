// src/settings.mjs — namespaced settings document.
//
// One versioned settings document (replaces the outgoing 22 loose
// `kosmozoo.*` keys). Namespaces: `core.*` for engine/app settings,
// `plugins.<name>.*` for plugin-persisted settings — a plugin persists
// settings without core knowing it exists.

import { join } from "node:path";
import { loadVersioned, atomicWrite } from "./state.mjs";

const CURRENT = 1;

export class Settings {
  #path;
  #doc;

  static async open(stateDir) {
    const path = join(stateDir, "settings.json");
    const doc = await loadVersioned(path, {
      current: CURRENT,
      empty: () => ({}),
      migrations: {},
    });
    const s = new Settings();
    s.#path = path;
    s.#doc = doc;
    return s;
  }

  #ns(ns) {
    if (!this.#doc.data[ns]) this.#doc.data[ns] = {};
    return this.#doc.data[ns];
  }

  get(ns, key, fallback = null) {
    const n = this.#doc.data[ns];
    return n && key in n ? n[key] : fallback;
  }

  getNs(ns) {
    return structuredClone(this.#doc.data[ns] ?? {});
  }

  async set(ns, key, value) {
    const n = this.#ns(ns);
    if (value === null || value === undefined) delete n[key];
    else n[key] = value;
    await this.#save();
  }

  async save() {
    await this.#save();
  }

  async #save() {
    await atomicWrite(this.#path, new TextEncoder().encode(JSON.stringify(this.#doc, null, 2)));
  }
}
