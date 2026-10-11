// Cooperative engine ownership: one stable inode, private metadata, nonce identity.
// No state path is published; host/container path namespaces need not match.
import { join } from "node:path";
import { getuid } from "node:process";
import { browserOrigin } from "./runtime-config.mjs";

export const RUNTIME_PROTOCOL = "kosmozoo-runtime";
export const RUNTIME_VERSION = 1;
const modes = new Set(["app", "serve", "source"]);
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
export function validRuntime(value) {
  return record(value) && value.protocol === RUNTIME_PROTOCOL && value.version === RUNTIME_VERSION &&
    typeof value.instance === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.instance) &&
    typeof value.sourceVersion === "string" && value.sourceVersion.length > 0 && modes.has(value.mode) &&
    ["starting", "ready", "stopping"].includes(value.status) && record(value.binding) &&
    typeof value.binding.hostname === "string" && value.binding.hostname.length > 0 &&
    Number.isInteger(value.binding.port) && value.binding.port >= 1 && value.binding.port <= 65535 &&
    typeof value.configuredBind === "string" && value.configuredBind.length > 0;
}

async function readMetadata(path, identity, expectedOwnerPid = null) {
  let info;
  try { info = await Deno.lstat(path); }
  catch (error) { if (error instanceof Deno.errors.NotFound) return null; throw error; }
  if (!info.isFile || info.isSymlink || info.uid !== getuid() || (info.mode & 0o077)) throw new Error("Engine metadata is not a private owned file; refusing uncertain instance identity");
  let value;
  try { value = JSON.parse(await Deno.readTextFile(path)); }
  catch (error) { throw new Error("Engine metadata is unreadable; preserve it and inspect the selected state directory", { cause: error }); }
  if (!validRuntime(value)) throw new Error("Engine metadata protocol is unknown; refusing uncertain instance identity");
  if (value.lockIdentity?.device !== identity.device || value.lockIdentity?.inode !== identity.inode) throw new Error("Engine metadata belongs to another state lockfile; refusing attachment to copied or unrelated state");
  if (expectedOwnerPid !== null && value.ownerPid !== expectedOwnerPid) return null;
  return value;
}

// Read-only lifecycle preflight: never create or briefly claim state while a
// managed unit is still entering startup. PID is only a preflight filter;
// matchingInstance still requires the cooperative lock and nonce/HTTP identity.
export async function peekInstance(state, expectedOwnerPid = null) {
  let root, file;
  try {
    root = await Deno.realPath(state);
    file = await Deno.open(join(root, "engine.lock"), { read: true });
    const value = await file.stat();
    return await readMetadata(join(root, "engine-instance.json"), { device: String(value.dev), inode: String(value.ino) }, expectedOwnerPid);
  } catch (error) { if (error instanceof Deno.errors.NotFound) return null; throw error; }
  finally { file?.close(); }
}

export async function acquireInstance(state) {
  await Deno.mkdir(state, { recursive: true });
  const root = await Deno.realPath(state), lockPath = join(root, "engine.lock"), metadataPath = join(root, "engine-instance.json");
  let existing;
  try { existing = await Deno.lstat(lockPath); }
  catch (error) { if (!(error instanceof Deno.errors.NotFound)) throw error; }
  if (existing && (!existing.isFile || existing.isSymlink || existing.uid !== getuid())) throw new Error("Engine lock is not an owned real file in the selected state directory");
  const file = await Deno.open(lockPath, { create: true, read: true, write: true, mode: 0o600 });
  let owner, identity;
  try {
    const info = await file.stat();
    if (!Number.isSafeInteger(info.dev) || !Number.isSafeInteger(info.ino)) throw new Error("Stable lockfile identity is unavailable on this filesystem");
    identity = { device: String(info.dev), inode: String(info.ino) };
    owner = await file.tryLock(true);
  }
  catch (error) { file.close(); throw error; }
  if (!owner) file.close();
  const instance = crypto.randomUUID();
  let closed = false;
  const metadata = () => readMetadata(metadataPath, identity);
  return Object.freeze({
    owner, instance, metadata,
    async publish(value) {
      if (!owner || closed || !validRuntime(value) || value.instance !== instance) throw new Error("No live instance ownership for publication");
      const temporary = metadataPath + ".tmp." + crypto.randomUUID();
      await Deno.writeTextFile(temporary, JSON.stringify({ ...value, lockIdentity: identity, ownerPid: Deno.pid }), { createNew: true, mode: 0o600 });
      await Deno.rename(temporary, metadataPath);
    },
    async release() {
      if (closed) return;
      closed = true;
      if (!owner) return;
      try {
        const value = await metadata();
        if (value?.instance === instance) await Deno.remove(metadataPath);
      } finally { file.close(); }
      // Never unlink the stable lockfile: another process may hold its inode.
    },
  });
}

export async function matchingInstance(lease, requested, { fetchRuntime = async url => {
  const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
  if (!response.ok) throw new Error(`Runtime identity endpoint returned ${response.status}`);
  return response.json();
}, timeoutMs = 10000 } = {}) {
  if (lease.owner) throw new Error("No other cooperative owner to reuse");
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const local = await lease.metadata();
    if (local) {
      if (local.status === "stopping") throw new Error("The selected engine is stopping; retry after explicit shutdown completes");
      if (local.status === "starting") {
        if (performance.now() >= deadline) throw new Error("The selected engine has not reached matching readiness; no replacement writer was started");
        await new Promise(resolve => setTimeout(resolve, 50));
        continue;
      }
      const url = browserOrigin(local.binding);
      let remote;
      try { remote = await fetchRuntime(new URL("api/runtime", url).href); }
      catch (error) {
        throw new Error("Selected engine is not ready at its recorded binding; refusing attachment or a replacement writer", { cause: error });
      }
      if (!validRuntime(remote) || remote.status !== "ready" || remote.instance !== local.instance || remote.sourceVersion !== local.sourceVersion ||
          remote.mode !== local.mode || remote.configuredBind !== local.configuredBind || remote.binding.hostname !== local.binding.hostname || remote.binding.port !== local.binding.port) {
        throw new Error("Listener identity does not match private metadata for the selected state directory; no attachment was made");
      }
      if (requested.explicitPort && requested.binding.port !== local.binding.port || requested.explicitBind && requested.binding.hostname !== local.configuredBind) {
        throw new Error("Explicit bind/port overrides conflict with the selected running engine; opening a window cannot reconfigure it");
      }
      return Object.freeze({ runtime: remote, browserURL: url });
    }
    if (performance.now() >= deadline) throw new Error("Another state owner has not published matching readiness; no alternate port or writer was started");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
