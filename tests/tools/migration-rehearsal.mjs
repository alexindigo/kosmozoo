// tests/tools/migration-rehearsal.mjs — the v6→v7 migration rehearsal: open
// a COPY of a real state dir with Store.open and print what the migration
// did, as numbers. This is the gate before any cutover — run it on a copy,
// never on the live state:
//
//   deno run --allow-all tests/tools/migration-rehearsal.mjs <state-dir-copy>
//
// Prints: user_version, table list, counts (collection, entry by state,
// content), the fold.feedback.v2.stats block, entries with
// plugin_fields = '{}' (expect 0), collections with address IS NULL (expect
// 0 or the named list), PRAGMA foreign_key_check (expect empty), and the
// .v1-backup-* presence next to the v1 feedback document.

import { Store } from "../../src/store.mjs";
import { Settings } from "../../src/settings.mjs";
import { Database } from "@db/sqlite";
import { join } from "node:path";

const dir = Deno.args[0];
if (!dir) {
  console.error("usage: migration-rehearsal.mjs <state-dir-copy>");
  Deno.exit(2);
}

const settings = await Settings.open(dir);
const feedbackPath = join(dir, "feedback.json");
const store = await Store.open(dir, { settings, feedbackPath });
store.close();

const db = new Database(join(dir, "metadata.db"));
const q = (sql, ...args) => db.prepare(sql).all(...args);
const v = (sql, ...args) => db.prepare(sql).value(...args)?.[0];

const [userVersion] = db.prepare("PRAGMA user_version").value();
const tables = q("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name);
const collections = q("SELECT id, kind, address FROM collection ORDER BY id");
const entryByState = q("SELECT state, COUNT(*) AS n FROM entry GROUP BY state ORDER BY state");
const content = v("SELECT COUNT(*) FROM content");
const statsRaw = v("SELECT v FROM kv WHERE k = 'fold.feedback.v2.stats'");
const emptyPluginFields = v("SELECT COUNT(*) FROM entry WHERE plugin_fields = '{}'");
const nullAddress = q("SELECT id, kind FROM collection WHERE address IS NULL ORDER BY id");
const fkCheck = q("PRAGMA foreign_key_check");

const backups = [];
for await (const f of Deno.readDir(dir)) {
  if (f.name.includes(".v1-backup-")) backups.push(f.name);
}

console.log(JSON.stringify({
  user_version: userVersion,
  tables,
  counts: {
    collection: collections.length,
    entry_by_state: Object.fromEntries(entryByState.map((r) => [r.state, r.n])),
    content,
  },
  "fold.feedback.v2.stats": statsRaw ? JSON.parse(statsRaw) : null,
  "plugin_fields = '{}'": emptyPluginFields,
  "collections with address IS NULL": nullAddress.map((r) => r.id),
  foreign_key_check: fkCheck,
  v1_backups: backups,
}, null, 2));

db.close();
