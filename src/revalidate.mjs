// src/revalidate.mjs — stale-while-revalidate for non-durable remotes.
//
// Bytes ALWAYS serve from the cache — a request never waits on the source.
// But at most once per REVALIDATE_MS per file, a request also fires an
// async check: has the source file changed (mtime)? Changed → re-read,
// re-hash, re-cache, remap. The request that triggered the check already
// got the previous bytes; the next one gets the fresh ones. Durable
// remotes (ComfyUI) are never checked. Meta and judgments are keyed by
// hash, so the new content starts clean and the old content keeps its
// history — nothing to migrate.

import { hostDurable, hostModified, hostReadBytes } from "./hosts.mjs";
import { sha256, cachePut } from "./cache.mjs";

const DEFAULT_MS = 60_000;

// Read fresh each time (env is the test seam; the read is cheap).
function revalidateMs() {
  const raw = Deno.env.get("KOZMOZOO_REVALIDATE_MS");
  return raw ? Math.max(1, Number(raw)) : DEFAULT_MS;
}

const lastCheck = new Map(); // host:filename -> Date.now() of last check

// Fire a debounced async revalidation. Never blocks, never throws.
export function scheduleRevalidate(ctx, host, filename) {
  const addr = ctx.hosts[host];
  if (!addr || hostDurable(addr)) return;
  const key = `${host}:${filename}`;
  const now = Date.now();
  if (now - (lastCheck.get(key) ?? 0) < revalidateMs()) return;
  lastCheck.set(key, now);
  revalidateNow(ctx, host, filename).catch(() => {});
}

// The check itself (exported for tests): compare source mtime against the
// recorded one; on mismatch re-read and remap. Same content with a newer
// mtime (a touch) only refreshes the stamp.
export async function revalidateNow(ctx, host, filename) {
  const addr = ctx.hosts[host];
  if (!addr) return;
  const mtime = await hostModified(addr, filename);
  if (mtime == null) return; // gone or no mtime seam — keep what we have
  const info = ctx.store.fileInfo(host, filename);
  if (info?.mtime != null && mtime === info.mtime) return; // unchanged

  const r = await hostReadBytes(addr, filename);
  if (r.status !== 200) return; // unreadable right now — keep what we have
  const bytes = new Uint8Array(await new Response(r.body).arrayBuffer());
  const hash = await sha256(bytes);
  if (info?.hash === hash) {
    ctx.store.touchFileMtime(host, filename, mtime);
    return;
  }
  await cachePut(hash, bytes);
  await ctx.store.ingestFile(host, filename, hash, bytes.length, {
    mtime,
    changed: !!info?.hash,
  });
}

// test seam
export function __resetRevalidateClocks() {
  lastCheck.clear();
}
