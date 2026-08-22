// src/import-legacy.mjs — one-shot tool: merge the frozen Python metadata.db
// into the current kosmozoo sqlite store.
//
// Usage:  deno task import-legacy [path-to-python-metadata.db]
//
// Opens the Python DB read-only.  For each row not already present, the
// metadata is imported.  No hashing (we don't have the bytes); rows land in
// the metadata table with a matching files entry (hash = null).
//
// The Python DB at ~/Projects/kosmozoo/metadata.db is the frozen baseline
// (tag python-final).  3,740 rows expected; the script reports counts.

import { join } from "node:path";
import { Database } from "@db/sqlite";
import { resolveStateDir, ensureStateDir } from "./state.mjs";
import { Store } from "./store.mjs";

async function main() {
  const srcPath = Deno.args[0]
    ?? join(Deno.env.get("HOME"), "Projects", "kosmozoo", "metadata.db");

  const stateDir = await ensureStateDir(resolveStateDir());
  const targetPath = join(stateDir, "metadata.db");

  // Open the Python DB read-only.
  let pyDb;
  try {
    pyDb = new Database(srcPath, { readonly: true });
  } catch (e) {
    console.error(`Cannot open ${srcPath}: ${e.message}`);
    Deno.exit(1);
  }

  const srcCount = pyDb.prepare("SELECT COUNT(*) FROM images").value()[0];
  console.log(`Python DB: ${srcCount} rows in ${srcPath}`);

  // Ensure the target schema exists by opening the Store (runs migrations).
  const store = await Store.open(stateDir, join(stateDir, "temp-fb.json"));

  // Now connect directly for the bulk import.
  const db = new Database(targetPath);

  const existing = db.prepare("SELECT COUNT(*) FROM metadata").value()[0];
  console.log(`Target DB: ${existing} rows before import`);

  const insMeta = db.prepare(
    `INSERT OR IGNORE INTO metadata (host, filename, meta, source, has_workflow, nopng, ext, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insFile = db.prepare(
    "INSERT OR IGNORE INTO files (host, filename) VALUES (?, ?)"
  );

  const srcRows = pyDb.prepare(
    "SELECT host, filename, meta, source, has_workflow, nopng, ext, updated_at FROM images"
  ).all();

  let imported = 0;
  let skipped = 0;

  const txn = db.transaction((rows) => {
    for (const r of rows) {
      // Skip if already present — no overwrite.
      const got = db.prepare(
        "SELECT 1 FROM metadata WHERE host = ? AND filename = ?"
      ).value(r.host, r.filename);
      if (got) { skipped++; continue; }

      insMeta.run(
        r.host, r.filename,
        r.meta,
        r.source ?? "png",
        r.has_workflow ?? 0,
        r.nopng ?? 0,
        r.ext ?? 0,
        r.updated_at ?? Date.now()
      );
      insFile.run(r.host, r.filename);
      imported++;
    }
  });

  txn(srcRows);

  const after = db.prepare("SELECT COUNT(*) FROM metadata").value()[0];
  console.log(`Imported: ${imported}, skipped (already present): ${skipped}`);
  console.log(`Target DB: ${after} rows after import`);

  const [ver] = db.prepare("PRAGMA user_version").value();
  console.log(`Schema user_version: ${ver}`);

  db.close();
  store.close();
  pyDb.close();
}

main().catch((e) => {
  console.error(e);
  Deno.exit(1);
});
