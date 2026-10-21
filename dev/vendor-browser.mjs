// Project locked npm packages into browser-ready files. Run `deno task deps`
// first, then `deno task vendor` (frozen, cached-only, no network permission).
// npm: aliases in deno.json keep versions central and leave the browser-runtime
// aliases used by Deno's client tests pointing at the generated browser files.
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../", import.meta.url);
const production = [[ 'process.env.NODE_ENV !== "production"', "false" ]];

// One inventory owns source selection, documented transforms, outputs and hashes.
// Only bare-specifier path fixes and the existing NODE_ENV substitution apply.
const files = [
  { package: "npm:solid-js", path: "dist/solid.js", output: "solid/solid.mjs", transforms: [] },
  { package: "npm:solid-js", path: "web/dist/web.js", output: "solid/web.mjs", transforms: [["from 'solid-js'", "from './solid.mjs'"]] },
  { package: "npm:solid-js", path: "store/dist/store.js", output: "solid/store.mjs", transforms: [["from 'solid-js'", "from './solid.mjs'"]] },
  { package: "npm:@tanstack/solid-virtual", path: "dist/esm/index.js", output: "tanstack/solid-virtual.mjs", transforms: [
    ['from "@tanstack/virtual-core"', 'from "./virtual-core.mjs"'],
    ['from "solid-js/store"', 'from "../solid/store.mjs"'],
    ['from "solid-js"', 'from "../solid/solid.mjs"'],
  ] },
  { package: "npm:@tanstack/virtual-core", path: "dist/esm/index.js", output: "tanstack/virtual-core.mjs", transforms: production },
  { package: "npm:@tanstack/virtual-core", path: "dist/esm/lazy-measurements.js", output: "tanstack/lazy-measurements.js", transforms: [] },
  { package: "npm:@tanstack/virtual-core", path: "dist/esm/utils.js", output: "tanstack/utils.js", transforms: production },
  { package: "npm:nouislider", path: "dist/nouislider.mjs", output: "nouislider.mjs", transforms: [] },
  { package: "npm:nouislider", path: "dist/nouislider.min.css", output: "nouislider.min.css", transforms: [] },
];

const packages = new Map();
async function packageRoot(specifier) {
  if (packages.has(specifier)) return packages.get(specifier);
  // Deno resolves an installed npm entrypoint to a file URL. Walk up to its
  // named package.json instead of depending on the npm cache's private layout
  // or on packages exporting package.json/browser dist subpaths.
  let directory = dirname(fileURLToPath(import.meta.resolve(specifier)));
  while (true) {
    try {
      const metadata = JSON.parse(await Deno.readTextFile(join(directory, "package.json")));
      if (metadata.name === specifier.slice(4)) {
        packages.set(specifier, directory);
        return directory;
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Cannot locate package root: ${specifier}`);
    directory = parent;
  }
}

// Read and validate every result before replacing any accepted browser file.
const generated = [];
for (const file of files) {
  let text = await Deno.readTextFile(join(await packageRoot(file.package), file.path));
  for (const [before, after] of file.transforms) text = text.replaceAll(before, after);
  if (!file.output.endsWith(".css") && /\b(?:from\s+|import\s*(?:\(\s*)?)["'](?!\.{1,2}\/|\/)/.test(text)) {
    throw new Error(`Bare specifier survived the path fix: ${file.output}`);
  }
  const bytes = new TextEncoder().encode(text);
  generated.push({ path: `client/vendor/${file.output}`, bytes });
}

let checksums = "";
for (const { path, bytes } of generated) {
  const output = new URL(path, ROOT);
  await Deno.mkdir(dirname(fileURLToPath(output)), { recursive: true });
  await Deno.writeFile(output, bytes);
  checksums += `${createHash("sha256").update(bytes).digest("hex")}  ${path}\n`;
}
await Deno.writeTextFile(new URL("client/vendor/CHECKSUMS", ROOT), checksums);
console.log(`vendored OK (${generated.length} files checksummed)`);
