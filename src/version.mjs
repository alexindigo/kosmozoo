// Release identity is read once at startup. Only formatVersion runs in the browser.
export function readAppVersion({ file = new URL("../VERSION", import.meta.url), env = Deno.env.toObject(), provenance = null } = {}) {
  const location = file instanceof URL ? file.pathname : file;
  let content;
  try { content = Deno.readTextFileSync(file); }
  catch (error) { throw new Error(`Cannot read the release version file ${location}: ${error.message}`); }
  const version = content.trim();
  if (!/^\d+\.\d+(\.\d+)?$/.test(version)) {
    throw new Error(`Invalid release version ${JSON.stringify(version)} in ${location}: expected MAJOR.MINOR or MAJOR.MINOR.PATCH digits`);
  }
  const revision = env.KOZMOZOO_REVISION || provenance?.commit || null;
  if (revision !== null && !/^[0-9a-f]{7,40}$/.test(revision)) {
    throw new Error(`Invalid KOZMOZOO_REVISION ${JSON.stringify(revision)}: expected 7-40 lowercase hexadecimal characters`);
  }
  return { version, revision };
}

// Shared display form for the CLI, engine log and header logo tooltip.
export function formatVersion({ version, revision }) {
  if (!version) return "";
  return revision ? `v${version} (${revision.slice(0, 7)})` : `v${version}-dev`;
}
