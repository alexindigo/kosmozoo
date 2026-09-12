// src/backings/folder.mjs — the folder backing: a local directory as a
// collection whose "API" is the filesystem. Flat folder: basename only.

import { readdir, readFile, stat as fsStat, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { RENDERABLE, EXT_MIME } from "./mime.mjs";

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
  const dir = folderPath(addr);
  const names = await readdir(dir);
  const files = [];
  for (const n of names) {
    if (n.startsWith(".")) continue;
    const ext = n.split(".").pop().toLowerCase();
    if (!RENDERABLE.has(ext) || !assertSafeName(n)) continue;
    try {
      const s = await fsStat(join(dir, n));
      if (s.isFile()) files.push({ n, mtime: s.mtimeMs, size: s.size });
    } catch { /* vanished */ }
  }
  files.sort((a, b) => b.mtime - a.mtime || a.n.localeCompare(b.n));
  return kind === "input" ? files.map((f) => f.n) : files.map((f) => ({ name: f.n, size: f.size }));
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

export async function read(addr, name, _kind = "output") {
  if (!assertSafeName(name)) return { status: 400 };
  try {
    const bytes = await readFile(join(folderPath(addr), name));
    const headers = new Headers();
    const mime = EXT_MIME[name.split(".").pop().toLowerCase()];
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
