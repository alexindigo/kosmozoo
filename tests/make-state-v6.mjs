// tests/make-state-v6.mjs — generate tests/fixtures/state-v6/: a real-shape
// schema-v6 metadata.db + settings.json + v1 feedback.json, the input for
// tests/t_migration_v7.mjs. Run in docker (sqlite FFI):
//   docker run --rm -v "$PWD":/work -w /work denoland/deno:latest run --allow-all tests/make-state-v6.mjs
// The artifacts are committed; re-run only when the v6 shape itself changes.
//
// Fixture story (every fold rule has a row):
//   hosts: a = comfy 1.2.3.4:8188, b = folder:/var/images
//   H1 shared by a:shared.png + b:shared.png (two entries, one content row);
//   images(H1) wins over the older duplicate metadata(H1)
//   a:only-a.png  H2 images row only
//   a:legacy.png  H4 via files.hash + metadata row only (no images row)
//   b:meta-only.png H3 metadata row only, ext=2 (stale — kept as-is)
//   a:unhashed.png files row, hash NULL (+ a metadata row — DISCARDED)
//   a:nopng.png   H9 images row nopng=1 (DROPPED — a fresh scrape decides)
//   a:ghost.png   only on the hidden list (entry created hidden=1)
//   input_cache rows -> kind='input' entries
//   feedback: H1 hash key + one legacy a:old-key.png key + one orphan key

import { Database } from "@db/sqlite";
import { mkdir, writeFile } from "node:fs/promises";

const OUT = new URL("./fixtures/state-v6/", import.meta.url).pathname;
await mkdir(OUT, { recursive: true });

const H1 = "aa".repeat(32), H2 = "bb".repeat(32), H3 = "cc".repeat(32);
const H4 = "dd".repeat(32), H5 = "ee".repeat(32), H6 = "ff".repeat(32);
const H9 = "99".repeat(32);

const db = new Database(`${OUT}/metadata.db`);
db.exec(`
  CREATE TABLE metadata (
    host TEXT NOT NULL, filename TEXT NOT NULL,
    meta TEXT, source TEXT,
    has_workflow INTEGER NOT NULL DEFAULT 0,
    nopng INTEGER NOT NULL DEFAULT 0,
    ext INTEGER NOT NULL DEFAULT 0,
    updated_at REAL NOT NULL,
    PRIMARY KEY (host, filename)
  );
  CREATE TABLE files (
    host TEXT NOT NULL, filename TEXT NOT NULL,
    hash TEXT, size INTEGER, mtime REAL, stamp TEXT,
    PRIMARY KEY (host, filename)
  );
  CREATE INDEX files_by_hash ON files(hash);
  CREATE TABLE images (
    hash TEXT PRIMARY KEY,
    meta TEXT, source TEXT,
    has_workflow INTEGER NOT NULL DEFAULT 0,
    nopng INTEGER NOT NULL DEFAULT 0,
    ext INTEGER NOT NULL DEFAULT 0,
    updated_at REAL NOT NULL
  );
  CREATE TABLE node_registry (
    class_type TEXT PRIMARY KEY,
    title TEXT, inputs TEXT NOT NULL, updated_at REAL NOT NULL
  );
  CREATE TABLE input_cache (
    host TEXT NOT NULL, filename TEXT NOT NULL,
    hash TEXT NOT NULL, stamp TEXT,
    PRIMARY KEY (host, filename)
  );
  PRAGMA user_version = 6;
`);

const now = Date.now();
const insFile = db.prepare("INSERT INTO files (host, filename, hash, size, mtime, stamp) VALUES (?,?,?,?,?,?)");
insFile.run("a", "shared.png", H1, 100, now - 5000, "st-a-shared");
insFile.run("a", "only-a.png", H2, 50, now - 4000, "st-a-only");
insFile.run("a", "legacy.png", H4, 60, now - 3000, "st-a-legacy");
insFile.run("a", "unhashed.png", null, null, null, null);
insFile.run("a", "nopng.png", H9, 70, now - 2000, "st-a-nopng");
insFile.run("b", "shared.png", H1, 100, now - 4500, "st-b-shared");
insFile.run("b", "meta-only.png", H3, 80, now - 3500, "st-b-meta");

const insImg = db.prepare("INSERT INTO images (hash, meta, source, has_workflow, nopng, ext, updated_at) VALUES (?,?,?,?,?,?,?)");
insImg.run(H1, JSON.stringify({ seed: 1, steps: 20 }), "png", 1, 0, 4, now - 1000);
insImg.run(H2, JSON.stringify({ seed: 2 }), "png", 0, 0, 4, now - 900);
insImg.run(H9, null, "png", 0, 1, 4, now - 800); // nopng — dropped by the fold

const insMeta = db.prepare("INSERT INTO metadata (host, filename, meta, source, has_workflow, nopng, ext, updated_at) VALUES (?,?,?,?,?,?,?,?)");
insMeta.run("a", "shared.png", JSON.stringify({ seed: 99 }), "history", 0, 0, 2, now - 9000); // older dup — must lose to images
insMeta.run("a", "legacy.png", JSON.stringify({ seed: 4 }), "history", 0, 0, 3, now - 8000); // -> content via files.hash
insMeta.run("b", "meta-only.png", JSON.stringify({ seed: 3 }), "history", 0, 0, 2, now - 7000); // stale ext, kept
insMeta.run("a", "unhashed.png", JSON.stringify({ seed: 7 }), "history", 0, 0, 3, now - 6000); // no hash — DISCARDED

db.prepare("INSERT INTO node_registry (class_type, title, inputs, updated_at) VALUES (?,?,?,?)")
  .run("KSampler", null, JSON.stringify({ seed: "number", steps: "number" }), now);

const insIn = db.prepare("INSERT INTO input_cache (host, filename, hash, stamp) VALUES (?,?,?,?)");
insIn.run("a", "in.png", H5, "st-in-a");
insIn.run("b", "deep.png", H6, "st-in-b");

db.close();

await writeFile(`${OUT}/settings.json`, JSON.stringify({
  version: 1,
  data: {
    "core.hosts": { map: { a: "1.2.3.4:8188", b: "folder:/var/images" } },
    "core.delete": { useAssetsPlus: true, hidden: { a: ["ghost.png", "shared.png"] } },
  },
}, null, 2));

await writeFile(`${OUT}/feedback.json`, JSON.stringify({
  version: 1,
  data: {
    [H1]: { vote: "up", ref: "a:shared.png" },
    "a:old-key.png": { vote: "down", notes: { pos: "keep" } },
    "orphan:gone.png": { favorite: true },
  },
}, null, 2));

console.log(`state-v6 fixture written to ${OUT}`);
console.log({ H1, H2, H3, H4, H5, H6 });
