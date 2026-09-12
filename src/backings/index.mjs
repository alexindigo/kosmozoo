// src/backings/index.mjs — the backing registry: an address grammar → the
// driver that owns it. Two backings exist: comfy (host:port over HTTP) and
// folder (folder:/abs/path on disk). A backing knows its kind's I/O —
// { probe, list(kind), stat(name,kind), read(name,kind), write?, remove? } —
// so nothing outside drivers/ branches on the address grammar.

import * as comfy from "./comfy.mjs";
import * as folder from "./folder.mjs";

export const FOLDER_RE = folder.FOLDER_RE;

export function isFolderHost(addr) {
  return FOLDER_RE.test(addr ?? "");
}

export function backingFor(addr) {
  return isFolderHost(addr) ? folder : comfy;
}

export { assertSafeName } from "./folder.mjs";
export { RENDERABLE, EXT_MIME } from "./mime.mjs";
