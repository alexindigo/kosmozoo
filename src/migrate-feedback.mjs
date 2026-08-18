// src/migrate-feedback.mjs — migrate the outgoing feedback.json (61+ flat
// entries: {pos?, neg?, vote?}) into the new versioned judgment schema.
//
// Mechanically trivial today because every entry has bucket/tag absent —
// and it gets harder the moment buckets are used in anger, so do it now.
//
//   deno run --allow-all src/migrate-feedback.mjs <old-feedback.json> [out.json]
// Default out: same path with .migrated.json suffix. The input is never
// modified; the output is the new-format document for review.

import { readFile } from "node:fs/promises";
import { atomicWrite } from "./state.mjs";

export function migrateEntry(old) {
  // old: { pos?, neg?, vote? } — fields set to their default are absent.
  const out = {};
  if (old.pos || old.neg) {
    out.notes = {};
    if (old.pos) out.notes.pos = old.pos;
    if (old.neg) out.notes.neg = old.neg;
  }
  if (old.vote) out.vote = old.vote;
  if (old.favorite) out.favorite = old.favorite;
  return out;
}

export function migrate(oldDoc) {
  // oldDoc: { "host:filename": {pos,neg,vote} } (flat, unversioned)
  const data = {};
  let count = 0;
  for (const [key, entry] of Object.entries(oldDoc)) {
    const m = migrateEntry(entry);
    if (Object.keys(m).length) { data[key] = m; count++; }
  }
  return { version: 1, data };
}

if (import.meta.main) {
  const [inPath, outPath] = Deno.args;
  if (!inPath) {
    console.error("usage: migrate-feedback.mjs <old-feedback.json> [out.json]");
    Deno.exit(2);
  }
  const old = JSON.parse(await readFile(inPath, "utf-8"));
  const doc = migrate(old);
  const out = outPath ?? inPath.replace(/\.json$/, "") + ".migrated.json";
  await atomicWrite(out, new TextEncoder().encode(JSON.stringify(doc, null, 2)));
  console.log(`migrated ${Object.keys(doc.data).length} entries -> ${out}`);
}
