// src/settings.mjs — namespaced settings document.
//
// One versioned settings document (replaces the outgoing 22 loose
// `kosmozoo.*` keys). Namespaces: `core.*` for engine/app settings,
// `plugins.<name>.*` for plugin-persisted settings — a plugin persists
// settings without core knowing it exists.

import { join } from "node:path";
import { loadVersioned } from "./state.mjs";
import { writeSerialized, flushSerialized } from "./writer.mjs";

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
    s.#doc = { ...doc, data: Object.assign(Object.create(null), doc.data) };
    return s;
  }

  #ns(ns) {
    const current = Object.hasOwn(this.#doc.data, ns) ? this.#doc.data[ns] : null;
    if (!current || typeof current !== "object" || Array.isArray(current)) this.#doc.data[ns] = Object.create(null);
    else if (Object.getPrototypeOf(current) !== null) this.#doc.data[ns] = Object.assign(Object.create(null), current);
    return this.#doc.data[ns];
  }

  get(ns, key, fallback = null) {
    const n = Object.hasOwn(this.#doc.data, ns) ? this.#doc.data[ns] : null;
    if (!n || !Object.hasOwn(n, key)) return fallback;
    const v = n[key];
    return v !== null && typeof v === "object" ? structuredClone(v) : v;
  }

  getNs(ns) {
    return structuredClone(Object.hasOwn(this.#doc.data, ns) ? this.#doc.data[ns] : {});
  }

  async set(ns, key, value) {
    await this.patch(ns, { [key]: value });
  }

  // A namespace patch is one mutation and one serialized snapshot, regardless
  // of its field count. Dictionary keys never traverse object prototypes.
  async patch(ns, fields) {
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new TypeError("Settings patch must be an object");
    const n = this.#ns(ns);
    for (const [key, value] of Object.entries(fields)) {
      if (value === null || value === undefined) delete n[key];
      else n[key] = value;
    }
    await this.#save();
  }

  // Mutate the whole document via fn and persist ONCE — for multi-namespace
  // edits (the v7 fold's settings cleanup) that must land as one write.
  async update(fn) {
    fn(this.#doc.data);
    await this.#save();
  }

  async #save() {
    await writeSerialized(this.#path, new TextEncoder().encode(JSON.stringify(this.#doc, null, 2)));
  }

  flush() { return flushSerialized(this.#path); }
}
