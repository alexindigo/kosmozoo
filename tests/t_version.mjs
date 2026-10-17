import { assert, assertEquals, assertThrows, assertRejects } from "jsr:@std/assert";
import { readAppVersion, formatVersion } from "../src/version.mjs";
import { startEngine } from "../src/main.mjs";

const revision = "0123456789abcdef0123456789abcdef01234567";
const release = Deno.readTextFileSync(new URL("../VERSION", import.meta.url)).trim();

async function withVersion(content, run) {
  const root = await Deno.makeTempDir({ prefix: "kz-version-" }), file = `${root}/VERSION`;
  try { await Deno.writeTextFile(file, content); await run(file, root); }
  finally { await Deno.remove(root, { recursive: true }); }
}

Deno.test("version: reads trimmed numeric MAJOR.MINOR[.PATCH] and defaults to tracked VERSION", async () => {
  for (const version of ["0.2", "0.2.0"]) await withVersion(` ${version}\n`, file => {
    assertEquals(readAppVersion({ file, env: {} }), { version, revision: null });
  });
  assertEquals(readAppVersion({ env: {} }).version, release);
});

Deno.test("version: missing, unreadable and invalid files fail with their location", async () => {
  await withVersion("0.2.0\n", (file, root) => {
    assertThrows(() => readAppVersion({ file: `${root}/missing-VERSION`, env: {} }), Error, `${root}/missing-VERSION`);
    assertThrows(() => readAppVersion({ file: root, env: {} }), Error, root);
  });
  for (const content of ["", "v0.2.0", "0", "0.2.0.1", "0.x", "0.2.0-beta"]) {
    await withVersion(content, file => assertThrows(() => readAppVersion({ file, env: {} }), Error, file));
  }
});

Deno.test("version: env beats provenance; provenance beats development; empty build arg is absent", () => {
  const provenance = { commit: revision };
  assertEquals(readAppVersion({ env: { KOZMOZOO_REVISION: "abc1234" }, provenance }).revision, "abc1234");
  assertEquals(readAppVersion({ env: {}, provenance }).revision, revision);
  assertEquals(readAppVersion({ env: { KOZMOZOO_REVISION: "" }, provenance }).revision, revision);
  assertEquals(readAppVersion({ env: { KOZMOZOO_REVISION: "" }, provenance: { commit: null } }).revision, null);
});

Deno.test("version: bad revisions fail instead of falling back to provenance", () => {
  for (const value of ["abcdef", revision + "0", revision.toUpperCase(), "g123456", " 0123456"]) {
    assertThrows(() => readAppVersion({ env: { KOZMOZOO_REVISION: value }, provenance: { commit: revision } }), Error, "KOZMOZOO_REVISION");
  }
});

Deno.test("version: one formatter supplies revision, development and unknown displays", () => {
  assertEquals(formatVersion({ version: "0.2.0", revision }), "v0.2.0 (0123456)");
  assertEquals(formatVersion({ version: "0.2.0", revision: null }), "v0.2.0-dev");
  assertEquals(formatVersion({ version: null, revision }), "");
  assertEquals(formatVersion({}), "");
});

Deno.test("version: CLI reports the app identity, actual Deno and target without engine startup", async () => {
  for (const value of ["", revision]) {
    const result = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--frozen", "--cached-only", "--allow-all", new URL("../src/cli.mjs", import.meta.url).pathname, "--version"],
      env: { KOZMOZOO_REVISION: value }, stdout: "piped", stderr: "piped",
    }).output();
    assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
    assertEquals(new TextDecoder().decode(result.stdout).trim(),
      `kosmozoo ${formatVersion({ version: release, revision: value })} (input working-source; Deno ${Deno.version.deno}; ${Deno.build.target})`);
  }
});

Deno.test("version: direct engine startup rejects invalid identity before acquiring state", async () => {
  await assertRejects(() => startEngine({ env: { KOZMOZOO_REVISION: "invalid" } }), Error, "KOZMOZOO_REVISION");
});

Deno.test("version: engine exposes app identity only in the route and logs it before listening", async () => {
  const root = await Deno.makeTempDir({ prefix: "kz-version-engine-" });
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 }), port = listener.addr.port;
  listener.close();
  const log = console.log, lines = [];
  let engine;
  try {
    console.log = (...args) => lines.push(args.join(" "));
    engine = await startEngine({ env: { HOME: root, KOZMOZOO_HOSTS: "", KOZMOZOO_STATE: `${root}/state`,
      KOZMOZOO_CACHE: `${root}/cache`, KOZMOZOO_BIND: "127.0.0.1", KOZMOZOO_PORT: String(port), KOZMOZOO_REVISION: revision } });
    const body = await (await fetch(`http://127.0.0.1:${port}/api/runtime`)).json();
    assertEquals(body.app, { version: release, revision });
    assertEquals(Object.hasOwn(engine.runtime(), "app"), false);
    const metadata = JSON.parse(await Deno.readTextFile(`${root}/state/engine-instance.json`));
    assertEquals(Object.hasOwn(metadata, "app"), false);
    const versionAt = lines.indexOf(`kosmozoo v${release} (0123456)`);
    assert(versionAt >= 0 && lines.findIndex(line => line.startsWith("kosmozoo engine listening")) > versionAt);
    const shared = await fetch(`http://127.0.0.1:${port}/shared/version.mjs`);
    assertEquals(shared.status, 200);
    assert((await shared.text()).includes("export function formatVersion"));
  } finally { console.log = log; await engine?.shutdown(); await Deno.remove(root, { recursive: true }); }
});
