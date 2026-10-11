// Bootstrap has no SQLite/engine dependency: FFI evaluates only after selection.
import { fileURLToPath } from "node:url";

export async function selectNativeSqlite(env, { stat = path => Deno.stat(path) } = {}) {
  if (env.DENO_SQLITE_LOCAL === "1") {
    throw new Error("DENO_SQLITE_LOCAL=1 is incompatible with packaged SQLite selection; unset it or select a valid DENO_SQLITE_PATH");
  }
  const explicit = Object.hasOwn(env, "DENO_SQLITE_PATH");
  const path = explicit ? env.DENO_SQLITE_PATH : fileURLToPath(new URL("../native/linux-x86_64/libsqlite3.so", import.meta.url));
  if (typeof path !== "string" || !path.trim() || path.includes("\0")) {
    throw new Error("DENO_SQLITE_PATH is explicitly empty or invalid; select a readable compatible SQLite library");
  }
  let info;
  try { info = await stat(path); }
  catch (error) {
    throw new Error(`SQLite library unavailable at ${path}; ${explicit ? "repair the explicit DENO_SQLITE_PATH" : "use the complete packaged executable"}. No native download was attempted.`, { cause: error });
  }
  if (!info.isFile) throw new Error(`SQLite library is not a file: ${path}`);
  return Object.freeze({ path, explicit });
}

export async function bootstrapNativeSqlite(env = Deno.env.toObject()) {
  const selection = await selectNativeSqlite(env);
  Deno.env.set("DENO_SQLITE_PATH", selection.path);
  return selection;
}
