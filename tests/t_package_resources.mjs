import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert";
import { join } from "node:path";
import { writePackageResources } from "../src/desktop/package-resources.mjs";
import { parseCommand } from "../src/cli.mjs";

const source = new URL("../", import.meta.url);
const read = name => Deno.readFile(new URL(name, source));
const copied = {
  "share/icons/hicolor/256x256/apps/kosmozoo.png": "client/logo-256.png",
  "share/licenses/kosmozoo/LICENSE": "LICENSE",
  "share/licenses/kosmozoo/LICENSE.GPL": "LICENSE.GPL",
  "share/licenses/kosmozoo/THIRD_PARTY_NOTICES.txt": "packaging/linux/resources/THIRD_PARTY_NOTICES.txt",
  "share/licenses/kosmozoo/NOTICE-SOURCES.json": "packaging/linux/resources/NOTICE-SOURCES.json",
  "share/doc/kosmozoo/executable.md": "docs/executable.md",
  "share/doc/kosmozoo/PUBLICATION.md": "packaging/linux/PUBLICATION.md",
  "share/doc/kosmozoo/LICENSING.md": "packaging/linux/LICENSING.md",
};
async function files(root, prefix = "") {
  const result = [];
  for await (const entry of Deno.readDir(root)) {
    const path = prefix + entry.name;
    if (entry.isDirectory) result.push(...await files(join(root, entry.name), path + "/"));
    else result.push(path);
  }
  return result.sort();
}
async function temporary(run) {
  const root = await Deno.makeTempDir({ prefix: "kz-package-resources-" });
  try { await run(root); } finally { await Deno.remove(root, { recursive: true }); }
}

Deno.test("package resources: exact package files, contents and install paths, not staging paths", async () => {
  await temporary(async destdir => {
    const prefix = "/opt/kosmozoo", root = join(destdir, prefix);
    await writePackageResources({ prefix, destdir, read });
    assertEquals(await files(destdir), [...Object.keys(copied), "lib/systemd/user/kosmozoo-engine.service", "share/applications/kosmozoo.desktop"].map(path => "opt/kosmozoo/" + path).sort());
    for (const [path, from] of Object.entries(copied)) assertEquals(await Deno.readFile(join(root, path)), await read(from));
    const unit = await Deno.readTextFile(join(root, "lib/systemd/user/kosmozoo-engine.service"));
    const desktop = await Deno.readTextFile(join(root, "share/applications/kosmozoo.desktop"));
    assert(unit.includes('ExecStart=:/usr/bin/env -- "/opt/kosmozoo/bin/kosmozoo" serve\n'));
    assert(unit.includes("EnvironmentFile=-%E/kosmozoo/engine.env\n"));
    assert(desktop.includes('Exec=/usr/bin/env -- "/opt/kosmozoo/bin/kosmozoo" app\n'));
    assert(desktop.includes('Exec=/usr/bin/env -- "/opt/kosmozoo/bin/kosmozoo" browser-settings firefox\n'));
    assert(desktop.includes("Icon=/opt/kosmozoo/share/icons/hicolor/256x256/apps/kosmozoo.png\n"));
    assert(!unit.includes(destdir) && !desktop.includes(destdir));
    for (const path of await files(root)) assertEquals((await Deno.stat(join(root, path))).mode & 0o777, 0o644);
  });
});

Deno.test("package resources: validates absolute paths before reading or writing", async () => {
  const read = () => { throw new Error("must validate before reading"); };
  for (const value of ["", "relative", "../outside", "/bad\npath", undefined]) {
    await assertRejects(() => writePackageResources({ prefix: value, destdir: "/unused", read }), Error, "prefix must be an absolute path");
    await assertRejects(() => writePackageResources({ prefix: "/usr", destdir: value, read }), Error, "destdir must be an absolute path");
  }
});

Deno.test("package resources: refuses to overwrite package-owned files", async () => {
  await temporary(async destdir => {
    const path = join(destdir, "usr/lib/systemd/user/kosmozoo-engine.service");
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, "keep existing package file");
    await assertRejects(() => writePackageResources({ prefix: "/usr", destdir }), Deno.errors.AlreadyExists);
    assertEquals(await Deno.readTextFile(path), "keep existing package file");
  });
});

Deno.test("package resources: CLI accepts exactly one prefix and destdir with equals syntax", () => {
  assertEquals(parseCommand(["package-resources", "--prefix=/usr", "--destdir=/package"]), { command: "package-resources", prefix: "/usr", destdir: "/package" });
  assertEquals(parseCommand(["package-resources", "--destdir=/a space", "--prefix=/usr"]), { command: "package-resources", prefix: "/usr", destdir: "/a space" });
  for (const args of [[], ["--prefix=/usr"], ["--destdir=/package"], ["--prefix=/usr", "--prefix=/opt"], ["--destdir=/a", "--destdir=/b"], ["--prefix=", "--destdir=/a"], ["--prefix", "/usr", "--destdir=/a"], ["--prefix=/usr", "--destdir=/a", "--service"]]) {
    assertThrows(() => parseCommand(["package-resources", ...args]), Error, "Unknown command/options");
  }
});

Deno.test("package resources: CLI ignores HOME/XDG and needs no SQLite, service or network permissions", async () => {
  await temporary(async destdir => {
    const result = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--frozen", "--cached-only", "--no-prompt", "--allow-env", "--allow-read", `--allow-write=${destdir}`, new URL("../src/cli.mjs", import.meta.url).pathname,
        "package-resources", "--prefix=/usr", `--destdir=${destdir}`],
      env: { DENO_SQLITE_PATH: "/missing-library", DENO_SQLITE_LOCAL: "1", HOME: "/nonexistent-home", XDG_CONFIG_HOME: "/nonexistent-config", KOZMOZOO_REVISION: "invalid" },
      stdout: "piped", stderr: "piped",
    }).output();
    assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
    assertEquals((await files(destdir)).length, 10);
    for (const [path, from] of Object.entries(copied)) assertEquals(await Deno.readFile(join(destdir, "usr", path)), await read(from));
  });
});

Deno.test("package resources: build adapter delegates identically and retains fresh-output requirement", async () => {
  await temporary(async root => {
    const generated = join(root, "generated"), direct = join(root, "direct");
    const command = () => new Deno.Command(Deno.execPath(), {
      args: ["run", "--frozen", "--cached-only", "--allow-read", "--allow-write", new URL("../packaging/linux/render-resources.mjs", import.meta.url).pathname, "generated"],
      cwd: root, stdout: "piped", stderr: "piped",
    }).output();
    const first = await command();
    assertEquals(first.code, 0, new TextDecoder().decode(first.stderr));
    await writePackageResources({ prefix: "/usr", destdir: direct });
    assertEquals(await files(generated), await files(direct));
    for (const path of await files(direct)) assertEquals(await Deno.readFile(join(generated, path)), await Deno.readFile(join(direct, path)));
    assertEquals((await command()).code, 1);
  });
});
