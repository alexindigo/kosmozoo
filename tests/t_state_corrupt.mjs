// tests/t_state_corrupt.mjs — a state file that exists but does not parse
// is quarantined (renamed aside, bytes preserved) and boot stops with a
// CorruptStateError — never overwritten with an empty document.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert";
import { CorruptStateError, loadVersioned } from "../src/state.mjs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

Deno.test("state: corrupt JSON is quarantined, never overwritten", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-corrupt-"));
  const path = join(dir, "feedback.json");
  const corrupt = '{"version":1,"data":{"abc123":{"vote":"up"';
  await writeFile(path, corrupt);

  const err = await assertRejects(
    () => loadVersioned(path, { current: 1, empty: () => ({}), migrations: {} }),
    CorruptStateError,
  );
  assertEquals(err.path, path);
  assertStringIncludes(err.quarantined, `${path}.corrupt-`);
  assertStringIncludes(err.message, path);
  assertStringIncludes(err.message, err.quarantined);

  // original bytes preserved at the quarantine path; the target was NOT
  // recreated (no empty doc written over the user's data)
  assertEquals(await readFile(err.quarantined, "utf-8"), corrupt);
  assert(!existsSync(path), "target must not be overwritten with an empty doc");
  await rm(dir, { recursive: true });
});

Deno.test("state: after quarantine the next boot starts empty, valid docs still load", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-corrupt2-"));
  const path = join(dir, "settings.json");
  await writeFile(path, "{bad");
  await assertRejects(
    () => loadVersioned(path, { current: 1, empty: () => ({}), migrations: {} }),
    CorruptStateError,
  );
  // the quarantined file is out of the way — a fresh boot creates an empty doc
  const doc = await loadVersioned(path, { current: 1, empty: () => ({}), migrations: {} });
  assertEquals(doc, { version: 1, data: {} });
  // and a valid document round-trips untouched
  const again = await loadVersioned(path, { current: 1, empty: () => ({}), migrations: {} });
  assertEquals(again.version, 1);
  await rm(dir, { recursive: true });
});
