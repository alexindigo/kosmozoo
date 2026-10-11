import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.mjs";
import { CorruptStateError } from "../src/state.mjs";
import { buildContext } from "../src/context.mjs";

// SQLite's native descriptors are outside Deno's resource sanitizer. Observe the
// actual state resources; unrelated fixtures/concurrent processes cannot count.
async function descriptors(dir) {
  const paths = [];
  for await (const entry of Deno.readDir("/proc/self/fd")) {
    try {
      const path = await Deno.readLink(`/proc/self/fd/${entry.name}`);
      if (path.startsWith(dir + "/")) paths.push(path);
    } catch (error) { if (!(error instanceof Deno.errors.NotFound)) throw error; }
  }
  return paths.sort();
}

async function stateFixture(run) {
  const dir = await Deno.makeTempDir({ dir: tmpdir(), prefix: "kz-store-startup-" });
  let success = false;
  try { await run(dir); success = true; }
  finally {
    if (success) await Deno.remove(dir, { recursive: true });
    else console.error(`Store startup failure evidence retained: ${dir}`);
  }
}

async function assertRetired(dir, error) {
  const open = await descriptors(dir);
  await Deno.writeTextFile(join(dir, "failure-inspection.json"), JSON.stringify({
    error: { name: error.name, message: error.message }, descriptors: open,
  }, null, 2));
  assertEquals(open, [], "rejected Store construction must retire all acquired native state handles");
}

Deno.test("Store construction: corrupt feedback preserves quarantine and closes every acquired SQLite handle", async () => {
  await stateFixture(async dir => {
    const path = join(dir, "feedback.json"), bytes = "{invalid-json";
    await Deno.writeTextFile(path, bytes);
    assertEquals(await descriptors(dir), []);
    const error = await assertRejects(() => Store.open(dir, { feedbackPath: path }), CorruptStateError);
    assertEquals(error.path, path);
    assertEquals(await Deno.readTextFile(error.quarantined), bytes);
    await assertRetired(dir, error);
    const store = await Store.open(dir);
    store.close();
    assertEquals(await descriptors(dir), []);
    assertEquals(await Deno.readTextFile(error.quarantined), bytes);
  });
});

Deno.test("Store construction: failed import read closes handles without consuming or replacing existing judgments", async () => {
  await stateFixture(async dir => {
    const original = await Store.open(dir);
    original.collectionAdd("kept", "fake:8188");
    original.judgmentPatch("kept", "kept.png", { favorite: true, notes: { pos: "saved original" } });
    const expected = original.judgmentGet("kept", "kept.png");
    original.close();
    assertEquals(await descriptors(dir), []);
    const path = join(dir, "feedback.json");
    await Deno.mkdir(path);
    const error = await assertRejects(() => Store.open(dir, { feedbackPath: path }), Error, "EISDIR");
    assert(error.message.includes(path));
    await assertRetired(dir, error);
    assert((await Deno.stat(path)).isDirectory);
    const reopened = await Store.open(dir);
    assertEquals(reopened.judgmentGet("kept", "kept.png"), expected);
    reopened.close();
    assertEquals(await descriptors(dir), []);
  });
});

Deno.test("Store construction: early SQL initialization failure closes the connection before statements exist", async () => {
  await stateFixture(async dir => {
    const path = join(dir, "metadata.db"), bytes = "not a SQLite database";
    await Deno.writeTextFile(path, bytes);
    const error = await assertRejects(() => Store.open(dir), Error, "file is not a database");
    await assertRetired(dir, error);
    assertEquals(await Deno.readTextFile(path), bytes);
  });
});

Deno.test("Context construction: later feature failure retires owned resources and preserves borrowed Store ownership", async () => {
  await stateFixture(async dir => {
    const failure = new Error("feature assembly failed");
    const features = [{ name: "failure", register() { throw failure; } }];
    const env = { HOME: dir, KOZMOZOO_STATE: dir, KOZMOZOO_HOSTS: "", KOZMOZOO_CACHE: join(dir, "cache") };
    const error = await assertRejects(() => buildContext({ env, start: false, fakes: { features, plugins: { list: () => [] } } }));
    assert(error === failure);
    await assertRetired(dir, error);
    const borrowed = await Store.open(dir);
    const before = await descriptors(dir);
    const borrowedError = await assertRejects(() => buildContext({ env, start: false, fakes: { store: borrowed, features, plugins: { list: () => [] } } }));
    assert(borrowedError === failure);
    assertEquals(await descriptors(dir), before);
    borrowed.collectionAdd("still-owned", "fake:8188");
    assert(borrowed.collectionGet("still-owned"));
    borrowed.close();
    assertEquals(await descriptors(dir), []);
  });
});
