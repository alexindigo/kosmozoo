// src/state.mjs — state directory resolution and versioned JSON documents.
//
// State lives in the XDG state dir by default ($XDG_STATE_HOME/kosmozoo or
// ~/.local/state/kosmozoo); KOZMOZOO_STATE overrides (dev/e2e). Documents
// are versioned JSON; migrations run at load; a rename or shape change
// carries a migration — never silent loss (and corrupt bytes are quarantined,
// never overwritten).

import { dirname, join } from "node:path";
import { mkdir, rename, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { writeSerialized } from "./writer.mjs";

export function resolveStateDir(env = Deno.env.toObject()) {
  if (env.KOZMOZOO_STATE) return env.KOZMOZOO_STATE;
  return join(
    env.XDG_STATE_HOME ?? join(env.HOME ?? tmpdir(), ".local", "state"),
    "kosmozoo",
  );
}

// Create the state dir and prove it writable; an unwritable state dir is a
// boot error, never a silent fallback to somewhere else.
export async function ensureStateDir(dir) {
  await mkdir(dir, { recursive: true });
  const probe = join(dir, ".write-probe");
  await writeFile(probe, "");
  await Deno.remove(probe);
  return dir;
}

// Atomic write: tmp file in the same directory, then rename over the target.
export async function atomicWrite(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(path + ".tmp." + crypto.randomUUID());
  await writeFile(tmp, bytes);
  await rename(tmp, path);
}

// A state file that exists but does not parse is NEVER overwritten: it is
// renamed aside (quarantine) and boot stops with remediation. `path` is the
// original location, `quarantined` where the bytes were preserved.
export class CorruptStateError extends Error {
  constructor(path, quarantined, cause) {
    super(`${path}: corrupt JSON — bytes preserved at ${quarantined}`, { cause });
    this.name = "CorruptStateError";
    this.path = path;
    this.quarantined = quarantined;
  }
}

// A versioned JSON document. shape: { version: N, data: ... }.
// migrations: { [fromVersion]: (data) => data } applied in order.
export async function loadVersioned(path, { current, migrations = {}, empty }) {
  let doc;
  try {
    doc = JSON.parse(await readFile(path, "utf-8"));
  } catch (e) {
    if (e instanceof SyntaxError) {
      const quarantined = `${path}.corrupt-${new Date().toISOString()}`;
      await rename(path, quarantined);
      throw new CorruptStateError(path, quarantined, e);
    }
    if (e.code === "ENOENT") {
      doc = { version: current, data: empty() };
      await writeSerialized(path, new TextEncoder().encode(JSON.stringify(doc, null, 2)));
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
