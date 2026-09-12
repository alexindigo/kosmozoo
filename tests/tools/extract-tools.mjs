// tests/tools/extract-tools.mjs — A/B-rig extractor helpers (extractDir,
// historyOutputMetas). Not shipped in src/extractor.mjs — tests and manual
// harvest scripts import from here.

import { extractMeta, metaFromPngBytes } from "../../src/extractor.mjs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export async function extractDir(dir) {
  const out = {};
  for (const name of (await readdir(dir)).sort()) {
    if (!name.endsWith(".png")) continue;
    const [meta] = await metaFromPngBytes(new Uint8Array(await readFile(join(dir, name))));
    out[name] = meta ?? { nopng: true };
  }
  return out;
}

// filename -> meta for every output image in a /api/history response.
export function historyOutputMetas(history) {
  const out = {};
  for (const entry of Object.values(history ?? {})) {
    const meta = extractMeta(entry);
    if (!meta) continue;
    for (const output of Object.values(entry.outputs ?? {})) {
      for (const img of output.images ?? []) {
        if (img.type === "output" && img.filename) out[img.filename] = meta;
      }
    }
  }
  return out;
}
