// src/backings/folder.mjs — the folder backing: a local directory as a
// collection whose "API" is the filesystem. Flat folder: basename only.

import { readdir, readFile, open as fsOpen, stat as fsStat, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { RENDERABLE, EXT_MIME } from "./mime.mjs";
import { makeInventoryOwner } from "./inventory-owner.mjs";
import { InventoryError, bounded, cancelled } from "./inventory.mjs";

export const FOLDER_RE = /^folder:(.+)$/;

export function folderPath(addr) {
  return FOLDER_RE.exec(addr ?? "")?.[1] ?? null;
}

export function assertSafeName(name) {
  return basename(name) === name && !name.includes("..");
}

export async function probe(addr) {
  try {
    const s = await fsStat(folderPath(addr));
    return s.isDirectory();
  } catch {
    return false;
  }
}

// kind 'output' → [{ name, size }] newest-first; kind 'input' → [name].
export async function list(addr, kind = "output") {
  const items = (await inventory(addr)).items;
  return kind === "input" ? items.map((item) => item.name) : items;
}

export function createBinding(addr, { clock, epoch, waveTimeoutMs, readerTimeoutMs, statter = fsStat, enumerator = readdir } = {}) {
  let owner;
  const names = async (signal) => {
    if (signal.aborted) throw signal.reason ?? cancelled();
    const raw = await enumerator(folderPath(addr));
    if (signal.aborted) throw signal.reason ?? cancelled();
    return raw.filter((name) => !name.startsWith(".") && assertSafeName(name) && RENDERABLE.has(name.split(".").pop().toLowerCase()));
  };
  const observe = (name, { signal = owner.signal } = {}) => {
    if (!assertSafeName(name)) return Promise.reject(new InventoryError("invalid-name", "Bad flat filename"));
    const combined = AbortSignal.any([owner.signal, signal]);
    return bounded(async () => {
      try {
        const value = await statter(join(folderPath(addr), name));
        if (combined.aborted) throw combined.reason ?? cancelled();
        if (!value.isFile()) return { kind: "not-file", name, status: 404 };
        return { kind: "present", name, status: 200, size: value.size, stamp: String(value.mtimeMs),
          modified: { atMs: value.mtimeMs, precisionMs: null, source: "filesystem-stat" } };
      } catch (error) {
        if (error.code === "ENOENT") return { kind: "not-found", name, status: 404, reason: "source-not-found" };
        throw error;
      }
    }, { signal: combined, timeoutMs: 10_000 });
  };
  const collect = async ({ signal }) => {
    let current = await names(signal);
    const discovered = new Set(current), observed = new Map();
    for (const name of current) observed.set(name, await observe(name, { signal }));
    const missing = current.filter((name) => observed.get(name).kind === "not-found");
    if (missing.length) {
      current = await names(signal);
      for (const name of current) {
        discovered.add(name);
        if (!observed.has(name) || observed.get(name).kind === "not-found") observed.set(name, await observe(name, { signal }));
      }
    }
    const records = [], unavailable = [];
    for (const name of discovered) {
      const result = observed.get(name);
      if (result?.kind === "not-file") { discovered.delete(name); continue; }
      if (current.includes(name) && result?.kind === "present") records.push({ name, size: result.size, modified: result.modified });
      else if (result?.kind === "not-found") unavailable.push({ name, status: 404, reason: "confirmed-source-not-found" });
    }
    return { records, discovered: [...discovered], unavailable, flat: true, coverage: "root-only",
      subfolders: { supported: false, reason: "Local folder sources are flat; output root only" } };
  };
  owner = makeInventoryOwner({ collect, clock, epoch, waveTimeoutMs, readerTimeoutMs });
  return { addr, ...owner, observeMetadata: observe,
    hasAssetsPlus: async () => false,
    objectInfo: async () => ({ types: null, enums: null, outputClasses: null }),
    enqueue: async () => ({ ok: false, status: 400, error: "Local folder sources cannot generate images" }) };
}

export async function inventory(addr, { binding, ...options } = {}) {
  if (binding) return binding(addr).inventory(options);
  const owner = createBinding(addr);
  try { return await owner.inventory(options); }
  finally { await owner.disposeInventory(); }
}

// { stamp: mtime stringified, size } — the folder's whole revalidation seam.
export async function stat(addr, name) {
  if (!assertSafeName(name)) return null;
  try {
    const s = await fsStat(join(folderPath(addr), name));
    return s.isFile() ? { stamp: String(s.mtimeMs), size: s.size } : null;
  } catch {
    return null;
  }
}

// Read bytes. `range: [start, end]` (inclusive) reads just that head slice —
// the dims pass never touches the rest of the file .
export async function read(addr, name, _kind = "output", { range } = {}) {
  if (!assertSafeName(name)) return { status: 400 };
  const full = join(folderPath(addr), name);
  const mime = EXT_MIME[name.split(".").pop().toLowerCase()];
  if (range) {
    try {
      const fh = await fsOpen(full, "r");
      try {
        const len = range[1] - range[0] + 1;
        const buf = new Uint8Array(len);
        const { bytesRead } = await fh.read(buf, 0, len, range[0]);
        const headers = new Headers();
        if (mime) headers.set("Content-Type", mime);
        headers.set("Content-Length", String(bytesRead));
        return { status: 206, body: buf.subarray(0, bytesRead), headers };
      } finally {
        await fh.close();
      }
    } catch {
      return { status: 404 };
    }
  }
  try {
    const bytes = await readFile(full);
    const headers = new Headers();
    if (mime) headers.set("Content-Type", mime);
    headers.set("Content-Length", String(bytes.length));
    return { status: 200, body: bytes, headers };
  } catch {
    return { status: 404 };
  }
}

export async function remove(addr, name) {
  if (!assertSafeName(name)) return { ok: false, mode: null, detail: "bad filename" };
  try {
    await unlink(join(folderPath(addr), name));
    return { ok: true, mode: "unlink" };
  } catch (e) {
    return { ok: false, mode: "unlink", detail: e?.code === "ENOENT" ? "already gone" : String(e?.message ?? e) };
  }
}
