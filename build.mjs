// build.mjs — compile client-solid/ (.tsx) into client-solid-dist/.
//
// JSX transform: @babel/core + babel-preset-solid running right here in Deno
// (build-time only, loaded from pinned esm.sh URLs, cached in DENO_DIR, locked
// via deno.lock — `deno cache --lock=deno.lock build.mjs` before use). This is
// the exact transform vite-plugin-solid uses, without Vite: it emits Solid's
// fine-grained runtime calls (reactive getters, insert, template hoisting),
// which Deno's own swc transform cannot produce (see
// ~/Documents/kosmozoo/plans/solid-migration/blocker-jsx-toolchain.md).
// The browser never sees Babel — emitted code imports only the vendored
// solid-js dists, rewritten below to absolute /vendor/ paths.

import { join, dirname, relative } from "node:path";

import * as BabelNS from "https://esm.sh/@babel/core@7.26.0/es2022/core.mjs";
import solidPresetImport from "https://esm.sh/babel-preset-solid@1.9.15";

const Babel = BabelNS.transformSync ? BabelNS : BabelNS.default;
const solidPreset = solidPresetImport?.default ?? solidPresetImport;

const SRC = "client-solid";
const DIST = "client-solid-dist";

// Emitted bare specifiers -> vendored paths served by the engine
// (path fix is a build-time concern, same pattern as preact's vendor.mjs).
const VENDOR_REWRITES = [
  ["solid-js/web", "/vendor/solid/web.mjs"],
  ["solid-js/store", "/vendor/solid/store.mjs"],
  ["solid-js", "/vendor/solid/solid.mjs"],
  ["@tanstack/solid-virtual", "/vendor/tanstack/solid-virtual.mjs"],
];

function rewriteSpecifiers(code) {
  for (const [spec, path] of VENDOR_REWRITES) {
    code = code.replaceAll(`"${spec}"`, `"${path}"`)
      .replaceAll(`'${spec}'`, `'${path}'`);
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

await Deno.remove(DIST).catch(() => {});
await Deno.mkdir(DIST, { recursive: true });

let compiled = 0, copied = 0;
for await (const full of walk(SRC)) {
  const rel = relative(SRC, full);
  const dest = join(DIST, rel.endsWith(".tsx") ? rel.slice(0, -4) + ".js" : rel);
  await Deno.mkdir(dirname(dest), { recursive: true });
  if (rel.endsWith(".tsx")) {
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
  } else {
    await Deno.copyFile(full, dest);
    copied++;
  }
}

console.log(`build.mjs: ${compiled} .tsx compiled, ${copied} files copied -> ${DIST}/`);
