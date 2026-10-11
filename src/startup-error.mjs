// Bootstrap/source error presentation has no SQLite or engine-graph dependency.
import { CorruptStateError } from "./state.mjs";

export function reportStartupError(error) {
  const chain = [], seen = new Set();
  for (let current = error; current && !seen.has(current); current = current.cause) {
    seen.add(current); chain.push(current);
  }
  const corruption = chain.find(current => current instanceof CorruptStateError);
  if (corruption) {
    console.error(`kosmozoo: corrupt state file: ${corruption.path}`);
    console.error(`kosmozoo: original bytes preserved at: ${corruption.quarantined}`);
    console.error("kosmozoo: repair the JSON and move it back, or explicitly remove it to start empty — unreadable state is never overwritten");
  } else {
    console.error(`kosmozoo: ${error.message ?? error}`);
    for (const cause of chain.slice(1)) console.error(`kosmozoo: caused by: ${cause.message ?? cause}`);
    if (chain.some(current => current.message === "Failed to load SQLite3 Dynamic Library")) {
      console.error("kosmozoo: SQLite needs a readable compatible library and a writable temporary native cache that permits executable mappings. Check TMPDIR and its mount permissions (including noexec), or repair the explicit DENO_SQLITE_PATH. No native download fallback is used.");
    }
  }
  if (error instanceof AggregateError) console.error(error);
}
