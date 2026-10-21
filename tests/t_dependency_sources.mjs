import { assert, assertEquals } from "jsr:@std/assert";

const ROOT = new URL("../", import.meta.url);
const HTTP = /^https?:/i;
const CODE = /\.(?:mjs|js|ts|tsx|cjs)$/;
const EXCLUDED = new Set(["client-solid-dist", "state", "cache", "tests/fixtures"]);

// Static imports/re-exports (including multiline lists), side-effect imports,
// and literal dynamic imports. Ordinary URL strings are not module specifiers.
const URL_IMPORT = /(?:\b(?:import|export)\s*(?:[^;"'`]*?\bfrom\s*)?|\bimport\s*\(\s*)["'`]https?:\/\/[^"'`\s]+["'`]/gi;

function checkImports(imports = {}) {
  for (const [specifier, target] of Object.entries(imports)) {
    assert(!HTTP.test(specifier), `URL import-map specifier: ${specifier}`);
    assert(!HTTP.test(target), `URL import-map target: ${target}`);
  }
}

Deno.test("dependency import map has no HTTP module sources", async () => {
  const config = JSON.parse(await Deno.readTextFile(new URL("deno.json", ROOT)));
  checkImports(config.imports);
  for (const [scope, imports] of Object.entries(config.scopes ?? {})) {
    assert(!HTTP.test(scope), `URL import-map scope: ${scope}`);
    checkImports(imports);
  }
});

Deno.test("dependency lock has no remote section or HTTP keys", async () => {
  const lock = JSON.parse(await Deno.readTextFile(new URL("deno.lock", ROOT)));
  assert(!Object.hasOwn(lock, "remote"), "deno.lock must not have a remote section");
  function checkKeys(value) {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      assert(!HTTP.test(key), `URL lock key: ${key}`);
      checkKeys(child);
    }
  }
  checkKeys(lock);
});

async function* codeFiles(path) {
  for await (const entry of Deno.readDir(new URL(path, ROOT))) {
    const file = `${path}/${entry.name}`;
    if (entry.name === "node_modules" || EXCLUDED.has(file)) continue;
    if (entry.isDirectory) yield* codeFiles(file);
    else if (entry.isFile && CODE.test(entry.name)) yield file;
  }
}

Deno.test("source imports use local files or npm/jsr registries", async () => {
  const files = ["build.mjs"];
  for (const dir of ["src", "client-solid", "client/js", "client/vendor", "plugins", "dev", "tests"]) {
    for await (const file of codeFiles(dir)) files.push(file);
  }
  const violations = [];
  for (const file of files) {
    const code = await Deno.readTextFile(new URL(file, ROOT));
    for (const match of code.matchAll(URL_IMPORT)) {
      const line = code.slice(0, match.index).split("\n").length;
      violations.push(`${file}:${line}: ${match[0]}`);
    }
  }
  assertEquals(violations, [], "HTTP module imports are forbidden");
});
