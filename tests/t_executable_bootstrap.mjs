import { assertEquals, assertRejects } from "jsr:@std/assert";
import { selectNativeSqlite } from "../src/native-sqlite.mjs";

Deno.test("native bootstrap: explicit valid selection is preserved before engine import, never a download choice", async () => {
  const env = { DENO_SQLITE_PATH: "operator library.so" };
  const seen = [];
  assertEquals(await selectNativeSqlite(env, { stat: async path => { seen.push(path); return { isFile: true }; } }), { path: "operator library.so", explicit: true });
  assertEquals(env, { DENO_SQLITE_PATH: "operator library.so" });
  assertEquals(seen, ["operator library.so"]);
});
Deno.test("native bootstrap: empty/invalid/local-download overrides reject instead of overwriting operator choice", async () => {
  for (const path of ["", " ", "\0bad", undefined]) await assertRejects(() => selectNativeSqlite({ DENO_SQLITE_PATH: path }), Error, "DENO_SQLITE_PATH");
  await assertRejects(() => selectNativeSqlite({ DENO_SQLITE_LOCAL: "1", DENO_SQLITE_PATH: "valid.so" }), Error, "DENO_SQLITE_LOCAL");
  await assertRejects(() => selectNativeSqlite({ DENO_SQLITE_PATH: "directory" }, { stat: async () => ({ isFile: false }) }), Error, "not a file");
});
