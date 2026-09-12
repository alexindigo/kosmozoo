// tests/t_vendor_pristine.mjs — the vendored third-party runtime is
// pristine upstream. fetch-vendor-solid.sh regenerates the files AND
// client/vendor/CHECKSUMS together; a hand edit to any vendored file
// fails here instead of silently re-entering the fork.

import { assert, assertEquals } from "jsr:@std/assert";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const ROOT = new URL("../", import.meta.url);

Deno.test("vendored files match client/vendor/CHECKSUMS", async () => {
  const lines = (await readFile(new URL("client/vendor/CHECKSUMS", ROOT), "utf-8"))
    .trim()
    .split("\n")
    .map((l) => l.split(/\s+/));
  assert(lines.length >= 7, "CHECKSUMS should cover every script-fetched file");
  const seen = new Set();
  for (const [sum, file] of lines) {
    assert(!seen.has(file), `duplicate CHECKSUMS entry: ${file}`);
    seen.add(file);
    const bytes = await readFile(new URL(file, ROOT));
    const actual = createHash("sha256").update(bytes).digest("hex");
    assertEquals(
      actual,
      sum,
      `${file} differs from its vendored pristine copy — ` +
        `revert it or re-run fetch-vendor-solid.sh deliberately`,
    );
  }
});
