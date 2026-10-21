// build.mjs — compile client-solid/ (.tsx) into client-solid-dist/.
//
// JSX transform: @babel/core + babel-preset-solid running right here in Deno
// (build-time only, from npm packages pinned in deno.json and integrity-locked
// in deno.lock). Run `deno task deps` once, then build offline with
// `deno run --frozen --cached-only --allow-all build.mjs`. This is
// the exact transform vite-plugin-solid uses, without Vite: it emits Solid's
// fine-grained runtime calls (reactive getters, insert, template hoisting),
// which Deno's own swc transform cannot produce.
// The browser never sees Babel — emitted code imports only the vendored
// solid-js dists, rewritten below to absolute /vendor/ paths.

import { join, dirname, relative } from "node:path";

import * as BabelNS from "@babel/core";
import solidPresetImport from "babel-preset-solid";

const Babel = BabelNS.transformSync ? BabelNS : BabelNS.default;
const solidPreset = solidPresetImport?.default ?? solidPresetImport;

const SRC = "client-solid";
const DIST = "client-solid-dist";

// Emitted bare specifiers -> vendored paths served by the engine.
const VENDOR_REWRITES = new Map([
  ["solid-js/web", "/vendor/solid/web.mjs"],
  ["solid-js/store", "/vendor/solid/store.mjs"],
  ["solid-js", "/vendor/solid/solid.mjs"],
  ["@tanstack/solid-virtual", "/vendor/tanstack/solid-virtual.mjs"],
]);

function rewriteSpecifiers(code) {
  const ast = Babel.parseSync(code, { babelrc: false, configFile: false });
  const edits = [];
  Babel.traverse(ast, {
    StringLiteral({ node, parent }) {
      const isSource = parent.source === node &&
        ["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(parent.type);
      const isDynamicImport = parent.type === "CallExpression" &&
        parent.callee.type === "Import" && parent.arguments[0] === node;
      const path = VENDOR_REWRITES.get(node.value);
      if (path && (isSource || isDynamicImport)) edits.push([node.start, node.end, path]);
    },
  });
  // Replace only the specifier contents, preserving quotes and surrounding bytes.
  for (const [start, end, path] of edits.sort((a, b) => b[0] - a[0])) {
    code = code.slice(0, start + 1) + path + code.slice(end - 1);
  }
  return code;
}

async function* walk(dir) {
  for await (const e of Deno.readDir(dir)) {
    const full = join(dir, e.name);
    if (e.isDirectory) yield* walk(full);
    else yield full;
  }
}

try {
  await Deno.remove(DIST, { recursive: true });
} catch (error) {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
}
await Deno.mkdir(DIST, { recursive: true });

let compiled = 0, copied = 0;
for await (const full of walk(SRC)) {
  const rel = relative(SRC, full);
  // .tsx compiles; .js copies — bare imports get rewritten either way
  const isJsx = rel.endsWith(".tsx");
  const isJs = rel.endsWith(".js");
  const dest = join(DIST, isJsx ? rel.slice(0, -4) + ".js" : rel);
  await Deno.mkdir(dirname(dest), { recursive: true });
  if (isJsx) {
    const source = await Deno.readTextFile(full);
    const out = Babel.transformSync(source, {
      filename: rel,
      presets: [[solidPreset, {}]],
      babelrc: false,
      configFile: false,
      sourceMaps: false,
    });
    await Deno.writeTextFile(dest, rewriteSpecifiers(out.code));
    compiled++;
  } else if (isJs) {
    const source = await Deno.readTextFile(full);
    await Deno.writeTextFile(dest, rewriteSpecifiers(source));
    copied++;
  } else {
    await Deno.copyFile(full, dest);
    copied++;
  }
}

console.log(`build.mjs: ${compiled} .tsx compiled, ${copied} files copied -> ${DIST}/`);
