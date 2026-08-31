// src/revalidate.mjs — stale-while-revalidate for EVERY host kind.
//
// Bytes ALWAYS serve from the cache — a request never waits on the source.
// But at most once per REVALIDATE_MS per file, a request also fires an
// async stamp check: has the source file's content changed under the same
// name (folder mtime / ComfyUI ETag)? ComfyUI reuses filenames, so no host
// kind is exempt. Changed → re-read, re-hash, re-cache, remap. The request
// that triggered the check already got the previous bytes; the next one
// gets the fresh ones. Meta and judgments are keyed by hash, so the new
// content starts clean and the old content keeps its history — nothing to
// migrate.
//
// The { input: true } variant revalidates input-dir rows (input_cache) the
// same way; its debounce keys are prefixed so input and output checks for
// the same file never suppress each other.

import { hostStamp, hostReadBytes, hostInputBytes } from "./hosts.mjs";
import { sha256, cachePut } from "./cache.mjs";

const DEFAULT_MS = 60_000;

// Read fresh each time (env is the test seam; the read is cheap).
function revalidateMs() {
  const raw = Deno.env.get("KOZMOZOO_REVALIDATE_MS");
  return raw ? Math.max(1, Number(raw)) : DEFAULT_MS;
}

const lastCheck = new Map(); // (in:)?host:filename -> Date.now() of last check

// Fire a debounced async revalidation. Never blocks, never throws.
export function scheduleRevalidate(ctx, host, filename, { input = false } = {}) {
  if (!ctx.hosts[host]) return;
  const key = `${input ? "in:" : ""}${host}:${filename}`;
  const now = Date.now();
  if (now - (lastCheck.get(key) ?? 0) < revalidateMs()) return;
  lastCheck.set(key, now);
  revalidateNow(ctx, host, filename, { input }).catch(() => {});
}

// The check itself (exported for tests): compare the source stamp against
// the recorded one; on mismatch re-read and remap. Same content with a
// newer stamp (a touch) only refreshes the stamp.
export async function revalidateNow(ctx, host, filename, { input = false } = {}) {
  const addr = ctx.hosts[host];
  if (!addr) return;
  const stamp = await hostStamp(addr, filename, input ? "input" : "output");
  if (stamp == null) return; // gone/unreachable or no stamp seam — keep what we have

  if (input) {
    const row = ctx.store.inputCacheGet(host, filename);
    if (!row || row.stamp === stamp) return; // nothing recorded, or unchanged
    const r = await hostInputBytes(addr, filename);
    if (r.status !== 200) return; // unreadable right now — keep what we have
    const bytes = new Uint8Array(await new Response(r.body).arrayBuffer());
    const hash = await sha256(bytes);
    if (hash !== row.hash) await cachePut(hash, bytes);
    ctx.store.inputCachePut(host, filename, hash, stamp);
    return;
  }

  const info = ctx.store.fileInfo(host, filename);
  if (info?.stamp != null && stamp === info.stamp) return; // unchanged

  const r = await hostReadBytes(addr, filename);
  if (r.status !== 200) return; // unreadable right now — keep what we have
  const bytes = new Uint8Array(await new Response(r.body).arrayBuffer());
  const hash = await sha256(bytes);
  if (info?.hash === hash) {
    ctx.store.touchFileStamp(host, filename, stamp);
    return;
  }
  await cachePut(hash, bytes);
  await ctx.store.ingestFile(host, filename, hash, bytes.length, {
    stamp,
    changed: !!info?.hash,
  });
}

// test seam
export function __resetRevalidateClocks() {
  lastCheck.clear();
}
