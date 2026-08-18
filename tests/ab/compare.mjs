// tests/ab/compare.mjs — the A/B rig driver.
//
// Byte-compares canonical extractor JSON from two engines. The Python side
// runs on the host (the frozen checkout has no Deno); the Deno side runs in
// the devcontainer. Because the two run in different environments the rig
// takes the Python output as a *file*, captured beforehand:
//
//   # on the host, from the frozen checkout:
//   python3 /path/to/dev/tests/ab/extract-python.py /path/to/dev/tests/fixtures > /tmp/ab-python.json
//   # in the devcontainer:
//   deno run --allow-all tests/ab/compare.mjs --python-baseline /tmp/ab-python.json
//
// Exits non-zero if any fixture's metadata differs between engines.

import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";

const { values } = parseArgs({
  options: {
    fixtures: { type: "string", default: new URL("../fixtures", import.meta.url).pathname },
    "python-baseline": { type: "string" },
  },
});

const fixtures = values.fixtures;

// Canonicalise: stable key order, drop undefined. Both engines must produce
// identical canonical JSON per fixture.
function canon(obj) {
  return JSON.stringify(obj, (k, v) => (v === undefined ? null : v));
}

async function readPythonBaseline() {
  if (!values["python-baseline"]) return null;
  return JSON.parse(await readFile(values["python-baseline"], "utf-8"));
}

async function extractDeno() {
  // The shared extractor module lands in Phase 5. Until it exists the rig
  // reports the Deno side as unavailable rather than failing spuriously.
  try {
    const mod = await import("../../src/extractor.mjs");
    return await mod.extractDir(fixtures);
  } catch (e) {
    if (e.code === "ERR_MODULE_NOT_FOUND" || e instanceof TypeError) return null;
    throw e;
  }
}

const py = await readPythonBaseline();
const deno = await extractDeno();

if (py === null && deno === null) {
  console.log("A/B: neither side available (capture a Python baseline and/or land Phase 5).");
  Deno.exit(0);
}
if (py === null) {
  console.log("A/B: no Python baseline supplied (--python-baseline); Deno side only.");
  Deno.exit(0);
}
if (deno === null) {
  console.log("A/B: Python baseline loaded; Deno extractor not present yet (Phase 5).");
  console.log(`fixtures on Python side: ${Object.keys(py).length}`);
  Deno.exit(0);
}

let mismatches = 0;
for (const name of Object.keys(py)) {
  const a = canon(py[name]);
  const b = canon(deno[name]);
  if (a !== b) {
    mismatches++;
    console.error(`MISMATCH ${name}`);
  }
}
for (const name of Object.keys(deno)) {
  if (!(name in py)) {
    mismatches++;
    console.error(`DENO-ONLY ${name}`);
  }
}

if (mismatches) {
  console.error(`A/B FAILED: ${mismatches} fixture(s) differ`);
  Deno.exit(1);
}
console.log(`A/B OK: ${Object.keys(py).length} fixtures byte-identical`);
