// src/store.mjs — image metadata (sqlite) + judgment store (JSON).
//
// Metadata lives in sqlite via jsr:@db/sqlite@0.13.0.  Schema evolution:
//   v1 — metadata table keyed (host, filename)
//   v2 — files + images tables, hash identity
// Judgments stay in the portable feedback.json (re-keyed to hash later).

import { join } from "node:path";
import { Database } from "@db/sqlite";
import { loadVersioned, atomicWrite } from "./state.mjs";
import { hostKey, splitHostKey } from "./hosts.mjs";

const SCHEMA_VERSION = 2;

const MIGRATIONS = [
  // v0 → v1: create the single-table metadata store.
  (db) => {
    db.exec(`
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
    `);
  },
  // v1 → v2: add hash-identity tables (files + images); seed files from metadata.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        host     TEXT NOT NULL,
        filename TEXT NOT NULL,
        hash     TEXT,
        size     INTEGER,
        PRIMARY KEY (host, filename)
      );
      CREATE INDEX IF NOT EXISTS files_by_hash ON files(hash);

      CREATE TABLE IF NOT EXISTS images (
        hash         TEXT PRIMARY KEY,
        meta         TEXT,
        source       TEXT,
        has_workflow INTEGER NOT NULL DEFAULT 0,
        nopng        INTEGER NOT NULL DEFAULT 0,
        ext          INTEGER NOT NULL DEFAULT 0,
        updated_at   REAL NOT NULL
      );
    `);
    // Seed files from existing metadata — hash still null until ingestion.
    const rows = db.prepare("SELECT host, filename FROM metadata").all();
    const ins = db.prepare("INSERT OR IGNORE INTO files (host, filename) VALUES (?, ?)");
    const txn = db.transaction((rs) => {
      for (const r of rs) ins.run(r.host, r.filename);
    });
    txn(rows);
  },
];

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
    s.#runMigrations();

    // One-time migration from the old JSON metadata store if metadata is empty.
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
    // Migrate legacy host:filename judgment keys to hash keys.
    if (s.#migrateJudgments()) {
      await atomicWrite(s.#feedbackPath, new TextEncoder().encode(JSON.stringify(s.#feedback, null, 2)));
    }
    return s;
  }

  #runMigrations() {
    const [cur] = this.#db.prepare("PRAGMA user_version").value();
    for (let v = cur; v < SCHEMA_VERSION; v++) {
      MIGRATIONS[v](this.#db);
      this.#db.exec(`PRAGMA user_version = ${v + 1}`);
    }
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
        insert.run(
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
    // Seed files table too.
    this.#runMigrations();
  }

  // --- hash identity -------------------------------------------------------

  hashFor(host, filename) {
    const row = this.#db.prepare(
      "SELECT hash FROM files WHERE host = ? AND filename = ?"
    ).value(host, filename);
    return row ? row[0] : null;
  }

  // Called when bytes are ingested: record the hash and move metadata.
  async ingestFile(host, filename, hash, size) {
    this.#db.prepare(
      "INSERT INTO files (host, filename, hash, size) VALUES (?, ?, ?, ?) ON CONFLICT(host, filename) DO UPDATE SET hash = excluded.hash, size = excluded.size"
    ).run(host, filename, hash, size);

    // Move existing metadata from the legacy table to the images table.
    const metaRow = this.#db.prepare(
      "SELECT meta, source, has_workflow, nopng, ext, updated_at FROM metadata WHERE host = ? AND filename = ?"
    ).value(host, filename);
    if (metaRow) {
      this.#db.prepare(
        `INSERT OR IGNORE INTO images (hash, meta, source, has_workflow, nopng, ext, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(hash, metaRow[0], metaRow[1], metaRow[2], metaRow[3], metaRow[4], metaRow[5]);
    }

    this.#metaVersion++;
  }

  // --- metadata (sqlite-backed, re-derivable) ----------------------------

  metaGet(host, filename) {
    // Prefer images via hash if ingested; fall back to metadata table.
    const hash = this.hashFor(host, filename);
    if (hash) {
      const row = this.#db.prepare(
        "SELECT meta FROM images WHERE hash = ?"
      ).value(hash);
      if (row && row[0] !== null) {
        try { return JSON.parse(row[0]); } catch { return null; }
      }
    }
    const row = this.#db.prepare(
      "SELECT meta FROM metadata WHERE host = ? AND filename = ?"
    ).value(host, filename);
    if (!row || row[0] === null) return null;
    try { return JSON.parse(row[0]); } catch { return null; }
  }

  async metaPut(host, filename, meta, { source = "history", hasWorkflow = false, nopng = false, ext = 1 } = {}) {
    const metaJson = meta ? JSON.stringify(meta) : null;

    // If the file has been hashed, write to images; otherwise to metadata.
    const hash = this.hashFor(host, filename);
    if (hash) {
      this.#db.prepare(
        `INSERT OR REPLACE INTO images (hash, meta, source, has_workflow, nopng, ext, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(hash, metaJson, source, hasWorkflow ? 1 : 0, nopng ? 1 : 0, ext, Date.now());
    } else {
      this.#db.prepare(
        `INSERT OR REPLACE INTO metadata (host, filename, meta, source, has_workflow, nopng, ext, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(host, filename, metaJson, source, hasWorkflow ? 1 : 0, nopng ? 1 : 0, ext, Date.now());
    }
    this.#metaVersion++;
  }

  metaCount() {
    return this.#db.prepare("SELECT COUNT(*) FROM metadata").value()[0];
  }

  get metaVersion() { return this.#metaVersion; }

  metaForHost(host) {
    const out = {};
    // Collect from images via files where hash is known.
    const ing = this.#db.prepare(
      `SELECT i.meta, f.filename FROM images i
       JOIN files f ON f.hash = i.hash
       WHERE f.host = ? AND i.meta IS NOT NULL`
    ).all(host);
    for (const row of ing) {
      try { out[row.filename] = JSON.parse(row.meta); } catch { /* skip corrupt */ }
    }
    // Collect remaining from metadata where hash is still null.
    const leg = this.#db.prepare(
      `SELECT m.filename, m.meta FROM metadata m
       LEFT JOIN files f ON f.host = m.host AND f.filename = m.filename
       WHERE m.host = ? AND m.meta IS NOT NULL AND f.hash IS NULL`
    ).all(host);
    for (const row of leg) {
      try { out[row.filename] = JSON.parse(row.meta); } catch { /* skip corrupt */ }
    }
    return out;
  }

  metaFresh(host, minExt) {
    const out = new Set();
    // From images (hashed).
    const ing = this.#db.prepare(
      `SELECT f.filename FROM images i
       JOIN files f ON f.hash = i.hash
       WHERE f.host = ? AND (i.nopng = 1 OR i.ext >= ?)`
    ).all(host, minExt);
    for (const row of ing) out.add(row.filename);
    // From metadata (unhashed).
    const leg = this.#db.prepare(
      `SELECT m.filename FROM metadata m
       LEFT JOIN files f ON f.host = m.host AND f.filename = m.filename
       WHERE m.host = ? AND (m.nopng = 1 OR m.ext >= ?) AND f.hash IS NULL`
    ).all(host, minExt);
    for (const row of leg) out.add(row.filename);
    return out;
  }

  // --- judgments (JSON-backed, irreplaceable — keyed by hash) ---

  // Resolve (host, filename) to the best judgment key.  If the file has been
  // hashed and an entry exists under that hash, use the hash.  If not, but
  // an entry exists under the legacy host:filename key, use that.  Otherwise
  // prefer the hash key for writes and fall back to the legacy key for reads.
  #judgmentKey(host, filename) {
    const hash = this.hashFor(host, filename);
    if (hash && this.#feedback.data[hash]) return [hash, true];
    const legacy = hostKey(host, filename);
    if (this.#feedback.data[legacy]) return [legacy, false];
    return [hash || legacy, !!hash];
  }

  judgmentGet(host, filename) {
    const [key] = this.#judgmentKey(host, filename);
    return structuredClone(this.#feedback.data[key] ?? null);
  }

  async judgmentSet(host, filename, field, value) {
    const [key, isHash] = this.#judgmentKey(host, filename);
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
    // If we just created an entry under a hash key and there was a legacy
    // entry, remove the legacy one (migration happens lazily on first write).
    if (isHash) {
      const legacy = hostKey(host, filename);
      if (this.#feedback.data[legacy] && key !== legacy) {
        delete this.#feedback.data[legacy];
      }
      // Stamp the ref field so the portable file is human-readable.
      entry.ref = legacy;
    }
    if (Object.keys(entry).length === 0) delete this.#feedback.data[key];
    else this.#feedback.data[key] = entry;
    await this.#saveFeedback();
  }

  // Migrate existing judgment entries from host:filename keys to hash keys.
  // Idempotent: entries already keyed by hash are left alone.
  #migrateJudgments() {
    const hashes = new Map();
    let changed = false;
    const newData = {};

    for (const [key, entry] of Object.entries(this.#feedback.data)) {
      if (!key.includes(":")) {
        // Already a hash key (or other non-host:filename key) — keep.
        newData[key] = entry;
        continue;
      }
      // Looks like a legacy "host:filename" key.  Try to resolve a hash.
      const [host, filename] = splitHostKey(key);
      // Build a cache of host lookups so we only query files once per host.
      if (!hashes.has(host)) {
        const rows = this.#db.prepare(
          "SELECT filename, hash FROM files WHERE host = ? AND hash IS NOT NULL"
        ).all(host);
        const m = new Map();
        for (const row of rows) m.set(row.filename, row.hash);
        hashes.set(host, m);
      }
      const hash = hashes.get(host).get(filename);
      if (hash) {
        entry.ref = key;
        newData[hash] = entry;
        changed = true;
      } else {
        // File gone — keep as orphan under the legacy key.
        newData[key] = entry;
      }
    }

    if (changed) {
      this.#feedback.data = newData;
    }
    return changed;
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
