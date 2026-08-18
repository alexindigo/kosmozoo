// src/store.mjs — image metadata + judgment store.
//
// Engine state is a versioned JSON document (no third-party storage
// dependency; the feedback.json discipline generalised). Image metadata is
// re-derivable from hosts; judgments are irreplaceable and live in the
// user-configured feedback.json path (outside the repo) — the store keeps
// them in separate documents so the portable curation file stays portable.

import { join } from "node:path";
import { loadVersioned, atomicWrite } from "./state.mjs";
import { hostKey } from "./hosts.mjs";

const CURRENT = 1;

export class Store {
  #metaPath;
  #feedbackPath;
  #meta;      // { version, data: { "host:filename": { meta, source, hasWorkflow, nopng, ext, updatedAt } } }
  #feedback;  // { version, data: { "host:filename": { notes:{pos,neg}, vote, favorite, plugins:{...} } } }

  static async open(stateDir, feedbackPath) {
    const s = new Store();
    s.#metaPath = join(stateDir, "metadata.json");
    s.#feedbackPath = feedbackPath;
    s.#meta = await loadVersioned(s.#metaPath, { current: CURRENT, empty: () => ({}) });
    s.#feedback = await loadVersioned(s.#feedbackPath, { current: CURRENT, empty: () => ({}) });
    return s;
  }

  // --- metadata (re-derivable) -------------------------------------------
  metaGet(host, filename) {
    return this.#meta.data[hostKey(host, filename)]?.meta ?? null;
  }
  async metaPut(host, filename, meta, { source = "history", hasWorkflow = false, nopng = false, ext = 1 } = {}) {
    this.#meta.data[hostKey(host, filename)] = { meta, source, hasWorkflow, nopng, ext, updatedAt: Date.now() };
    await this.#saveMeta();
  }
  metaCount() {
    return Object.keys(this.#meta.data).length;
  }

  // --- judgments (irreplaceable) -----------------------------------------
  judgmentGet(host, filename) {
    return structuredClone(this.#feedback.data[hostKey(host, filename)] ?? null);
  }
  // Field set to its default is stored as absent; an entry prunes only when
  // fully empty (harvest #13).
  async judgmentSet(host, filename, field, value) {
    const key = hostKey(host, filename);
    const entry = this.#feedback.data[key] ?? {};
    if (field.startsWith("plugins.")) {
      const [, plugin, ...rest] = field.split(".");
      const pname = rest.join(".");
      if (!entry.plugins) entry.plugins = {};
      if (!entry.plugins[plugin]) entry.plugins[plugin] = {};
      if (value === null || value === undefined) delete entry.plugins[plugin][pname];
      else entry.plugins[plugin][pname] = value;
      if (Object.keys(entry.plugins[plugin]).length === 0) delete entry.plugins[plugin];
      if (Object.keys(entry.plugins).length === 0) delete entry.plugins;
    } else {
      if (value === null || value === undefined || value === "") delete entry[field];
      else entry[field] = value;
    }
    if (Object.keys(entry).length === 0) delete this.#feedback.data[key];
    else this.#feedback.data[key] = entry;
    await this.#saveFeedback();
  }

  feedbackCount() {
    return Object.keys(this.#feedback.data).length;
  }

  async #saveMeta() {
    await atomicWrite(this.#metaPath, new TextEncoder().encode(JSON.stringify(this.#meta)));
  }
  async #saveFeedback() {
    await atomicWrite(this.#feedbackPath, new TextEncoder().encode(JSON.stringify(this.#feedback, null, 2)));
  }
}
