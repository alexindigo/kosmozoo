// src/store.mjs - the engine store: content / collection / entry (schema v10)
// + the discovered-node registry.
//
// content — what the bytes ARE: hash → meta, dims, workflow flag
// collection — a namespace of names: a ComfyUI host, a local folder
// entry — collection:name → hash; carries the per-instance state
// (stamp, seen/ingested/gone) and judgment columns
//
// The host-shaped surface (metaState/hashFor/inputCache*/judgment*) is what
// routes, ingest, prefetch and the plugin host consume; each method maps
// onto the three tables.

import { Database } from "@db/sqlite";
import { join } from "node:path";
import { copyFile, readFile, rename } from "node:fs/promises";
import { CorruptStateError } from "./state.mjs";
import { splitHostKey } from "./collections.mjs";
import { SourceArrivals } from "./source-arrivals.mjs";
import { isResourceRoot } from "./parameters.mjs";

const SCHEMA_VERSION = 10;
const CORE_JUDGMENT_FIELDS = new Set(["vote", "favorite", "bookmark", "notes"]);

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
        width         INTEGER, height INTEGER,         -- dims known before the hash is (the dims pass)
        first_seen    REAL NOT NULL, last_seen REAL NOT NULL,
        PRIMARY KEY (collection, name, kind)
      );
      CREATE INDEX IF NOT EXISTS entry_by_hash ON entry(hash);
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
    `);
  },
  // v7 → v8: independent per-entry bookmarks; existing entries stay unset.
  (db) => {
    db.exec(`ALTER TABLE entry ADD COLUMN bookmark INTEGER`);
  },
  // v8 → v9: source preferences. Column-aware for a retry after the schema
  // committed but the runner's separate version write did not.
  (db) => {
    db.transaction(() => {
      const columns = new Set(db.prepare("PRAGMA table_info(collection)").all().map((c) => c.name));
      for (const name of ["pinned", "auto_refresh"]) {
        if (!columns.has(name)) {
          db.exec(`ALTER TABLE collection ADD COLUMN ${name} INTEGER NOT NULL DEFAULT 0 CHECK (${name} IN (0, 1))`);
        }
      }
    })();
  },
];


// v9 -> v10: isolated feature records; retry after the separate version write
// changes no old table or row. Bytes remain in the context-owned archive.
MIGRATIONS.push(db => db.transaction(() => db.exec(`
  CREATE TABLE IF NOT EXISTS variation_run (
    id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, format INTEGER NOT NULL,
    recipe_json TEXT, targets_json TEXT, snapshot_json TEXT, snapshot_hash TEXT,
    summary_json TEXT NOT NULL, capture_state TEXT NOT NULL,
    outcome TEXT NOT NULL DEFAULT 'preparing', planned_count TEXT,
    submitted_count INTEGER NOT NULL DEFAULT 0, total_count INTEGER,
    updated_at INTEGER NOT NULL, deleted_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS variation_asset (
    hash TEXT PRIMARY KEY, bytes INTEGER NOT NULL, mime TEXT, complete INTEGER NOT NULL CHECK(complete = 1)
  );
  CREATE TABLE IF NOT EXISTS variation_asset_ref (
    run_id TEXT NOT NULL REFERENCES variation_run(id), resource_id TEXT NOT NULL,
    hash TEXT REFERENCES variation_asset(hash), descriptor_json TEXT NOT NULL,
    PRIMARY KEY(run_id,resource_id)
  );
  CREATE TABLE IF NOT EXISTS variation_effect (
    run_id TEXT NOT NULL REFERENCES variation_run(id), effect_id TEXT NOT NULL,
    kind TEXT NOT NULL, request_json TEXT NOT NULL, request_hash TEXT NOT NULL,
    state TEXT NOT NULL, result_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY(run_id,effect_id)
  );
  CREATE TABLE IF NOT EXISTS variation_lease (
    lease_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES variation_run(id),
    kind TEXT NOT NULL CHECK(kind IN ('editor','execution')), created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS variation_run_page ON variation_run(created_at DESC,id DESC) WHERE deleted_at IS NULL;
  CREATE INDEX IF NOT EXISTS variation_refs_hash ON variation_asset_ref(hash);
  CREATE INDEX IF NOT EXISTS variation_effect_run ON variation_effect(run_id,state);
  CREATE INDEX IF NOT EXISTS variation_lease_run ON variation_lease(run_id);
  INSERT OR IGNORE INTO kv(k,v) VALUES('variations.history.revision','0');
`))());

// Every recurring statement is prepared ONCE (audit D9: a prepare per call
// is a compile per call — a 3000-file listing compiled ~10k statements).
// The registry is prepared eagerly in open right after the migrations.
const STATEMENTS = {
  variationGet: "SELECT * FROM variation_run WHERE id = ?",
  variationList: `SELECT id,created_at,format,summary_json,capture_state,outcome,planned_count,submitted_count,total_count,updated_at FROM variation_run
    WHERE deleted_at IS NULL AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC,id DESC LIMIT ?`,
  variationBegin: `INSERT INTO variation_run(id,created_at,format,recipe_json,targets_json,summary_json,capture_state,updated_at)
    VALUES(?,?,?,?,?,?,'preparing',?)`,
  variationReserve: "INSERT INTO variation_asset_ref(run_id,resource_id,descriptor_json) VALUES(?,?,?)",
  variationResource: "SELECT * FROM variation_asset_ref WHERE run_id = ? AND resource_id = ?",
  variationResources: "SELECT * FROM variation_asset_ref WHERE run_id = ? ORDER BY rowid",
  variationAsset: "INSERT OR IGNORE INTO variation_asset(hash,bytes,mime,complete) VALUES(?,?,?,1)",
  variationAttach: "UPDATE variation_asset_ref SET hash = ? WHERE run_id = ? AND resource_id = ? AND hash IS NULL",
  variationSeal: "UPDATE variation_run SET snapshot_json = ?, snapshot_hash = ?, summary_json = ?, capture_state = 'complete', updated_at = ? WHERE id = ?",
  variationOutcome: "UPDATE variation_run SET outcome = ?, summary_json = ?, submitted_count = ?, total_count = ?, planned_count = ?, updated_at = ? WHERE id = ?",
  variationTombstone: "UPDATE variation_run SET deleted_at = ?,updated_at = ? WHERE id = ? AND deleted_at IS NULL",
  variationLease: "SELECT * FROM variation_lease WHERE run_id = ? AND lease_id = ?",
  variationLeaseAdd: "INSERT INTO variation_lease(lease_id,run_id,kind,created_at) VALUES(?,?,?,?)",
  variationLeaseRelease: "DELETE FROM variation_lease WHERE run_id = ? AND lease_id = ?",
  variationPins: "SELECT COUNT(*) AS n FROM variation_lease WHERE run_id = ?",
  variationExecutionPins: "SELECT COUNT(*) AS n FROM variation_lease WHERE run_id = ? AND kind = 'execution'",
  variationBusy: "SELECT COUNT(*) AS n FROM variation_effect WHERE run_id = ? AND state IN ('started','uncertain')",
  variationRefsDrop: "DELETE FROM variation_asset_ref WHERE run_id = ?",
  variationCompact: "UPDATE variation_run SET recipe_json = NULL,targets_json = NULL,snapshot_json = NULL WHERE id = ?",
  variationEffectsCompact: "UPDATE variation_effect SET request_json = 'null',result_json = NULL WHERE run_id = ?",
  variationAssetRefs: "SELECT COUNT(*) AS n FROM variation_asset_ref WHERE hash = ?",
  variationAssetForget: "DELETE FROM variation_asset WHERE hash = ? AND NOT EXISTS(SELECT 1 FROM variation_asset_ref WHERE hash = ?)",
  variationUnreferencedAssets: "SELECT hash FROM variation_asset WHERE NOT EXISTS(SELECT 1 FROM variation_asset_ref r WHERE r.hash = variation_asset.hash)",
  variationEffectGet: "SELECT * FROM variation_effect WHERE run_id = ? AND effect_id = ?",
  variationEffects: "SELECT * FROM variation_effect WHERE run_id = ? ORDER BY rowid",
  variationEffectPrepare: `INSERT INTO variation_effect(run_id,effect_id,kind,request_json,request_hash,state,created_at,updated_at)
    VALUES(?,?,?,?,?,'prepared',?,?)`,
  variationEffectClaim: "UPDATE variation_effect SET state = 'started',updated_at = ? WHERE run_id = ? AND effect_id = ? AND state = 'prepared'",
  variationEffectResult: "UPDATE variation_effect SET state = ?,result_json = ?,updated_at = ? WHERE run_id = ? AND effect_id = ? AND state = 'started'",
  variationRecoveryEffects: "UPDATE variation_effect SET state = 'uncertain',updated_at = ? WHERE state = 'started'",
  variationRecoveryExecutionRuns: "SELECT DISTINCT run_id FROM variation_lease WHERE kind = 'execution'",
  variationRecoveryExecutionPins: "DELETE FROM variation_lease WHERE kind = 'execution'",
  variationRecoveryCaptures: "UPDATE variation_run SET capture_state = 'interrupted',outcome = 'interrupted',updated_at = ? WHERE capture_state = 'preparing'",
  variationRecoveryRuns: `UPDATE variation_run SET outcome = CASE WHEN EXISTS
    (SELECT 1 FROM variation_effect e WHERE e.run_id = variation_run.id AND e.state = 'uncertain')
    THEN 'uncertain' ELSE 'interrupted' END,
    submitted_count = (SELECT COUNT(*) FROM variation_effect e WHERE e.run_id = variation_run.id AND e.kind = 'permutation' AND e.state IN ('confirmed','partial')),
    updated_at = ? WHERE outcome = 'preparing' OR (outcome <> 'uncertain' AND EXISTS
    (SELECT 1 FROM variation_effect e WHERE e.run_id = variation_run.id AND e.state = 'uncertain'))`,
  variationBump: "UPDATE kv SET v = CAST(CAST(v AS INTEGER) + 1 AS TEXT) WHERE k = 'variations.history.revision'",
  kvGet: "SELECT v FROM kv WHERE k = ?",
  kvSet: "INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
  bumpMeta: "UPDATE kv SET v = CAST(CAST(v AS INTEGER) + 1 AS TEXT) WHERE k = 'meta_version'",
  collectionsAll: "SELECT id, kind, address, link, created_at, pinned, auto_refresh FROM collection ORDER BY rowid",
  collectionGet: "SELECT id, kind, address, link, created_at, pinned, auto_refresh FROM collection WHERE id = ?",
  // a re-add with a DIFFERENT address must not silently re-point the id —
  // the route answers 409; the statement itself never updates
  collectionAdd: "INSERT OR IGNORE INTO collection (id, kind, address, created_at, pinned, auto_refresh) VALUES (?, ?, ?, ?, ?, ?)",
  collectionPatch: "UPDATE collection SET pinned = COALESCE(?, pinned), auto_refresh = COALESCE(?, auto_refresh) WHERE id = ?",
  collectionRemove: "DELETE FROM collection WHERE id = ?",
  ensureCollection: "INSERT OR IGNORE INTO collection (id, kind, address, created_at) VALUES (?, 'comfy', NULL, ?)",
  nodeRegGet: "SELECT title, inputs FROM node_registry WHERE class_type = ?",
  nodeRegPut: "INSERT INTO node_registry (class_type, title, inputs, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(class_type) DO UPDATE SET title = excluded.title, inputs = excluded.inputs, updated_at = excluded.updated_at",
  nodeRegAll: "SELECT class_type, title, inputs FROM node_registry",
  resourceCacheGet: "SELECT hash, stamp FROM entry WHERE collection = ? AND name = ? AND kind = ?",
  contentPlaceholder: "INSERT OR IGNORE INTO content (hash, updated_at) VALUES (?, ?)",
  resourceCachePut: `INSERT INTO entry (collection, name, kind, hash, stamp, state, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, 'ingested', ?, ?)
       ON CONFLICT(collection, name, kind) DO UPDATE SET
         width = NULL, height = NULL,
         hash = excluded.hash, stamp = excluded.stamp, state = 'ingested', last_seen = excluded.last_seen`,
  hashFor: "SELECT hash FROM entry WHERE collection = ? AND name = ? AND kind = 'output'",
  fileInfo: "SELECT hash, stamp FROM entry WHERE collection = ? AND name = ? AND kind = 'output'",
  entryGet: "SELECT collection, name, kind, hash, stamp, state, vote, favorite, bookmark, notes, hidden, plugin_fields, width, height, first_seen, last_seen FROM entry WHERE collection = ? AND name = ? AND kind = ?",
  // one joined row per entry (entry ⟕ content) — judgment, dims and byte
  // size arrive in the SAME row, so a listing never queries per entry
  entryJoined: `SELECT e.name, e.hash, e.state, e.hidden, e.vote, e.favorite, e.bookmark, e.notes, e.plugin_fields,
       CASE WHEN e.hash IS NULL THEN e.width ELSE c.width END AS width,
       CASE WHEN e.hash IS NULL THEN e.height ELSE c.height END AS height,
       c.bytes, c.meta
     FROM entry e LEFT JOIN content c ON c.hash = e.hash
     WHERE e.collection = ? AND e.name = ? AND e.kind = 'output'`,
  entriesForCollection: `SELECT e.name, e.hash, e.state, e.hidden, e.vote, e.favorite, e.bookmark, e.notes, e.plugin_fields,
       CASE WHEN e.hash IS NULL THEN e.width ELSE c.width END AS width,
       CASE WHEN e.hash IS NULL THEN e.height ELSE c.height END AS height,
       c.bytes, c.meta
     FROM entry e LEFT JOIN content c ON c.hash = e.hash
     WHERE e.collection = ? AND e.kind = ?`,
  entryInsertSeen: "INSERT OR IGNORE INTO entry (collection, name, kind, state, first_seen, last_seen) VALUES (?, ?, 'output', 'seen', ?, ?)",
  entryGone: "UPDATE entry SET state = 'gone', last_seen = ? WHERE collection = ? AND name = ? AND kind = 'output'",
  entryHide: "UPDATE entry SET hidden = 1, last_seen = ? WHERE collection = ? AND name = ? AND kind = 'output'",
  hiddenNames: "SELECT name FROM entry WHERE collection = ? AND kind = 'output' AND hidden = 1",
  contentGet: "SELECT hash, width, height, meta, has_workflow, ext, bytes, updated_at FROM content WHERE hash = ?",
  contentIngest: `INSERT INTO content (hash, bytes, width, height, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(hash) DO UPDATE SET bytes = COALESCE(excluded.bytes, content.bytes),
         width = COALESCE(excluded.width, content.width),
         height = COALESCE(excluded.height, content.height)`,
  contentRefs: "SELECT COUNT(*) FROM entry WHERE hash = ?",
  contentDelete: "DELETE FROM content WHERE hash = ?",
  entriesByHash: "SELECT collection, name FROM entry WHERE hash = ? AND kind = 'output'",
  entryOutputIngest: `INSERT INTO entry (collection, name, kind, hash, stamp, state, first_seen, last_seen)
       VALUES (?, ?, 'output', ?, ?, 'ingested', ?, ?)
       ON CONFLICT(collection, name, kind) DO UPDATE SET
         width = NULL, height = NULL,
         hash = excluded.hash, stamp = excluded.stamp, state = 'ingested', last_seen = excluded.last_seen`,
  touchFileStamp: "UPDATE entry SET stamp = ? WHERE collection = ? AND name = ? AND kind = 'output'",
  metaStateJoin: `SELECT c.meta FROM entry e JOIN content c ON c.hash = e.hash
       WHERE e.collection = ? AND e.name = ? AND e.kind = 'output'`,
  metaPut: `INSERT INTO content (hash, meta, has_workflow, ext, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(hash) DO UPDATE SET meta = excluded.meta, has_workflow = excluded.has_workflow,
         ext = excluded.ext, updated_at = excluded.updated_at`,
  metaForHost: `SELECT e.name, c.meta FROM entry e JOIN content c ON c.hash = e.hash
       WHERE e.collection = ? AND e.kind = 'output' AND c.meta IS NOT NULL`,
  metaFresh: `SELECT e.name FROM entry e JOIN content c ON c.hash = e.hash
       WHERE e.collection = ? AND e.kind = 'output' AND c.ext >= ?`,
  judgmentRead: "SELECT vote, favorite, bookmark, notes, plugin_fields FROM entry WHERE collection = ? AND name = ? AND kind = 'output'",
  judgmentUpdate: `UPDATE entry SET vote = ?, favorite = ?, bookmark = ?, notes = ?, plugin_fields = ?, last_seen = ?
       WHERE collection = ? AND name = ? AND kind = 'output'`,
  judgmentApply: `INSERT INTO entry (collection, name, kind, vote, favorite, bookmark, notes, plugin_fields, state, first_seen, last_seen)
       VALUES (?, ?, 'output', ?, ?, ?, ?, ?, 'seen', ?, ?)
       ON CONFLICT(collection, name, kind) DO UPDATE SET
         vote = COALESCE(excluded.vote, entry.vote),
         favorite = COALESCE(excluded.favorite, entry.favorite),
         bookmark = COALESCE(excluded.bookmark, entry.bookmark),
         notes = COALESCE(excluded.notes, entry.notes),
         plugin_fields = COALESCE(excluded.plugin_fields, entry.plugin_fields)`,
  entryInsertGone: "INSERT OR IGNORE INTO entry (collection, name, kind, state, first_seen, last_seen) VALUES (?, ?, 'output', 'gone', ?, ?)",
  entryInsertGoneHash: "INSERT OR IGNORE INTO entry (collection, name, kind, hash, state, first_seen, last_seen) VALUES (?, ?, 'output', ?, 'gone', ?, ?)",
  feedbackExport: `SELECT name, hash, vote, favorite, bookmark, notes, plugin_fields FROM entry
       WHERE collection = ? AND kind = 'output' AND (vote IS NOT NULL OR favorite IS NOT NULL OR bookmark IS NOT NULL OR notes IS NOT NULL OR plugin_fields IS NOT NULL)
       ORDER BY name`,
  instancesOf: "SELECT collection, name FROM entry WHERE hash = ? AND kind = 'output' ORDER BY collection, name",
  goneNames: "SELECT name FROM entry WHERE collection = ? AND kind = 'output' AND state = 'gone'",
  entryDims: `SELECT CASE WHEN e.hash IS NULL THEN e.width ELSE c.width END AS width,
        CASE WHEN e.hash IS NULL THEN e.height ELSE c.height END AS height
       FROM entry e LEFT JOIN content c ON c.hash = e.hash
       WHERE e.collection = ? AND e.name = ? AND e.kind = ?`,
  entryDimsPut: `INSERT INTO entry (collection, name, kind, width, height, state, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, 'seen', ?, ?)
       ON CONFLICT(collection, name, kind) DO UPDATE SET
         width = COALESCE(excluded.width, entry.width),
         height = COALESCE(excluded.height, entry.height),
         last_seen = excluded.last_seen WHERE entry.hash IS NULL`,
  dimsKnown: `SELECT e.name FROM entry e LEFT JOIN content c ON c.hash = e.hash
       WHERE e.collection = ? AND e.kind = 'output'
         AND (CASE WHEN e.hash IS NULL THEN e.width ELSE c.width END) IS NOT NULL
         AND (CASE WHEN e.hash IS NULL THEN e.height ELSE c.height END) IS NOT NULL`,
  dimsForHost: `SELECT e.name, CASE WHEN e.hash IS NULL THEN e.width ELSE c.width END AS width,
        CASE WHEN e.hash IS NULL THEN e.height ELSE c.height END AS height
       FROM entry e LEFT JOIN content c ON c.hash = e.hash
       WHERE e.collection = ? AND e.kind = 'output'
         AND (CASE WHEN e.hash IS NULL THEN e.width ELSE c.width END) IS NOT NULL
         AND (CASE WHEN e.hash IS NULL THEN e.height ELSE c.height END) IS NOT NULL`,
};

const kindFor = (address) => address?.startsWith("folder:") ? "folder" : "comfy";

export class Store {
  #db;
  #q; // prepared statement registry (see STATEMENTS)
  #ready = false;
  #collectionListeners = new Set();
  #collectionRevisions = new Map();
  // Session-local change index over the durable cursor. Older/restarted
  // cursors receive a full snapshot; no delivery history enters the schema.
  #metaFloor = 0;
  #metaChanges = new Map();

  static async open(stateDir, { settings, feedbackPath } = {}) {
    const s = new Store();
    const dbPath = join(stateDir, "metadata.db");
    s.#db = new Database(dbPath);
    try {
      s.#db.exec("PRAGMA journal_mode = WAL");
      // the schema declares ON DELETE CASCADE and entry→content references —
      // without this pragma they are decoration
      s.#db.exec("PRAGMA foreign_keys = ON");
      s.#runMigrations();
      s.#q = Object.fromEntries(
        Object.entries(STATEMENTS).map(([k, sql]) => [k, s.#db.prepare(sql)]),
      );
      await s.#foldV7(settings);
      s.arrivals = new SourceArrivals(s); // in-memory only; schema/settings unchanged
      const stats = await s.#importFeedbackV1(feedbackPath, settings);
      if (stats) {
        console.log(
          `feedback v1 import: ${stats.applied} applied` +
            ` (${stats.fannedOut} fanned out by hash, ${stats.orphansByRef} recovered via ref),` +
            ` ${stats.dropped} dropped`,
        );
      }
      s.#metaFloor = s.metaVersion;
      s.#db.transaction(() => {
        const now = Date.now();
        const effects = s.#q.variationRecoveryEffects.run(now);
        const captures = s.#q.variationRecoveryCaptures.run(now);
        const runs = s.#q.variationRecoveryRuns.run(now);
        // Request executions died with the server. Editor drafts did not; their
        // pins and durable uncertain effects independently retain resources.
        const executions = s.#q.variationRecoveryExecutionRuns.all();
        s.#q.variationRecoveryExecutionPins.run();
        for (const { run_id } of executions) s.#variationRetire(run_id);
        if (effects || captures || runs) s.#q.variationBump.run();
      })();
      s.#ready = true;
      return s;
    } catch (error) {
      // Ownership transfers only on return. The caller cannot close an
      // unreturned Store; the binding also retires partially prepared statements.
      try { s.close(); }
      catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Store initialization and resource cleanup failed", { cause: error });
      }
      throw error;
    }
  }

  // History owns only its feature tables and revision, never inventory cursors.
  variationRevision() { return Number(this.#kvGet("variations.history.revision") ?? 0); }
  variationGet(id) { return this.#q.variationGet.get(id); }
  variationList(limit, before = { at: Number.MAX_SAFE_INTEGER, id: "\uffff" }) {
    return this.#q.variationList.all(before.at, before.at, before.id, limit);
  }
  #variationLive(id) {
    const row = this.variationGet(id);
    if (!row || row.deleted_at !== null || row.recipe_json === null) throw Object.assign(new Error("History entry unavailable"), { status: 410 });
    return row;
  }
  variationBegin({ id, format, recipeJson, targetsJson, summaryJson, resources, now = Date.now() }) {
    return this.#db.transaction(() => {
      const previous = this.variationGet(id);
      if (previous) {
        if (previous.deleted_at !== null) throw Object.assign(new Error("History entry unavailable"), { status: 410 });
        if (previous.format !== format || previous.recipe_json !== recipeJson || previous.targets_json !== targetsJson ||
          resources.some(r => this.variationResource(id, r.id)?.descriptor_json !== r.descriptorJson)) {
          throw Object.assign(new Error("History capture conflict"), { status: 409 });
        }
        return previous;
      }
      this.#q.variationBegin.run(id, now, format, recipeJson, targetsJson, summaryJson, now);
      for (const r of resources) this.#q.variationReserve.run(id, r.id, r.descriptorJson);
      this.#q.variationBump.run();
      return this.variationGet(id);
    })();
  }
  variationResources(id) { return this.#q.variationResources.all(id); }
  variationResource(id, resourceId) { return this.#q.variationResource.get(id, resourceId); }
  variationReserve(id, resourceId, descriptorJson) {
    this.#db.transaction(() => {
      const run = this.#variationLive(id), previous = this.variationResource(id, resourceId);
      if (previous) {
        if (previous.descriptor_json !== descriptorJson) throw Object.assign(new Error("History resource conflict"), { status: 409 });
        return;
      }
      if (run.capture_state !== "preparing") throw Object.assign(new Error("History snapshot is sealed"), { status: 409 });
      this.#q.variationReserve.run(id, resourceId, descriptorJson);
    })();
  }
  variationAttach(id, resourceId, { hash, bytes, mime }) {
    this.#db.transaction(() => {
      const run = this.#variationLive(id), ref = this.variationResource(id, resourceId);
      if (!ref) throw Object.assign(new Error("History resource unavailable"), { status: 410 });
      if (ref.hash) {
        if (ref.hash !== hash) throw Object.assign(new Error("History bytes conflict"), { status: 409 });
        return;
      }
      if (run.capture_state !== "preparing") throw Object.assign(new Error("History snapshot is sealed"), { status: 409 });
      this.#q.variationAsset.run(hash, bytes, mime);
      this.#q.variationAttach.run(hash, id, resourceId);
    })();
  }
  variationSeal(id, snapshotJson, snapshotHash, summaryJson) {
    this.#db.transaction(() => {
      const previous = this.#variationLive(id);
      if (previous.snapshot_hash) {
        if (previous.snapshot_hash !== snapshotHash || previous.snapshot_json !== snapshotJson) throw Object.assign(new Error("History snapshot conflict"), { status: 409 });
        return;
      }
      if (previous.capture_state !== "preparing" || this.variationResources(id).some(r => !r.hash)) throw Object.assign(new Error("History archive incomplete"), { status: 409 });
      this.#q.variationSeal.run(snapshotJson, snapshotHash, summaryJson, Date.now(), id);
      this.#q.variationBump.run();
    })();
  }
  variationOutcome(id, outcome, summaryJson, { submitted = 0, total = null, planned = null } = {}) {
    // A late result may enrich an existing tombstone but cannot recreate it.
    if (!this.variationGet(id)) return;
    this.#db.transaction(() => {
      this.#q.variationOutcome.run(outcome, summaryJson, submitted, total, planned === null ? null : String(planned), Date.now(), id);
      this.#q.variationBump.run();
    })();
  }
  variationLeaseAcquire(id, kind, leaseId) {
    return this.#db.transaction(() => {
      this.#variationLive(id);
      const existing = this.#q.variationLease.get(id, leaseId);
      if (existing) {
        if (existing.kind !== kind) throw Object.assign(new Error("History lease conflict"), { status: 409 });
        return existing;
      }
      this.#q.variationLeaseAdd.run(leaseId, id, kind, Date.now());
      return this.#q.variationLease.get(id, leaseId);
    })();
  }
  variationLease(id, leaseId) { return this.#q.variationLease.get(id, leaseId); }
  variationLeaseRelease(id, leaseId) { this.#q.variationLeaseRelease.run(id, leaseId); }
  variationTombstone(id) {
    this.#db.transaction(() => {
      if (this.#q.variationTombstone.run(Date.now(), Date.now(), id)) this.#q.variationBump.run();
    })();
  }
  variationRetire(id) {
    return this.#db.transaction(() => this.#variationRetire(id))();
  }
  #variationRetire(id) {
    const run = this.variationGet(id);
    if (!run || run.deleted_at === null || this.#q.variationPins.get(id).n || this.#q.variationBusy.get(id).n) return [];
    const hashes = [...new Set(this.variationResources(id).map(r => r.hash).filter(Boolean))];
    this.#q.variationRefsDrop.run(id);
    this.#q.variationCompact.run(id);
    this.#q.variationEffectsCompact.run(id);
    return hashes;
  }
  variationAssetRefs(hash) { return this.#q.variationAssetRefs.get(hash).n; }
  variationForgetAsset(hash) { return this.#q.variationAssetForget.run(hash, hash); }
  variationUnreferencedAssets() { return this.#q.variationUnreferencedAssets.all(); }
  variationPrepareEffect(id, effectId, kind, requestJson, requestHash) {
    return this.#db.transaction(() => {
      const run = this.variationGet(id);
      if (!run || run.deleted_at !== null && !this.#q.variationExecutionPins.get(id).n) throw Object.assign(new Error("History entry unavailable"), { status: 410 });
      const previous = this.#q.variationEffectGet.get(id, effectId);
      if (previous) {
        if (previous.kind !== kind || previous.request_hash !== requestHash || previous.request_json !== requestJson) throw Object.assign(new Error("History effect conflict"), { status: 409 });
        return previous;
      }
      this.#q.variationEffectPrepare.run(id, effectId, kind, requestJson, requestHash, Date.now(), Date.now());
      return this.#q.variationEffectGet.get(id, effectId);
    })();
  }
  variationClaimEffect(id, effectId) {
    return this.#db.transaction(() => {
      const run = this.variationGet(id);
      if (!run || run.deleted_at !== null && !this.#q.variationPins.get(id).n) return false;
      return this.#q.variationEffectClaim.run(Date.now(), id, effectId) === 1;
    })();
  }
  variationClaimExecution(id, effectId) {
    return this.#db.transaction(() => {
      this.#variationLive(id);
      if (this.#q.variationEffectClaim.run(Date.now(), id, effectId) !== 1) return null;
      // A fresh owner ID, not the replayable acknowledgement ID. Claim and pin
      // commit together, so failed duplicates never acquire or release a pin.
      const leaseId = crypto.randomUUID();
      this.#q.variationLeaseAdd.run(leaseId, id, "execution", Date.now());
      return leaseId;
    })();
  }
  variationEffectResult(id, effectId, state, resultJson) {
    if (!["confirmed", "rejected", "partial", "uncertain"].includes(state)) throw new Error("Invalid effect result state");
    this.#db.transaction(() => {
      if (this.#q.variationEffectResult.run(state, resultJson, Date.now(), id, effectId)) this.#q.variationBump.run();
    })();
  }
  variationEffects(id) { return this.#q.variationEffects.all(id); }

  // --- feedback.json v1 → entry columns (one-time) -------------------------
  // The old hash-keyed judgment document is read ONCE: each entry fans out
  // to every entry row with that hash (judgments are per entry now); legacy
  // host:filename keys name an address directly — a missing entry row is
  // created with state='gone' so nothing is lost. A hash key matching no
  // entry falls back to the judgment's own ref ("<host>:<filename>"): the
  // entry is created state='gone' with the hash set; a key with no rows and
  // no usable ref is counted as dropped and logged — nothing is silently
  // lost. The source file is copied to <path>.v1-backup-<ts> and the done
  // flag (not the file's absence) prevents re-import.
  async #importFeedbackV1(feedbackPath, settings) {
    // nothing offered — a later boot WITH a path still gets its import
    if (!feedbackPath) return;
    if (this.#kvGet("fold.feedback.v2") === "done") return;
    let doc = null;
    try {
      doc = JSON.parse(await readFile(feedbackPath, "utf-8"));
    } catch (e) {
      if (e instanceof SyntaxError) {
        const quarantined = `${feedbackPath}.corrupt-${new Date().toISOString()}`;
        await rename(feedbackPath, quarantined);
        throw new CorruptStateError(feedbackPath, quarantined, e);
      }
      if (e.code !== "ENOENT") {
        // only a missing file means "nothing to import" — a real read error
        // (EACCES on a root-owned file, EISDIR, …) stops the boot instead of
        // presenting an empty judgment table as a completed import
        throw new Error(
          `${feedbackPath}: feedback import failed (${e.code ?? "error"}): ${e.message}`,
          { cause: e },
        );
      }
      // ENOENT: nothing to import
    }
    const stats = { applied: 0, fannedOut: 0, orphansByRef: 0, dropped: 0 };
    const now = Date.now();
    const txn = this.#db.transaction(() => {
      for (const [key, j] of Object.entries(doc?.data ?? {})) {
        if (!key.includes(":")) {
          // hash key: fan out to EVERY entry row with that hash
          const rows = this.#q.entriesByHash.all(key);
          if (rows.length > 0) {
            stats.applied++;
            for (const t of rows) {
              this.#applyJudgment(t.collection, t.name, j, now);
              stats.fannedOut++;
            }
            continue;
          }
          // no entry carries this hash — the ref names where it lived
          const ref = typeof j?.ref === "string" ? j.ref : "";
          const i = ref.indexOf(":");
          if (i > 0 && ref.slice(0, i) && ref.slice(i + 1)) {
            const [collection, name] = [ref.slice(0, i), ref.slice(i + 1)];
            this.#ensureCollection(collection);
            this.#q.contentPlaceholder.run(key, now); // entry.hash references content
            this.#q.entryInsertGoneHash.run(collection, name, key, now, now);
            this.#applyJudgment(collection, name, j, now);
            stats.applied++;
            stats.orphansByRef++;
            continue;
          }
          stats.dropped++;
          console.warn(`feedback import: dropped judgment "${key}" — no entry rows, no usable ref`);
        } else {
          const [collection, name] = splitHostKey(key);
          this.#ensureCollection(collection);
          this.#q.entryInsertGone.run(collection, name, now, now);
          this.#applyJudgment(collection, name, j, now);
          stats.applied++;
        }
      }
      this.#kvSet("fold.feedback.v2", "done");
      this.#kvSet("fold.feedback.v2.stats", JSON.stringify(stats));
    });
    txn();
    // copy, never rename: the source may be a bind-mounted single file or in
    // a root-owned dir; the done flag prevents re-import either way. Only
    // when a document was actually read — ENOENT leaves nothing to copy.
    if (doc) {
      await copyFile(feedbackPath, `${feedbackPath}.v1-backup-${new Date().toISOString()}`);
    }
    // the feedbackPath setting dies with the migration (sqlite is canonical)
    if (settings?.get("core", "feedbackPath", null)) {
      await settings.set("core", "feedbackPath", null);
    }
    return stats;
  }

  // one judgment document → one entry's columns (in the caller's transaction)
  #applyJudgment(collection, name, j, now) {
    if (!j || typeof j !== "object") return;
    const { vote, favorite, notes, plugins } = this.#pruneJudgment({
      vote: j.vote ?? null,
      favorite: j.favorite ? 1 : null,
      notes: j.notes ?? null,
      plugins: j.plugins ?? null,
    });
    this.#q.judgmentApply.run(
      collection, name,
      vote, favorite, null, // legacy imports never create or clear bookmarks
      notes == null ? null : JSON.stringify(notes),
      plugins == null ? null : JSON.stringify(plugins),
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
  // The settings-side cleanup runs on every boot until it succeeds: it checks
  // the namespaces themselves, so a settings write that failed after the
  // transaction committed is retried on the next boot.
  async #foldV7(settings) {
    if (this.#kvGet("fold.v7") !== "done") {
      const now = Date.now();
      const txn = this.#db.transaction(() => {
        const d = this.#db;
        // collections from the settings hosts map
        const map = settings?.get("core.hosts", "map", {}) ?? {};
        for (const [name, address] of Object.entries(map)) {
          d.prepare("INSERT OR IGNORE INTO collection (id, kind, address, created_at) VALUES (?, ?, ?, ?)")
            .run(name, kindFor(address), address, now);
        }
        // a host the old tables know but the map doesn't gets an offline
        // placeholder: the fold cannot know its address, so kind defaults to
        // comfy — the rehearsal report lists these by name
        const known = new Set(Object.keys(map));
        for (const table of ["files", "input_cache"]) {
          for (const r of d.prepare(`SELECT DISTINCT host FROM ${table}`).all()) {
            if (known.has(r.host)) continue;
            known.add(r.host);
            console.warn(
              `fold v7: host "${r.host}" appears in ${table} but not the hosts map —` +
                ` created as an offline collection (kind comfy, no address)`,
            );
            d.prepare("INSERT OR IGNORE INTO collection (id, kind, address, created_at) VALUES (?, 'comfy', NULL, ?)")
              .run(r.host, now);
          }
        }
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
        // the hidden lists land on entries (created when the name is new);
        // a hidden host with no collection row gets one first, or the FK
        // would orphan the entry
        const hidden = settings?.get("core.delete", "hidden", {}) ?? {};
        for (const [host, names] of Object.entries(hidden)) {
          this.#ensureCollection(host);
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
    }
    await this.#retireFoldedSettings(settings);
  }

  // The namespaces the fold consumed: core.hosts.map and core.delete.hidden
  // moved into the db; core.scraper is renamed core.prefetch. Edited in
  // memory, persisted once; checked by namespace (not flag) so a failed
  // write re-runs here on the next boot.
  async #retireFoldedSettings(settings) {
    if (!settings) return;
    const dirty =
      settings.get("core.hosts", "map", null) != null ||
      settings.get("core.delete", "hidden", null) != null ||
      Object.keys(settings.getNs("core.scraper")).length > 0;
    if (!dirty) return;
    try {
      await settings.update((data) => {
        if (data["core.hosts"]?.map !== undefined) delete data["core.hosts"].map;
        if (data["core.delete"]?.hidden !== undefined) delete data["core.delete"].hidden;
        if (data["core.scraper"] !== undefined) {
          data["core.prefetch"] = { ...(data["core.prefetch"] ?? {}), ...data["core.scraper"] };
          delete data["core.scraper"];
        }
        for (const ns of ["core.hosts", "core.delete"]) {
          if (data[ns] && Object.keys(data[ns]).length === 0) delete data[ns];
        }
      });
    } catch (e) {
      console.warn(`fold v7: settings cleanup failed (retried next boot): ${e?.message ?? e}`);
    }
  }

  // --- kv -------------------------------------------------------------------

  #kvGet(k) {
    return this.#q.kvGet.value(k)?.[0] ?? null;
  }

  #kvSet(k, v) {
    this.#q.kvSet.run(k, v);
  }

  get metaVersion() {
    return Number(this.#kvGet("meta_version") ?? 0);
  }

  // bumped in the same transaction style as the meta write it versions
  #bumpMeta(host, name, hash = null, { meta = true, dims = true, aliasMeta = meta, aliasDims = dims, kind = "output" } = {}) {
    this.#q.bumpMeta.run();
    const v = this.metaVersion;
    const entries = hash && (aliasMeta || aliasDims) ? this.#q.entriesByHash.all(hash) : [{ collection: host, name }];
    for (const entry of entries) {
      const target = kind === "output" && entry.collection === host && entry.name === name;
      const changedMeta = target ? meta : aliasMeta, changedDims = target ? dims : aliasDims;
      if (!changedMeta && !changedDims) continue;
      const key = `${entry.collection}\0${entry.name}`;
      const previous = this.#metaChanges.get(key);
      this.#metaChanges.set(key, { ...entry,
        meta: changedMeta ? v : previous?.meta ?? 0, dims: changedDims ? v : previous?.dims ?? 0 });
    }
    // Bounded history: a reader behind this floor safely resynchronizes.
    if (this.#metaChanges.size > 10000) { this.#metaFloor = v; this.#metaChanges.clear(); }
  }

  // The current state of demanded identities, independent of any cursor: a
  // want acknowledgement carries what the engine already knows, so a delta a
  // reader could not yet apply (its inventory lacked the entry) is never lost.
  metadataFor(host, names, { meta = true } = {}) {
    const items = {}, dims = {};
    for (const name of names) {
      const row = this.entryJoined(host, name);
      if (!row) continue;
      if (meta && row.meta !== null) {
        try { items[row.name] = JSON.parse(row.meta); } catch { /* corrupt row skipped */ }
      }
      if (row.width != null && row.height != null) dims[row.name] = { width: row.width, height: row.height };
    }
    return { items, dims };
  }

  metadataSince(host, since = null) {
    const v = this.metaVersion;
    if (since !== null && Number(since) === v) return { v, changed: false };
    const cursor = since === null || since === "" ? NaN : Number(since);
    if (!Number.isSafeInteger(cursor) || cursor < this.#metaFloor || cursor > v) {
      return { v, changed: true, items: this.metaForHost(host), dims: this.dimsForHost(host) };
    }
    const items = {}, dims = {};
    for (const change of this.#metaChanges.values()) {
      if (change.collection !== host || Math.max(change.meta, change.dims) <= cursor) continue;
      const row = this.entryJoined(host, change.name);
      if (!row) continue;
      if (change.meta > cursor && row.meta !== null) {
        try { items[row.name] = JSON.parse(row.meta); } catch { /* corrupt row skipped */ }
      }
      if (change.dims > cursor && row.width != null && row.height != null) {
        dims[row.name] = { width: row.width, height: row.height };
      }
    }
    return { v, changed: true, items, dims };
  }

  // --- collections ------------------------------------------------------------

  collections() {
    return this.#q.collectionsAll.all();
  }

  collectionGet(id) {
    return this.#q.collectionGet.get(id) ?? null;
  }

  subscribeCollections(listener) {
    this.#collectionListeners.add(listener);
    return () => this.#collectionListeners.delete(listener);
  }

  collectionRevision(id) { return this.#collectionRevisions.get(id) ?? 0; }

  #collectionCommitted(id, row) {
    // Boot imports use transactions and precede subscribers. Runtime statements
    // are autocommitted before this boundary; delivery cannot roll SQL back.
    if (!this.#ready) return;
    const revision = this.collectionRevision(id) + 1;
    this.#collectionRevisions.set(id, revision);
    const event = Object.freeze({ id, row: row ? Object.freeze({ ...row }) : null, revision });
    for (const listener of this.#collectionListeners) {
      try { listener(event); }
      catch (error) { console.error("Source collection delivery failed:", error); }
    }
  }

  // { id: address } — the { name: address } shape routes, ingest, prefetch
  // and the plugin host hold (collections with no address stay out).
  collectionMap() {
    return Object.fromEntries(this.collections().filter(r => r.address).map(r => [r.id, r.address]));
  }

  collectionAdd(id, address, { pinned = false, autoRefresh = false } = {}) {
    const before = this.collectionGet(id);
    this.#q.collectionAdd.run(id, kindFor(address), address, Date.now(), pinned ? 1 : 0, autoRefresh ? 1 : 0);
    if (!before) this.#collectionCommitted(id, this.collectionGet(id));
  }

  collectionPatch(id, patch) {
    if (patch.pinned === undefined && patch.autoRefresh === undefined) return this.collectionGet(id);
    const before = this.collectionGet(id);
    this.#q.collectionPatch.run(
      patch.pinned === undefined ? null : Number(patch.pinned),
      patch.autoRefresh === undefined ? null : Number(patch.autoRefresh), id,
    );
    const row = this.collectionGet(id);
    if (row && (row.pinned !== before.pinned || row.auto_refresh !== before.auto_refresh)) this.#collectionCommitted(id, row);
    return row;
  }

  collectionRemove(id) {
    const before = this.collectionGet(id);
    this.#q.collectionRemove.run(id);
    if (before) this.#collectionCommitted(id, null);
  }

  // --- node registry (discovered node types → their scalar input fields) ----

  #mergeNodeRegistry(nodes) {
    if (!Array.isArray(nodes)) return;
    const get = this.#q.nodeRegGet;
    const put = this.#q.nodeRegPut;
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
    for (const row of this.#q.nodeRegAll.all()) {
      try { out[row.class_type] = { title: row.title ?? null, inputs: JSON.parse(row.inputs) }; } catch { /* corrupt row skipped */ }
    }
    return out;
  }

  // Entries can only exist under a real collection (FK). Writers call this
  // first: an unregistered collection gets an offline placeholder row, which
  // INSERT OR IGNORE preserves placeholders too; an add never rewrites them.
  #ensureCollection(id) {
    const before = this.collectionGet(id);
    this.#q.ensureCollection.run(id, Date.now());
    if (!before) this.#collectionCommitted(id, this.collectionGet(id));
  }

  // --- referenced-resource cache index (entry kind='input'/'temp') ---------
  // Non-output roots are byte-cache rows only: no inventory, extraction or
  // judgments. Output entries keep their own adapters below.

  resourceCacheGet(host, filename, kind) {
    if (kind === "output" || !isResourceRoot(kind)) throw new TypeError(`Not a referenced-resource root: ${kind}`);
    const row = this.#q.resourceCacheGet.value(host, filename, kind);
    return row ? { hash: row[0], stamp: row[1] } : null;
  }

  resourceCachePut(host, filename, kind, hash, stamp, size = null, dims = null) {
    if (kind === "output" || !isResourceRoot(kind)) throw new TypeError(`Not a referenced-resource root: ${kind}`);
    this.#ensureCollection(host);
    const now = Date.now();
    const changedDims = this.#ingestContent(hash, Number.isSafeInteger(size) ? size : null, dims, now);
    this.#q.resourceCachePut.run(host, filename, kind, hash, stamp, now, now);
    if (changedDims) this.#bumpMeta(host, filename, hash, { kind, meta: false, dims: false, aliasDims: true });
  }

  // Compatibility facades for the input root.
  inputCacheGet(host, filename) { return this.resourceCacheGet(host, filename, "input"); }
  inputCachePut(host, filename, hash, stamp) { return this.resourceCachePut(host, filename, "input", hash, stamp); }

  // --- hash identity (entry kind='output' adapters) -------------------------

  hashFor(host, filename) {
    const row = this.#q.hashFor.value(host, filename);
    return row ? row[0] : null;
  }

  // Hash + source-content stamp as recorded at ingestion (revalidation input).
  fileInfo(host, filename) {
    const row = this.#q.fileInfo.value(host, filename);
    return row ? { hash: row[0], stamp: row[1] } : null;
  }

  // Only byte-derived evidence enters content. All roots share the upsert;
  // absent evidence never erases facts already established for this hash.
  #ingestContent(hash, size, dims, now = Date.now()) {
    const before = this.contentGet(hash);
    this.#q.contentIngest.run(hash, size, dims?.width ?? null, dims?.height ?? null, now);
    return !!dims && (before?.width !== dims.width || before?.height !== dims.height);
  }

  // Ingest's exact-cache recovery fills an existing content record, notifying
  // output aliases only, even if the requesting resource is input/temp.
  contentDimsPut(hash, dims) {
    const content = this.contentGet(hash);
    if (!content || !dims) return;
    if (this.#ingestContent(hash, content.bytes, dims)) {
      this.#bumpMeta(null, null, hash, { meta: false, dims: false, aliasDims: true });
    }
  }

  // Called when bytes are ingested: the entry points at the (new) hash.
  // opts.stamp — the source-content stamp at ingestion (null when unknown).
  // opts.changed — this is a RE-ingest of a file whose content changed:
  // the OLD hash's meta belongs to the old bytes; it is dropped only when
  // no other entry still references it (shared content keeps its meta).
  async ingestFile(host, filename, hash, size, { stamp = null, changed = false, dims = null } = {}) {
    this.#ensureCollection(host);
    const now = Date.now();
    const old = this.#q.hashFor.value(host, filename)?.[0] ?? null;

    // the content row exists as soon as the bytes do (meta filled by metaPut;
    // inserted BEFORE the entry — entry.hash references content.hash). Dims
    // land when the bytes yield them; never wiped by a dimless re-ingest.
    const changedDims = this.#ingestContent(hash, size, dims, now);

    this.#q.entryOutputIngest.run(host, filename, hash, stamp, now, now);

    if (changed && old && old !== hash) {
      const refs = this.#q.contentRefs.value(old)[0];
      if (refs === 0) this.#q.contentDelete.run(old);
    }
    this.#bumpMeta(host, filename, hash, { aliasMeta: false,
      aliasDims: changedDims });
  }

  // Same content, newer source stamp (a touch, or a new ETag over identical
  // bytes): refresh the stamp only.
  touchFileStamp(host, filename, stamp) {
    this.#q.touchFileStamp.run(stamp, host, filename);
  }

  // --- hidden (delete fallback on hosts that can't delete) ----------------

  // Names hidden from every listing of one collection.
  hiddenNames(collection) {
    return new Set(
      this.#q.hiddenNames.all(collection).map((r) => r.name),
    );
  }

  // Hide one entry (the fallback delete on no-delete hosts).
  entryHide(collection, name) {
    this.#ensureCollection(collection);
    const now = Date.now();
    this.#q.entryInsertSeen.run(collection, name, now, now);
    this.#q.entryHide.run(now, collection, name);
    this.arrivals.changed(collection);
  }

  // The source lost the file: an entry state, never content state (C5).
  entryGone(host, filename) {
    this.#ensureCollection(host);
    const now = Date.now();
    this.#q.entryInsertSeen.run(host, filename, now, now);
    this.#q.entryGone.run(now, host, filename);
    this.arrivals.changed(host);
  }

  // --- content + entry records ------------------------------------------------

  contentGet(hash) {
    const row = this.#q.contentGet.get(hash) ?? null;
    if (!row) return null;
    let meta = null;
    try { meta = row.meta ? JSON.parse(row.meta) : null; } catch { /* corrupt meta */ }
    return { ...row, meta };
  }

  entryGet(collection, name, kind = "output") {
    return this.#q.entryGet.get(collection, name, kind) ?? null;
  }

  // One joined row (entry ⟕ content) for the wire shape — the listing and
  // the single-entry route both map it without further queries.
  entryJoined(collection, name) {
    return this.#q.entryJoined.get(collection, name) ?? null;
  }

  // Every joined row of one collection, kind-filtered (the feed listing's
  // single statement; hidden/gone rows are excluded by the route, which
  // must also drop backing-listed names that carry those states).
  entriesForCollection(collection, kind = "output") {
    return this.#q.entriesForCollection.all(collection, kind);
  }

  // --- metadata (sqlite-backed, re-derivable) ----------------------------

  // extraction state for one image: pending (not walked yet) vs done — done
  // splits into has-meta and none (content row with NULL meta ≈ old nopng)
  metaState(host, filename) {
    const row = this.#q.metaStateJoin.value(host, filename);
    if (row) {
      return { extracted: true, nopng: row[0] === null, meta: row[0] ? JSON.parse(row[0]) : null };
    }
    return { extracted: false, nopng: false, meta: null };
  }

  // Writes extractor output for an already-ingested file. The walk ingests
  // first (D2), so there is always a hash — meta is content state.
  async metaPut(host, filename, meta, { hasWorkflow = false, ext = 1 } = {}) {
    const hash = this.hashFor(host, filename);
    if (!hash) return;
    if (meta) this.#mergeNodeRegistry(meta.nodes);
    this.#q.metaPut.run(hash, meta ? JSON.stringify(meta) : null, hasWorkflow ? 1 : 0, ext, Date.now());
    this.#bumpMeta(host, filename, hash, { meta: true, dims: false });
  }

  metaForHost(host) {
    const out = {};
    for (const row of this.#q.metaForHost.all(host)) {
      try { out[row.name] = JSON.parse(row.meta); } catch { /* skip corrupt */ }
    }
    return out;
  }

  metaFresh(host, minExt) {
    const out = new Set();
    for (const row of this.#q.metaFresh.all(host, minExt)) {
      out.add(row.name);
    }
    return out;
  }

  // --- judgments (entry columns; sqlite is canonical) ---------------------

  #pruneJudgment({ vote, favorite, bookmark, notes, plugins }) {
    if (vote === "" || vote === undefined) vote = null;
    if (favorite === false || favorite === undefined) favorite = null;
    if (bookmark === false || bookmark === undefined) bookmark = null;
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
    return { vote: vote ?? null, favorite: favorite ?? null, bookmark: bookmark ?? null, notes, plugins };
  }

  #readJudgment(host, filename) {
    const row = this.#q.judgmentRead.get(host, filename);
    if (!row) return null;
    const j = {};
    if (row.vote != null) j.vote = row.vote;
    if (row.favorite != null) j.favorite = !!row.favorite;
    if (row.bookmark != null) j.bookmark = !!row.bookmark;
    if (row.notes != null) { try { j.notes = JSON.parse(row.notes); } catch { /* corrupt */ } }
    if (row.plugin_fields != null) { try { j.plugins = JSON.parse(row.plugin_fields); } catch { /* corrupt */ } }
    return Object.keys(j).length ? j : null;
  }

  judgmentGet(host, filename) {
    return this.#readJudgment(host, filename);
  }

  // Whitelisted, deep-pruned, ONE statement. Fields: vote | favorite | bookmark | notes
  // | plugins.<ns>.<field>; null/"" values prune (defaults store as absent).
  judgmentPatch(host, filename, patch) {
    const cur = this.#readJudgment(host, filename) ?? {};
    const next = {
      vote: cur.vote ?? null,
      favorite: cur.favorite ? 1 : null,
      bookmark: cur.bookmark ? 1 : null,
      notes: cur.notes ?? null,
      plugins: cur.plugins ? Object.assign(Object.create(null), cur.plugins) : null,
    };
    for (const [field, value] of Object.entries(patch ?? {})) {
      if (CORE_JUDGMENT_FIELDS.has(field)) {
        next[field] = field === "favorite" || field === "bookmark" ? (value ? 1 : null) : value;
        continue;
      }
      if (field.startsWith("plugins.")) {
        const parts = field.split(".");
        const ns = parts[1];
        const pname = parts.slice(2).join(".");
        if (!ns || !pname) return { ok: false, error: `bad judgment field: ${field}` };
        next.plugins ??= Object.create(null);
        const fields = Object.hasOwn(next.plugins, ns) ? next.plugins[ns] : null;
        next.plugins[ns] = Object.assign(Object.create(null), fields && typeof fields === "object" ? fields : {});
        next.plugins[ns][pname] = value;
        continue;
      }
      return { ok: false, error: `unknown judgment field: ${field}` };
    }
    const pruned = this.#pruneJudgment(next);
    this.#ensureCollection(host);
    const now = Date.now();
    this.#q.entryInsertSeen
      .run(host, filename, now, now);
    this.#q.judgmentUpdate.run(
      pruned.vote, pruned.favorite, pruned.bookmark,
      pruned.notes == null ? null : JSON.stringify(pruned.notes),
      pruned.plugins == null ? null : JSON.stringify(pruned.plugins),
      now, host, filename,
    );
    return { ok: true, judgment: this.#readJudgment(host, filename) };
  }

  async judgmentSet(host, filename, field, value) {
    return this.judgmentPatch(host, filename, { [field]: value });
  }

  // Everywhere this content lives: [{ collection, name }] (the "what did I
  // think elsewhere" query).
  instancesOf(hash) {
    return this.#q.instancesOf.all(hash);
  }

  // Names the source no longer has: confirmed gone, never rendered.
  goneNames(collection) {
    return new Set(this.#q.goneNames.all(collection).map((r) => r.name));
  }

  // --- entry dims : dims are known before the hash is) ----------------

  // { width, height } from content once hashed, otherwise provisional entry
  // columns. A hashed-but-dimless entry is unknown. Keyed by resource root;
  // the default remains the output entry.
  entryDims(collection, name, kind = "output") {
    if (!isResourceRoot(kind)) throw new TypeError(`unknown resource root: ${kind}`);
    const row = this.#q.entryDims.get(collection, name, kind);
    if (!row || row.width == null || row.height == null) return null;
    return { width: row.width, height: row.height };
  }

  // Store dims a head read yielded. Creates the 'seen' row of that root when
  // the name has none yet; never wipes known dims with nulls. Output dims bump
  // the meta version so /meta polls deliver them; input/temp rows are
  // referenced resources, never output inventory or meta publications.
  entryDimsPut(collection, name, dims, kind = "output") {
    if (!isResourceRoot(kind)) throw new TypeError(`unknown resource root: ${kind}`);
    if (this.entryGet(collection, name, kind)?.hash) return;
    this.#ensureCollection(collection);
    const now = Date.now();
    this.#q.entryDimsPut.run(collection, name, kind, dims?.width ?? null, dims?.height ?? null, now, now);
    if (kind === "output") this.#bumpMeta(collection, name, null, { meta: false, dims: true });
  }

  // Names whose dims are known (either source) — the dims-pass queue gate.
  dimsKnown(collection) {
    return new Set(this.#q.dimsKnown.all(collection).map((r) => r.name));
  }

  // name -> { width, height } for every dimmed entry (the /meta poll payload).
  dimsForHost(collection) {
    const out = {};
    for (const r of this.#q.dimsForHost.all(collection)) {
      out[r.name] = { width: r.width, height: r.height };
    }
    return out;
  }

  // The portable judgment document, generated on demand per collection.
  feedbackExport(collection) {
    if (!this.collectionGet(collection)) return null;
    const entries = {};
    for (const row of this.#q.feedbackExport.all(collection)) {
      const e = {};
      if (row.hash != null) e.hash = row.hash;
      if (row.vote != null) e.vote = row.vote;
      if (row.favorite != null) e.favorite = !!row.favorite;
      if (row.bookmark != null) e.bookmark = !!row.bookmark;
      if (row.notes != null) { try { e.notes = JSON.parse(row.notes); } catch { /* corrupt */ } }
      if (row.plugin_fields != null) { try { e.plugins = JSON.parse(row.plugin_fields); } catch { /* corrupt */ } }
      entries[row.name] = e;
    }
    return { version: 2, collection, generated_at: new Date().toISOString(), entries };
  }

  close() {
    this.#collectionListeners.clear();
    this.#db.close();
  }
}
