// src/store.mjs — the engine store: content / collection / entry (schema v7)
// + the discovered-node registry + (until the judgments commit) the
// feedback.json judgment document.
//
//   content    — what the bytes ARE: hash → meta, dims, workflow flag
//   collection — a namespace of names: a ComfyUI host, a local folder
//   entry      — collection:name → hash; carries the per-instance state
//                (stamp, seen/ingested/gone) and judgment columns
//
// This module still exposes the old host-shaped surface (metaState/hashFor/
// inputCache*/judgment*) — routes keep their shape until the collections
// API lands; the methods below are the adapters over the three tables.

import { Database } from "@db/sqlite";
import { join } from "node:path";
import { readFile, rename } from "node:fs/promises";
import { CorruptStateError } from "./state.mjs";
import { splitHostKey } from "./hosts.mjs";

const SCHEMA_VERSION = 7;
const CORE_JUDGMENT_FIELDS = new Set(["vote", "favorite", "notes"]);

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
    const rows = db.prepare("SELECT host, filename FROM metadata").all();
    const ins = db.prepare("INSERT OR IGNORE INTO files (host, filename) VALUES (?, ?)");
    const txn = db.transaction((rs) => {
      for (const r of rs) ins.run(r.host, r.filename);
    });
    txn(rows);
  },
  // v2 → v3: files.mtime for cache revalidation.
  (db) => {
    db.exec(`ALTER TABLE files ADD COLUMN mtime REAL`);
  },
  // v3 → v4: the node registry.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS node_registry (
        class_type TEXT PRIMARY KEY,
        title      TEXT,
        inputs     TEXT NOT NULL,
        updated_at REAL NOT NULL
      );
    `);
  },
  // v4 → v5: the input-file cache index.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS input_cache (
        host     TEXT NOT NULL,
        filename TEXT NOT NULL,
        hash     TEXT NOT NULL,
        stamp    TEXT,
        PRIMARY KEY (host, filename)
      );
    `);
  },
  // v5 → v6: files.stamp (+ input_cache.stamp rebuild for the dev-state flavor).
  (db) => {
    db.exec(`ALTER TABLE files ADD COLUMN stamp TEXT`);
    db.exec(`UPDATE files SET stamp = CAST(mtime AS TEXT) WHERE mtime IS NOT NULL`);
    const cols = db.prepare("PRAGMA table_info(input_cache)").all().map((c) => c.name);
    if (cols.includes("mtime") && !cols.includes("stamp")) {
      db.exec(`
        CREATE TABLE input_cache_new (
          host     TEXT NOT NULL,
          filename TEXT NOT NULL,
          hash     TEXT NOT NULL,
          stamp    TEXT,
          PRIMARY KEY (host, filename)
        );
        INSERT INTO input_cache_new (host, filename, hash, stamp)
          SELECT host, filename, hash, CAST(mtime AS TEXT) FROM input_cache;
        DROP TABLE input_cache;
        ALTER TABLE input_cache_new RENAME TO input_cache;
      `);
    }
  },
  // v6 → v7: content / collection / entry. The DATA fold lives in
  // Store.#foldV7 (it needs the settings document for hosts + hidden).
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS content (
        hash          TEXT PRIMARY KEY,
        width         INTEGER,
        height        INTEGER,
        meta          TEXT,
        has_workflow  INTEGER NOT NULL DEFAULT 0,
        ext           INTEGER NOT NULL DEFAULT 0,
        bytes         INTEGER,
        updated_at    REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS collection (
        id            TEXT PRIMARY KEY,
        kind          TEXT NOT NULL,        -- 'comfy' | 'folder' | 'virtual'
        address       TEXT,                 -- host:port | /abs/path | null
        link          TEXT,                 -- virtual → backing collection (future)
        created_at    REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS entry (
        collection    TEXT NOT NULL REFERENCES collection(id) ON DELETE CASCADE,
        name          TEXT NOT NULL,
        kind          TEXT NOT NULL DEFAULT 'output',  -- 'output' | 'input'
        hash          TEXT REFERENCES content(hash),   -- null until ingested
        stamp         TEXT,
        state         TEXT NOT NULL DEFAULT 'seen',    -- seen | ingested | gone
        vote          TEXT, favorite INTEGER, notes TEXT, hidden INTEGER,
        plugin_fields TEXT,
        first_seen    REAL NOT NULL, last_seen REAL NOT NULL,
        PRIMARY KEY (collection, name, kind)
      );
      CREATE INDEX IF NOT EXISTS entry_by_hash ON entry(hash);
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
    `);
  },
];

const kindFor = (address) => address?.startsWith("folder:") ? "folder" : "comfy";

export class Store {
  #db;

  static async open(stateDir, { settings, feedbackPath } = {}) {
    const s = new Store();
    const dbPath = join(stateDir, "metadata.db");
    s.#db = new Database(dbPath);
    s.#db.exec("PRAGMA journal_mode = WAL");
    s.#runMigrations();
    await s.#foldV7(settings);
    await s.#importFeedbackV1(feedbackPath, settings);
    return s;
  }

  // --- feedback.json v1 → entry columns (one-time) -------------------------
  // The old hash-keyed judgment document is read ONCE: each entry fans out
  // to every entry row with that hash (judgments are per entry now); legacy
  // host:filename keys name an address directly — a missing entry row is
  // created with state='gone' so nothing is lost. The source file is copied
  // to <path>.v1-backup-<ts> and never written again.
  async #importFeedbackV1(feedbackPath, settings) {
    // nothing offered — a later boot WITH a path still gets its import
    if (!feedbackPath) return;
    if (this.#kvGet("fold.feedback.v2") === "done") return;
    {
      let doc = null;
      try {
        doc = JSON.parse(await readFile(feedbackPath, "utf-8"));
      } catch (e) {
        if (e instanceof SyntaxError) {
          const quarantined = `${feedbackPath}.corrupt-${new Date().toISOString()}`;
          await rename(feedbackPath, quarantined);
          throw new CorruptStateError(feedbackPath, quarantined, e);
        }
        // ENOENT: nothing to import
      }
      if (doc) {
        const now = Date.now();
        const txn = this.#db.transaction(() => {
          for (const [key, j] of Object.entries(doc.data ?? {})) {
            if (!key.includes(":")) {
              // hash key: fan out to EVERY entry row with that hash
              for (const t of this.#db.prepare("SELECT collection, name FROM entry WHERE hash = ? AND kind = 'output'").all(key)) {
                this.#applyJudgment(t.collection, t.name, j, now);
              }
            } else {
              const [collection, name] = splitHostKey(key);
              this.#ensureCollection(collection);
              this.#db.prepare(
                "INSERT OR IGNORE INTO entry (collection, name, kind, state, first_seen, last_seen) VALUES (?, ?, 'output', 'gone', ?, ?)",
              ).run(collection, name, now, now);
              this.#applyJudgment(collection, name, j, now);
            }
          }
          this.#kvSet("fold.feedback.v2", "done");
        });
        txn();
        await rename(feedbackPath, `${feedbackPath}.v1-backup-${new Date().toISOString()}`);
      } else {
        this.#kvSet("fold.feedback.v2", "done");
      }
    }
    // the feedbackPath setting dies with the migration (sqlite is canonical)
    if (settings?.get("core", "feedbackPath", null)) {
      await settings.set("core", "feedbackPath", null);
    }
  }

  // one judgment document → one entry's columns (in the caller's transaction)
  #applyJudgment(collection, name, j, now) {
    if (!j || typeof j !== "object") return;
    const { vote, favorite, notes } = this.#pruneJudgment({
      vote: j.vote ?? null,
      favorite: j.favorite ? 1 : null,
      notes: j.notes ?? null,
      plugins: j.plugins ?? null,
    });
    this.#db.prepare(
      `INSERT INTO entry (collection, name, kind, vote, favorite, notes, plugin_fields, state, first_seen, last_seen)
       VALUES (?, ?, 'output', ?, ?, ?, ?, 'seen', ?, ?)
       ON CONFLICT(collection, name, kind) DO UPDATE SET
         vote = COALESCE(excluded.vote, entry.vote),
         favorite = COALESCE(excluded.favorite, entry.favorite),
         notes = COALESCE(excluded.notes, entry.notes),
         plugin_fields = COALESCE(excluded.plugin_fields, entry.plugin_fields)`,
    ).run(
      collection, name,
      vote, favorite,
      notes == null ? null : JSON.stringify(notes),
      j.plugins == null ? null : JSON.stringify(j.plugins),
      now, now,
    );
  }

  #runMigrations() {
    const [cur] = this.#db.prepare("PRAGMA user_version").value();
    for (let v = cur; v < SCHEMA_VERSION; v++) {
      MIGRATIONS[v](this.#db);
      this.#db.exec(`PRAGMA user_version = ${v + 1}`);
    }
  }

  // --- the v6→v7 data fold -------------------------------------------------
  // metadata/files/images/input_cache rows fold into content+entry; the
  // settings hosts map folds into collection; the hidden lists fold onto
  // entries. Old tables are dropped at the end. Idempotent via kv flag, so
  // a crash mid-fold re-runs safely (all steps are INSERT OR IGNORE/UPDATE).
  async #foldV7(settings) {
    if (this.#kvGet("fold.v7") === "done") return;
    const now = Date.now();
    const txn = this.#db.transaction(() => {
      const d = this.#db;
      // collections from the settings hosts map
      const map = settings?.get("core.hosts", "map", {}) ?? {};
      for (const [name, address] of Object.entries(map)) {
        d.prepare("INSERT OR IGNORE INTO collection (id, kind, address, created_at) VALUES (?, ?, ?, ?)")
          .run(name, kindFor(address), address, now);
      }
      // any files-table host the map doesn't know gets an offline placeholder
      d.exec(`
        INSERT OR IGNORE INTO collection (id, kind, address, created_at)
          SELECT DISTINCT host, 'comfy', NULL, ${now} FROM files;
      `);
      // content: ingested rows win; address-keyed rows only fill gaps via
      // their files.hash. nopng rows become nothing (a fresh scrape decides).
      d.exec(`
        INSERT OR IGNORE INTO content (hash, meta, has_workflow, ext, updated_at)
          SELECT hash, meta, has_workflow, ext, updated_at FROM images WHERE nopng = 0;
        INSERT OR IGNORE INTO content (hash, meta, has_workflow, ext, updated_at)
          SELECT f.hash, m.meta, m.has_workflow, m.ext, m.updated_at
          FROM metadata m JOIN files f ON f.host = m.host AND f.filename = m.filename
          WHERE m.nopng = 0 AND f.hash IS NOT NULL;
        UPDATE content SET bytes = (SELECT MAX(size) FROM files WHERE files.hash = content.hash);
        -- every entry.hash must reference a content row (FK): placeholder
        -- rows (ext=0 → stale → re-walked) for hashes whose meta was dropped
        INSERT OR IGNORE INTO content (hash, updated_at)
          SELECT hash, ${now} FROM files WHERE hash IS NOT NULL;
        INSERT OR IGNORE INTO content (hash, updated_at)
          SELECT hash, ${now} FROM input_cache;
        INSERT OR IGNORE INTO entry (collection, name, kind, hash, stamp, state, first_seen, last_seen)
          SELECT host, filename, 'output', hash, stamp,
                 CASE WHEN hash IS NULL THEN 'seen' ELSE 'ingested' END, ${now}, ${now} FROM files;
        INSERT OR IGNORE INTO entry (collection, name, kind, hash, stamp, state, first_seen, last_seen)
          SELECT host, filename, 'input', hash, stamp, 'ingested', ${now}, ${now} FROM input_cache;
        DROP TABLE metadata; DROP TABLE files; DROP TABLE images; DROP TABLE input_cache;
      `);
      // the hidden lists land on entries (created when the name is new)
      const hidden = settings?.get("core.delete", "hidden", {}) ?? {};
      for (const [host, names] of Object.entries(hidden)) {
        for (const name of names) {
          d.prepare("INSERT OR IGNORE INTO entry (collection, name, kind, state, first_seen, last_seen) VALUES (?, ?, 'output', 'seen', ?, ?)")
            .run(host, name, now, now);
          d.prepare("UPDATE entry SET hidden = 1 WHERE collection = ? AND name = ? AND kind = 'output'")
            .run(host, name);
        }
      }
      this.#kvSet("meta_version", String(Math.floor(now)));
      this.#kvSet("fold.v7", "done");
    });
    txn();
    // settings namespaces die with the fold
    if (settings?.get("core.hosts", "map", null)) {
      // no bulk-delete API: drop the keys one by one
      for (const k of Object.keys(settings.getNs("core.hosts"))) {
        await settings.set("core.hosts", k, null);
      }
    }
    if (settings?.get("core.delete", "hidden", null)) {
      await settings.set("core.delete", "hidden", null);
    }
  }

  // --- kv -------------------------------------------------------------------

  #kvGet(k) {
    return this.#db.prepare("SELECT v FROM kv WHERE k = ?").value(k)?.[0] ?? null;
  }

  #kvSet(k, v) {
    this.#db.prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
  }

  get metaVersion() {
    return Number(this.#kvGet("meta_version") ?? 0);
  }

  // bumped in the same transaction style as the meta write it versions
  #bumpMeta() {
    this.#db.exec("UPDATE kv SET v = CAST(CAST(v AS INTEGER) + 1 AS TEXT) WHERE k = 'meta_version'");
  }

  // --- collections ------------------------------------------------------------

  collections() {
    return this.#db.prepare("SELECT id, kind, address, link, created_at FROM collection ORDER BY id").all();
  }

  collectionGet(id) {
    return this.#db.prepare("SELECT id, kind, address, link, created_at FROM collection WHERE id = ?").get(id) ?? null;
  }

  // { id: address } — the shape the old hosts map had (runtime adapter).
  collectionMap() {
    const out = {};
    for (const r of this.collections()) if (r.address) out[r.id] = r.address;
    return out;
  }

  collectionAdd(id, address) {
    this.#db.prepare(
      "INSERT INTO collection (id, kind, address, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, address = excluded.address",
    ).run(id, kindFor(address), address, Date.now());
  }

  collectionRemove(id) {
    this.#db.prepare("DELETE FROM collection WHERE id = ?").run(id);
  }

  // --- node registry (discovered node types → their scalar input fields) ----

  #mergeNodeRegistry(nodes) {
    if (!Array.isArray(nodes)) return;
    const get = this.#db.prepare("SELECT title, inputs FROM node_registry WHERE class_type = ?");
    const put = this.#db.prepare(
      "INSERT INTO node_registry (class_type, title, inputs, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(class_type) DO UPDATE SET title = excluded.title, inputs = excluded.inputs, updated_at = excluded.updated_at",
    );
    for (const n of nodes) {
      if (!n?.type || !n.inputs) continue;
      const row = get.value(n.type);
      let existing = {};
      try { existing = JSON.parse(row?.[1] ?? "{}") ?? {}; } catch { existing = {}; }
      const inputs = { ...existing };
      for (const [k, v] of Object.entries(n.inputs)) inputs[k] = typeof v;
      const title = n.title ?? row?.[0] ?? null;
      put.run(n.type, title, JSON.stringify(inputs), Date.now());
    }
  }

  nodeRegistry() {
    const out = {};
    for (const row of this.#db.prepare("SELECT class_type, title, inputs FROM node_registry").all()) {
      try { out[row.class_type] = { title: row.title ?? null, inputs: JSON.parse(row.inputs) }; } catch { /* corrupt row skipped */ }
    }
    return out;
  }

  // Entries can only exist under a real collection (FK). Writers call this
  // first: an unregistered collection gets an offline placeholder row, which
  // collectionAdd later corrects (kind/address ON CONFLICT update).
  #ensureCollection(id) {
    this.#db.prepare(
      "INSERT OR IGNORE INTO collection (id, kind, address, created_at) VALUES (?, 'comfy', NULL, ?)",
    ).run(id, Date.now());
  }

  // --- input-file cache index (entry kind='input' adapter) -------------------

  inputCacheGet(host, filename) {
    const row = this.#db.prepare(
      "SELECT hash, stamp FROM entry WHERE collection = ? AND name = ? AND kind = 'input'",
    ).value(host, filename);
    return row ? { hash: row[0], stamp: row[1] } : null;
  }

  inputCachePut(host, filename, hash, stamp) {
    this.#ensureCollection(host);
    const now = Date.now();
    // the entry's hash must reference a content row (FK) — placeholder
    // (ext=0, no meta) is fine: input files have no extractor output here
    this.#db.prepare(
      "INSERT OR IGNORE INTO content (hash, updated_at) VALUES (?, ?)",
    ).run(hash, now);
    this.#db.prepare(
      `INSERT INTO entry (collection, name, kind, hash, stamp, state, first_seen, last_seen)
       VALUES (?, ?, 'input', ?, ?, 'ingested', ?, ?)
       ON CONFLICT(collection, name, kind) DO UPDATE SET hash = excluded.hash, stamp = excluded.stamp, state = 'ingested', last_seen = excluded.last_seen`,
    ).run(host, filename, hash, stamp, now, now);
  }

  // --- hash identity (entry kind='output' adapters) -------------------------

  hashFor(host, filename) {
    const row = this.#db.prepare(
      "SELECT hash FROM entry WHERE collection = ? AND name = ? AND kind = 'output'",
    ).value(host, filename);
    return row ? row[0] : null;
  }

  // Hash + source-content stamp as recorded at ingestion (revalidation input).
  fileInfo(host, filename) {
    const row = this.#db.prepare(
      "SELECT hash, stamp FROM entry WHERE collection = ? AND name = ? AND kind = 'output'",
    ).value(host, filename);
    return row ? { hash: row[0], stamp: row[1] } : null;
  }

  // Called when bytes are ingested: the entry points at the (new) hash.
  // opts.stamp — the source-content stamp at ingestion (null when unknown).
  // opts.changed — this is a RE-ingest of a file whose content changed:
  // the OLD hash's meta belongs to the old bytes; it is dropped only when
  // no other entry still references it (shared content keeps its meta).
  async ingestFile(host, filename, hash, size, { stamp = null, changed = false, dims = null } = {}) {
    this.#ensureCollection(host);
    const now = Date.now();
    const old = this.#db.prepare(
      "SELECT hash FROM entry WHERE collection = ? AND name = ? AND kind = 'output'",
    ).value(host, filename)?.[0] ?? null;

    // the content row exists as soon as the bytes do (meta filled by metaPut;
    // inserted BEFORE the entry — entry.hash references content.hash). Dims
    // land when the bytes yield them; never wiped by a dimless re-ingest.
    this.#db.prepare(
      `INSERT INTO content (hash, bytes, width, height, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(hash) DO UPDATE SET bytes = excluded.bytes,
         width = COALESCE(excluded.width, content.width),
         height = COALESCE(excluded.height, content.height)`,
    ).run(hash, size, dims?.width ?? null, dims?.height ?? null, now);

    this.#db.prepare(
      `INSERT INTO entry (collection, name, kind, hash, stamp, state, first_seen, last_seen)
       VALUES (?, ?, 'output', ?, ?, 'ingested', ?, ?)
       ON CONFLICT(collection, name, kind) DO UPDATE SET hash = excluded.hash, stamp = excluded.stamp, state = 'ingested', last_seen = excluded.last_seen`,
    ).run(host, filename, hash, stamp, now, now);

    if (changed && old && old !== hash) {
      const refs = this.#db.prepare("SELECT COUNT(*) FROM entry WHERE hash = ?").value(old)[0];
      if (refs === 0) this.#db.prepare("DELETE FROM content WHERE hash = ?").run(old);
    }
    this.#bumpMeta();
  }

  // Same content, newer source stamp (a touch, or a new ETag over identical
  // bytes): refresh the stamp only.
  touchFileStamp(host, filename, stamp) {
    this.#db.prepare(
      "UPDATE entry SET stamp = ? WHERE collection = ? AND name = ? AND kind = 'output'",
    ).run(stamp, host, filename);
  }

  // --- hidden (delete fallback on hosts that can't delete) ----------------

  // Names hidden from every listing of one collection.
  hiddenNames(collection) {
    return new Set(
      this.#db.prepare(
        "SELECT name FROM entry WHERE collection = ? AND kind = 'output' AND hidden = 1",
      ).all(collection).map((r) => r.name),
    );
  }

  // Hide one entry (the fallback delete on no-delete hosts).
  entryHide(collection, name) {
    this.#ensureCollection(collection);
    const now = Date.now();
    this.#db.prepare(
      "INSERT OR IGNORE INTO entry (collection, name, kind, state, first_seen, last_seen) VALUES (?, ?, 'output', 'seen', ?, ?)",
    ).run(collection, name, now, now);
    this.#db.prepare(
      "UPDATE entry SET hidden = 1, last_seen = ? WHERE collection = ? AND name = ? AND kind = 'output'",
    ).run(now, collection, name);
  }

  // The source lost the file: an entry state, never content state (C5).
  entryGone(host, filename) {
    this.#ensureCollection(host);
    const now = Date.now();
    this.#db.prepare(
      "INSERT OR IGNORE INTO entry (collection, name, kind, state, first_seen, last_seen) VALUES (?, ?, 'output', 'seen', ?, ?)",
    ).run(host, filename, now, now);
    this.#db.prepare(
      "UPDATE entry SET state = 'gone', last_seen = ? WHERE collection = ? AND name = ? AND kind = 'output'",
    ).run(now, host, filename);
  }

  // --- content + entry records ------------------------------------------------

  contentGet(hash) {
    const row = this.#db.prepare(
      "SELECT hash, width, height, meta, has_workflow, ext, bytes, updated_at FROM content WHERE hash = ?",
    ).get(hash) ?? null;
    if (!row) return null;
    let meta = null;
    try { meta = row.meta ? JSON.parse(row.meta) : null; } catch { /* corrupt meta */ }
    return { ...row, meta };
  }

  entryGet(collection, name, kind = "output") {
    return this.#db.prepare(
      "SELECT collection, name, kind, hash, stamp, state, vote, favorite, notes, hidden, plugin_fields, first_seen, last_seen FROM entry WHERE collection = ? AND name = ? AND kind = ?",
    ).get(collection, name, kind) ?? null;
  }

  // --- metadata (sqlite-backed, re-derivable) ----------------------------

  // extraction state for one image: pending (not walked yet) vs done — done
  // splits into has-meta and none (content row with NULL meta ≈ old nopng)
  metaState(host, filename) {
    const row = this.#db.prepare(
      `SELECT c.meta FROM entry e JOIN content c ON c.hash = e.hash
       WHERE e.collection = ? AND e.name = ? AND e.kind = 'output'`,
    ).value(host, filename);
    if (row) {
      return { extracted: true, nopng: row[0] === null, meta: row[0] ? JSON.parse(row[0]) : null };
    }
    return { extracted: false, nopng: false, meta: null };
  }

  metaGet(host, filename) {
    const row = this.#db.prepare(
      `SELECT c.meta FROM entry e JOIN content c ON c.hash = e.hash
       WHERE e.collection = ? AND e.name = ? AND e.kind = 'output'`,
    ).value(host, filename);
    if (!row || row[0] === null) return null;
    try { return JSON.parse(row[0]); } catch { return null; }
  }

  // Writes extractor output for an already-ingested file. The walk ingests
  // first (D2), so there is always a hash — meta is content state.
  async metaPut(host, filename, meta, { hasWorkflow = false, ext = 1 } = {}) {
    const hash = this.hashFor(host, filename);
    if (!hash) return;
    if (meta) this.#mergeNodeRegistry(meta.nodes);
    this.#db.prepare(
      `INSERT INTO content (hash, meta, has_workflow, ext, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(hash) DO UPDATE SET meta = excluded.meta, has_workflow = excluded.has_workflow,
         ext = excluded.ext, updated_at = excluded.updated_at`,
    ).run(hash, meta ? JSON.stringify(meta) : null, hasWorkflow ? 1 : 0, ext, Date.now());
    this.#bumpMeta();
  }

  metaCount() {
    return this.#db.prepare("SELECT COUNT(*) FROM content").value()[0];
  }

  metaForHost(host) {
    const out = {};
    for (const row of this.#db.prepare(
      `SELECT e.name, c.meta FROM entry e JOIN content c ON c.hash = e.hash
       WHERE e.collection = ? AND e.kind = 'output' AND c.meta IS NOT NULL`,
    ).all(host)) {
      try { out[row.name] = JSON.parse(row.meta); } catch { /* skip corrupt */ }
    }
    return out;
  }

  metaFresh(host, minExt) {
    const out = new Set();
    for (const row of this.#db.prepare(
      `SELECT e.name FROM entry e JOIN content c ON c.hash = e.hash
       WHERE e.collection = ? AND e.kind = 'output' AND c.ext >= ?`,
    ).all(host, minExt)) {
      out.add(row.name);
    }
    return out;
  }

  // --- judgments (entry columns; sqlite is canonical) ---------------------

  #pruneJudgment({ vote, favorite, notes, plugins }) {
    if (vote === "" || vote === undefined) vote = null;
    if (favorite === false || favorite === undefined) favorite = null;
    if (notes && typeof notes === "object") {
      for (const k of Object.keys(notes)) {
        if (notes[k] === null || notes[k] === undefined || notes[k] === "") delete notes[k];
      }
      if (Object.keys(notes).length === 0) notes = null;
    } else if (notes === "" || notes === undefined) notes = null;
    if (plugins && typeof plugins === "object") {
      for (const ns of Object.keys(plugins)) {
        const fields = plugins[ns];
        if (fields && typeof fields === "object") {
          for (const k of Object.keys(fields)) {
            if (fields[k] === null || fields[k] === undefined || fields[k] === "") delete fields[k];
          }
        }
        if (!fields || typeof fields !== "object" || Object.keys(fields).length === 0) delete plugins[ns];
      }
      if (Object.keys(plugins).length === 0) plugins = null;
    } else if (plugins === "" || plugins === undefined) plugins = null;
    return { vote: vote ?? null, favorite: favorite ?? null, notes, plugins };
  }

  #readJudgment(host, filename) {
    const row = this.#db.prepare(
      "SELECT vote, favorite, notes, plugin_fields FROM entry WHERE collection = ? AND name = ? AND kind = 'output'",
    ).get(host, filename);
    if (!row) return null;
    const j = {};
    if (row.vote != null) j.vote = row.vote;
    if (row.favorite != null) j.favorite = !!row.favorite;
    if (row.notes != null) { try { j.notes = JSON.parse(row.notes); } catch { /* corrupt */ } }
    if (row.plugin_fields != null) { try { j.plugins = JSON.parse(row.plugin_fields); } catch { /* corrupt */ } }
    return Object.keys(j).length ? j : null;
  }

  judgmentGet(host, filename) {
    return this.#readJudgment(host, filename);
  }

  // Whitelisted, deep-pruned, ONE statement. Fields: vote | favorite | notes
  // | plugins.<ns>.<field>; null/"" values prune (defaults store as absent).
  judgmentPatch(host, filename, patch) {
    const cur = this.#readJudgment(host, filename) ?? {};
    const next = {
      vote: cur.vote ?? null,
      favorite: cur.favorite ? 1 : null,
      notes: cur.notes ?? null,
      plugins: cur.plugins ?? null,
    };
    for (const [field, value] of Object.entries(patch ?? {})) {
      if (CORE_JUDGMENT_FIELDS.has(field)) {
        next[field] = field === "favorite" ? (value ? 1 : null) : value;
        continue;
      }
      if (field.startsWith("plugins.")) {
        const parts = field.split(".");
        const ns = parts[1];
        const pname = parts.slice(2).join(".");
        if (!ns || !pname) return { ok: false, error: `bad judgment field: ${field}` };
        next.plugins ??= {};
        next.plugins[ns] ??= {};
        next.plugins[ns][pname] = value;
        continue;
      }
      return { ok: false, error: `unknown judgment field: ${field}` };
    }
    const pruned = this.#pruneJudgment(next);
    this.#ensureCollection(host);
    const now = Date.now();
    this.#db.prepare("INSERT OR IGNORE INTO entry (collection, name, kind, state, first_seen, last_seen) VALUES (?, ?, 'output', 'seen', ?, ?)")
      .run(host, filename, now, now);
    this.#db.prepare(
      `UPDATE entry SET vote = ?, favorite = ?, notes = ?, plugin_fields = ?, last_seen = ?
       WHERE collection = ? AND name = ? AND kind = 'output'`,
    ).run(
      pruned.vote, pruned.favorite,
      pruned.notes == null ? null : JSON.stringify(pruned.notes),
      pruned.plugins == null ? null : JSON.stringify(pruned.plugins),
      now, host, filename,
    );
    return { ok: true, judgment: this.#readJudgment(host, filename) };
  }

  async judgmentSet(host, filename, field, value) {
    return this.judgmentPatch(host, filename, { [field]: value });
  }

  // Every judgment row, keyed for the plugin host's _all adapter (interim
  // shape: by hash when ingested, collection:name otherwise; first wins on
  // a shared hash — per-entry reads are the real API).
  judgmentsAll() {
    const out = {};
    for (const row of this.#db.prepare(
      `SELECT collection, name, hash, vote, favorite, notes, plugin_fields FROM entry
       WHERE kind = 'output' AND (vote IS NOT NULL OR favorite IS NOT NULL OR notes IS NOT NULL OR plugin_fields IS NOT NULL)`,
    ).all()) {
      const key = row.hash ?? `${row.collection}:${row.name}`;
      if (out[key]) continue;
      const j = { ref: `${row.collection}:${row.name}` };
      if (row.vote != null) j.vote = row.vote;
      if (row.favorite != null) j.favorite = !!row.favorite;
      if (row.notes != null) { try { j.notes = JSON.parse(row.notes); } catch { /* corrupt */ } }
      if (row.plugin_fields != null) { try { j.plugins = JSON.parse(row.plugin_fields); } catch { /* corrupt */ } }
      out[key] = j;
    }
    return out;
  }

  // The portable judgment document, generated on demand per collection.
  feedbackExport(collection) {
    if (!this.collectionGet(collection)) return null;
    const entries = {};
    for (const row of this.#db.prepare(
      `SELECT name, hash, vote, favorite, notes, plugin_fields FROM entry
       WHERE collection = ? AND kind = 'output' AND (vote IS NOT NULL OR favorite IS NOT NULL OR notes IS NOT NULL OR plugin_fields IS NOT NULL)
       ORDER BY name`,
    ).all(collection)) {
      const e = {};
      if (row.hash != null) e.hash = row.hash;
      if (row.vote != null) e.vote = row.vote;
      if (row.favorite != null) e.favorite = !!row.favorite;
      if (row.notes != null) { try { e.notes = JSON.parse(row.notes); } catch { /* corrupt */ } }
      if (row.plugin_fields != null) { try { e.plugins = JSON.parse(row.plugin_fields); } catch { /* corrupt */ } }
      entries[row.name] = e;
    }
    return { version: 2, collection, generated_at: new Date().toISOString(), entries };
  }

  close() {
    this.#db.close();
  }
}
