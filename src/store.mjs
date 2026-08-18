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
  #metaVersion = 0;  // bumped on every meta write; the client's poll channel

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
    this.#metaVersion++;
    await this.#saveMeta();
  }
  metaCount() {
    return Object.keys(this.#meta.data).length;
  }

  // The client's poll channel: bumped on every meta write.
  get metaVersion() { return this.#metaVersion; }

  // filename -> meta for one host (nulls skipped — nopng markers stay server-side)
  metaForHost(host) {
    const out = {};
    const prefix = host + ":";
    for (const [k, v] of Object.entries(this.#meta.data)) {
      if (k.startsWith(prefix) && v.meta) out[k.slice(prefix.length)] = v.meta;
    }
    return out;
  }

  // Filenames needing NO (re)extraction: current extractor version, or a
  // nopng negative marker (outgoing meta_fresh). Without this the scraper's
  // walk re-queues already-scraped files on every listing.
  metaFresh(host, minExt) {
    const out = new Set();
    for (const [k, v] of Object.entries(this.#meta.data)) {
      if (!k.startsWith(host + ":")) continue;
      if (v.nopng || v.ext >= minExt) out.add(k.slice(host.length + 1));
    }
    return out;
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

  get feedbackPath() {
    return this.#feedbackPath;
  }

  // Move the judgment document to a new path, live: open (or create) the
  // target, swap it in. The old file is left untouched.
  async setFeedbackPath(path) {
    const doc = await loadVersioned(path, { current: CURRENT, empty: () => ({}) });
    this.#feedbackPath = path;
    this.#feedback = doc;
  }

  // Batch exporters iterate the whole judgment document (plugin host use).
  feedbackAll() {
    return structuredClone(this.#feedback.data);
  }

  async #saveMeta() {
    await atomicWrite(this.#metaPath, new TextEncoder().encode(JSON.stringify(this.#meta)));
  }
  async #saveFeedback() {
    await atomicWrite(this.#feedbackPath, new TextEncoder().encode(JSON.stringify(this.#feedback, null, 2)));
  }
}
