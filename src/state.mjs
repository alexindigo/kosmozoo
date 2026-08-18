// src/state.mjs — state directory resolution and versioned JSON documents.
//
// Pattern kept from the outgoing implementation: env override → app dir →
// XDG fallback when the app dir is read-only. Engine state is stored as
// versioned JSON documents (no third-party storage dependency; the same
// discipline feedback.json already proved). Migrations run at load; a rename
// or shape change carries a migration — never silent loss.

import { dirname, join } from "node:path";
import { mkdir, rename, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";

const BASE_DIR = new URL("..", import.meta.url).pathname;

export function resolveStateDir(env = Deno.env.toObject()) {
  if (env.KOZMOZOO_STATE) return env.KOZMOZOO_STATE;
  // If the app dir is writable (dev checkout), use it; else XDG state.
  // The writability check is done by attempting to create a probe file.
  return BASE_DIR; // caller falls back to XDG on EACCES
}

export async function ensureStateDir(preferred) {
  const xdg = join(
    Deno.env.get("XDG_STATE_HOME") ?? join(Deno.env.get("HOME") ?? tmpdir(), ".local", "state"),
    "kosmozoo",
  );
  try {
    await mkdir(preferred, { recursive: true });
    // probe writability
    const probe = join(preferred, ".write-probe");
    await writeFile(probe, "");
    await Deno.remove(probe);
    return preferred;
  } catch {
    await mkdir(xdg, { recursive: true });
    return xdg;
  }
}

// Atomic write: tmp file in the same directory, then rename over the target.
export async function atomicWrite(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(path + ".tmp." + crypto.randomUUID());
  await writeFile(tmp, bytes);
  await rename(tmp, path);
}

// A versioned JSON document. shape: { version: N, data: ... }.
// migrations: { [fromVersion]: (data) => data } applied in order.
export async function loadVersioned(path, { current, migrations = {}, empty }) {
  let doc;
  try {
    doc = JSON.parse(await readFile(path, "utf-8"));
  } catch (e) {
    if (e.code === "ENOENT" || e instanceof SyntaxError) {
      doc = { version: current, data: empty() };
      await atomicWrite(path, new TextEncoder().encode(JSON.stringify(doc, null, 2)));
      return doc;
    }
    throw e;
  }
  let v = doc.version ?? 0;
  while (v < current) {
    const mig = migrations[v];
    if (!mig) throw new Error(`${path}: no migration from version ${v}`);
    doc.data = mig(doc.data);
    v++;
    doc.version = v;
  }
  if (v !== current) throw new Error(`${path}: version ${doc.version} newer than supported ${current}`);
  return doc;
}
