// src/store.mjs — image metadata (sqlite) + judgment store (JSON).
//
// Metadata moves from a versioned JSON document to sqlite via
// jsr:@db/sqlite@0.13.0 — same API surface, backed by the schema below.
// Judgments stay in the portable feedback.json (re-keyed to hash in the
// next commit).

import { join } from "node:path";
import { Database } from "@db/sqlite";
import { loadVersioned, atomicWrite } from "./state.mjs";
import { hostKey, splitHostKey } from "./hosts.mjs";

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS metadata (
  host         TEXT NOT NULL,
  filename     TEXT NOT NULL,
  meta         TEXT,
  source       TEXT,
  has_workflow INTEGER NOT NULL DEFAULT 0,
  nopng        INTEGER NOT NULL DEFAULT 0,
  ext          INTEGER NOT NULL DEFAULT 0,
  updated_at   REAL NOT NULL,
  PRIMARY KEY (host, filename)
);
PRAGMA user_version = ${SCHEMA_VERSION};
`;

export class Store {
  #db;
  #feedbackPath;
  #feedback;
  #metaVersion = 0;

  static async open(stateDir, feedbackPath) {
    const s = new Store();
    const dbPath = join(stateDir, "metadata.db");
    s.#db = new Database(dbPath);
    s.#db.exec("PRAGMA journal_mode = WAL");
    s.#db.exec(SCHEMA);

    // One-time migration from the old JSON metadata store if it exists and
    // sqlite is empty.
    const count = s.#db.prepare("SELECT COUNT(*) FROM metadata").value()[0];
    if (count === 0) {
      await s.#migrateFromJson(join(stateDir, "metadata.json"));
    }

    s.#feedbackPath = feedbackPath;
    s.#feedback = await loadVersioned(feedbackPath, {
      current: 1,
      empty: () => ({}),
      migrations: {},
    });
    return s;
  }

  // One-shot: read old metadata.json versioned document, insert into sqlite.
  async #migrateFromJson(jsonPath) {
    const { readFile } = await import("node:fs/promises");
    let doc;
    try {
      doc = JSON.parse(await readFile(jsonPath, "utf-8"));
    } catch {
      return; // no old store
    }
    const insert = this.#db.prepare(
      "INSERT OR REPLACE INTO metadata (host, filename, meta, source, has_workflow, nopng, ext, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    const txn = this.#db.transaction((rows) => {
      for (const [key, v] of rows) {
        const [host, filename] = splitHostKey(key);
        txn.run(
          host, filename,
          v.meta ? JSON.stringify(v.meta) : null,
          v.source ?? null,
          v.hasWorkflow ? 1 : 0,
          v.nopng ? 1 : 0,
          v.ext ?? 0,
          v.updatedAt ?? Date.now()
        );
      }
    });
    txn(Object.entries(doc.data ?? {}));
    this.#metaVersion = count;
  }

  // --- metadata (sqlite-backed, re-derivable) ----------------------------

  metaGet(host, filename) {
    const row = this.#db.prepare(
      "SELECT meta FROM metadata WHERE host = ? AND filename = ?"
    ).value(host, filename);
    if (!row || row[0] === null) return null;
    try { return JSON.parse(row[0]); } catch { return null; }
  }

  async metaPut(host, filename, meta, { source = "history", hasWorkflow = false, nopng = false, ext = 1 } = {}) {
    this.#db.prepare(
      `INSERT OR REPLACE INTO metadata (host, filename, meta, source, has_workflow, nopng, ext, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      host, filename,
      meta ? JSON.stringify(meta) : null,
      source,
      hasWorkflow ? 1 : 0,
      nopng ? 1 : 0,
      ext,
      Date.now()
    );
    this.#metaVersion++;
  }

  metaCount() {
    return this.#db.prepare("SELECT COUNT(*) FROM metadata").value()[0];
  }

  get metaVersion() { return this.#metaVersion; }

  metaForHost(host) {
    const out = {};
    const rows = this.#db.prepare(
      "SELECT filename, meta FROM metadata WHERE host = ? AND meta IS NOT NULL"
    ).all(host);
    for (const row of rows) {
      try { out[row.filename] = JSON.parse(row.meta); } catch { /* skip corrupt */ }
    }
    return out;
  }

  metaFresh(host, minExt) {
    const out = new Set();
    const rows = this.#db.prepare(
      "SELECT filename FROM metadata WHERE host = ? AND (nopng = 1 OR ext >= ?)"
    ).all(host, minExt);
    for (const row of rows) out.add(row.filename);
    return out;
  }

  // --- judgments (JSON-backed, irreplaceable — re-keyed to hash later) ---

  judgmentGet(host, filename) {
    return structuredClone(this.#feedback.data[hostKey(host, filename)] ?? null);
  }

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

  async setFeedbackPath(path) {
    const doc = await loadVersioned(path, {
      current: 1,
      empty: () => ({}),
      migrations: {},
    });
    this.#feedbackPath = path;
    this.#feedback = doc;
  }

  feedbackAll() {
    return structuredClone(this.#feedback.data);
  }

  async #saveFeedback() {
    await atomicWrite(this.#feedbackPath, new TextEncoder().encode(JSON.stringify(this.#feedback, null, 2)));
  }

  close() {
    this.#db.close();
  }
}
