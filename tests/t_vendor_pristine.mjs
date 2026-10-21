// tests/t_vendor_pristine.mjs — the vendored third-party runtime is
// pristine upstream. `deno task vendor` regenerates the files AND
// client/vendor/CHECKSUMS together; a hand edit to any vendored file
// fails here instead of silently re-entering the fork.

import { assert, assertEquals } from "jsr:@std/assert";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const ROOT = new URL("../", import.meta.url);

async function vendorFiles(directory = "client/vendor") {
  const files = [];
  for await (const entry of Deno.readDir(new URL(`${directory}/`, ROOT))) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory) files.push(...await vendorFiles(path));
    else {
      assert(entry.isFile, `unexpected vendor entry: ${path}`);
      if (path !== "client/vendor/CHECKSUMS") files.push(path);
    }
  }
  return files.sort();
}

Deno.test("vendored files match client/vendor/CHECKSUMS", async () => {
  const lines = (await readFile(new URL("client/vendor/CHECKSUMS", ROOT), "utf-8"))
    .trim()
    .split("\n")
    .map((l) => l.split(/\s+/));
  const seen = new Set();
  for (const [sum, file] of lines) {
    assert(/^[a-f0-9]{64}$/.test(sum), `invalid CHECKSUMS digest: ${sum}`);
    assert(/^client\/vendor\/(?:[\w-]+\/)*[\w.-]+$/.test(file), `invalid CHECKSUMS path: ${file}`);
    assert(!seen.has(file), `duplicate CHECKSUMS entry: ${file}`);
    seen.add(file);
  }
  assertEquals(
    await vendorFiles(),
    [...seen].sort(),
    "client/vendor file set differs from CHECKSUMS (extra or missing files)",
  );
  for (const [sum, file] of lines) {
    const bytes = await readFile(new URL(file, ROOT));
    const actual = createHash("sha256").update(bytes).digest("hex");
    assertEquals(
      actual,
      sum,
      `${file} differs from its vendored pristine copy — ` +
        `revert it or re-run deno task vendor deliberately`,
    );
  }
});
