#!/usr/bin/env bash
# tests/e2e/run.sh — orchestrate the browser e2e: fake host + engine + headless
# Chromium (Playwright image). All three run in docker with --network host.
#
#   ./tests/e2e/run.sh
#
# Requires: denoland/deno:latest and mcr.microsoft.com/playwright images.

set -euo pipefail
cd "$(dirname "$0")/../.."
WORK="$(pwd)"

FAKE_PORT="${E2E_FAKE_PORT:-18261}"
ENGINE_PORT="${E2E_ENGINE_PORT:-18260}"
PW_IMAGE="${PW_IMAGE:-mcr.microsoft.com/playwright:v1.49.1-noble}"
RUN_DIR="$WORK/tests/.tmp-runtime"
# An explicitly supplied cache is caller-owned; only the default is removed.
DENO_CACHE="${E2E_DENO_DIR:-$WORK/tests/.tmp-deno}"
RUN_USER="$(id -u):$(id -g)"

cleanup() {
  # explicit names only — the ONLY sanctioned docker rm. stderr stays
  # visible; the routine "No such container" noise on a clean start is
  # filtered, everything else prints (a failure must be learned from)
  docker rm -f kz-e2e-deps kz-e2e-fake kz-e2e-fake2 kz-e2e-engine kz-e2e-fresh-engine kz-e2e-fresh-install 2>&1 | grep -v "No such container" || true
  rm -rf "$WORK/tests/.tmp-mutable" "$WORK/tests/.tmp-comfy" "$WORK/tests/.tmp-fresh" "$RUN_DIR"
  if [[ -z "${E2E_DENO_DIR:-}" ]]; then rm -rf "$DENO_CACHE"; fi
}
trap cleanup EXIT
cleanup

# One frozen module acquisition for the whole run, before any engine starts.
mkdir -p "$RUN_DIR/tmp" "$RUN_DIR/home" "$DENO_CACHE"
for suite in workbench variations diff cache feed; do
  mkdir -p "$RUN_DIR/$suite/home" "$RUN_DIR/$suite/tmp"
done
DENO_CACHE="$(realpath "$DENO_CACHE")"
chmod 1777 "$RUN_DIR/tmp"
docker run --rm --name kz-e2e-deps --user "$RUN_USER" --network host \
  -v "$WORK":/work -v "$DENO_CACHE":/deno-dir -w /work \
  -e DENO_DIR=/deno-dir -e TMPDIR=/work/tests/.tmp-runtime/tmp \
  denoland/deno:latest task deps
deno_args=(--user "$RUN_USER" -v "$DENO_CACHE":/deno-dir -e DENO_DIR=/deno-dir \
  -e TMPDIR=/work/tests/.tmp-runtime/tmp)

# 0. mutable folder host for the cache-revalidation e2e: a writable copy of a
#    fixture that the spec rewrites in place while the engine is running —
#    plus a writable file served BY THE FAKE COMFYUI host (reused filename,
#    stat-derived ETag)
mkdir -p "$WORK/tests/.tmp-mutable" "$WORK/tests/.tmp-comfy"
cp "$WORK/tests/fixtures/flux-basic.png" "$WORK/tests/.tmp-mutable/flux-basic.png"

# 1. fake ComfyUI host: fixtures + 3000 synthetic bulk images
docker run -d --name kz-e2e-fake --network host -v "$WORK":/work -w /work \
  "${deno_args[@]}" denoland/deno:latest run --frozen --cached-only --allow-net --allow-read \
  tests/fake-comfy.mjs --port "$FAKE_PORT" --bulk 3000 \
  --mutable-dir /work/tests/.tmp-comfy >/dev/null

# 1b. a second fake host (different fixtures dir? same fixtures is fine — the
# point is the host switch reloads the feed from ITS list)
FAKE2_PORT="${E2E_FAKE2_PORT:-18262}"
docker run -d --name kz-e2e-fake2 --network host -v "$WORK":/work -w /work \
  "${deno_args[@]}" denoland/deno:latest run --frozen --cached-only --allow-net --allow-read \
  tests/fake-comfy.mjs --port "$FAKE2_PORT" --bulk 40 >/dev/null

# 2. engine against both fake hosts + a folder host, plugins from the repo tier
#    (revalidate interval shortened so the cache e2e can observe it)
docker run -d --name kz-e2e-engine --network host -v "$WORK":/work -w /work \
  "${deno_args[@]}" \
  -e KOZMOZOO_HOSTS="fake=127.0.0.1:$FAKE_PORT,another=127.0.0.1:$FAKE2_PORT,fixture-dir=folder:/work/tests/fixtures,mut=folder:/work/tests/.tmp-mutable" \
  -e KOZMOZOO_PORT="$ENGINE_PORT" \
  -e KOZMOZOO_STATE=/work/tests/.tmp-runtime/state \
  -e KOZMOZOO_CACHE=/work/tests/.tmp-runtime/cache \
  -e HOME=/work/tests/.tmp-runtime/home \
  -e XDG_CACHE_HOME=/work/tests/.tmp-runtime/xdg-cache \
  -e KOZMOZOO_PLUGINS=/work/plugins \
  -e KOZMOZOO_REVALIDATE_MS=1500 \
  denoland/deno:latest run --frozen --cached-only --allow-all src/main.mjs >/dev/null

# wait for both
for url in "http://127.0.0.1:$FAKE_PORT/api/system_stats" "http://127.0.0.1:$ENGINE_PORT/api/collections"; do
  for i in $(seq 1 60); do
    curl -sf "$url" >/dev/null 2>&1 && break
    sleep 0.5
    [ "$i" = 60 ] && { echo "timeout waiting for $url"; docker logs kz-e2e-engine | tail -5; exit 1; }
  done
done

# 2b. two-pass prefetch (§4.2): the browser suites must test the feed, not
#     the prefetch rate — wait for the dims pass to drain (~40 s for 3000).
#     A timeout FAILS the run — proceeding would test the wrong thing.
for i in $(seq 1 240); do
  [ "$(curl -s "http://127.0.0.1:$ENGINE_PORT/api/prefetch" | jq -r '.dimsPending // 1')" = "0" ] && break
  sleep 1
done
[ "$(curl -s "http://127.0.0.1:$ENGINE_PORT/api/prefetch" | jq -r '.dimsPending // 1')" = "0" ] || {
  echo "dims pass did not drain in 240 s — refusing to test the prefetch rate instead of the feed"
  docker logs kz-e2e-engine | tail -5
  exit 1
}

# 3. headless Chromium drives the SPA — raw CDP, no npm dependencies.
#    The Playwright image supplies the browser; Node 22 supplies WebSocket.
docker run --rm --user "$RUN_USER" --network host -v "$WORK":/work -w /work \
  -e HOME=/work/tests/.tmp-runtime/workbench/home -e TMPDIR=/work/tests/.tmp-runtime/workbench/tmp \
  -e E2E_ENGINE="http://127.0.0.1:$ENGINE_PORT" \
  -e E2E_FAKE="http://127.0.0.1:$FAKE_PORT" \
  --entrypoint node "$PW_IMAGE" \
  /work/tests/e2e/workbench.e2e.cjs

# 4. variations panel e2e
docker run --rm --user "$RUN_USER" --network host -v "$WORK":/work -w /work \
  -e HOME=/work/tests/.tmp-runtime/variations/home -e TMPDIR=/work/tests/.tmp-runtime/variations/tmp \
  -e E2E_ENGINE="http://127.0.0.1:$ENGINE_PORT" \
  -e E2E_FAKE="http://127.0.0.1:$FAKE_PORT" \
  --entrypoint node "$PW_IMAGE" \
  /work/tests/e2e/variations.e2e.cjs

# 5. /diff comparison view e2e
docker run --rm --user "$RUN_USER" --network host -v "$WORK":/work -w /work \
  -e HOME=/work/tests/.tmp-runtime/diff/home -e TMPDIR=/work/tests/.tmp-runtime/diff/tmp \
  -e E2E_ENGINE="http://127.0.0.1:$ENGINE_PORT" \
  -e E2E_FAKE="http://127.0.0.1:$FAKE_PORT" \
  --entrypoint node "$PW_IMAGE" \
  /work/tests/e2e/diff.e2e.cjs

# 6. cache revalidation e2e (pure HTTP — no browser involved)
docker run --rm --user "$RUN_USER" --network host -v "$WORK":/work -w /work \
  -e HOME=/work/tests/.tmp-runtime/cache/home -e TMPDIR=/work/tests/.tmp-runtime/cache/tmp \
  -e E2E_ENGINE="http://127.0.0.1:$ENGINE_PORT" \
  --entrypoint node "$PW_IMAGE" \
  /work/tests/e2e/cache.e2e.cjs

# 7. feed invariant e2e (§3.5): exact card heights, stable tops
docker run --rm --user "$RUN_USER" --network host -v "$WORK":/work -w /work \
  -e HOME=/work/tests/.tmp-runtime/feed/home -e TMPDIR=/work/tests/.tmp-runtime/feed/tmp \
  -e E2E_ENGINE="http://127.0.0.1:$ENGINE_PORT" \
  -e E2E_FAKE="http://127.0.0.1:$FAKE_PORT" \
  --entrypoint node "$PW_IMAGE" \
  /work/tests/e2e/feed.e2e.cjs

# 8. fresh install: no source seed, then one unreachable source across retries.
FRESH_ENGINE_PORT="${E2E_FRESH_ENGINE_PORT:-18263}"
FRESH_USER="$RUN_USER"
timeout 30s mkdir -p "$WORK/tests/.tmp-fresh/tmp" "$WORK/tests/.tmp-fresh/home"
timeout 30s chmod 1777 "$WORK/tests/.tmp-fresh/tmp"
timeout 30s docker run -d --name kz-e2e-fresh-engine --user "$FRESH_USER" --network host -v "$WORK":/work -w /work \
  -v "$DENO_CACHE":/deno-dir \
  -e KOZMOZOO_PORT="$FRESH_ENGINE_PORT" \
  -e KOZMOZOO_STATE=/work/tests/.tmp-fresh/state \
  -e KOZMOZOO_CACHE=/work/tests/.tmp-fresh/cache \
  -e KOZMOZOO_PLUGINS=/work/plugins \
  -e HOME=/work/tests/.tmp-fresh/home -e DENO_DIR=/deno-dir \
  -e TMPDIR=/work/tests/.tmp-fresh/tmp \
  denoland/deno:latest run --frozen --cached-only --allow-all src/main.mjs >/dev/null

for i in $(seq 1 60); do
  timeout 5s curl -sf "http://127.0.0.1:$FRESH_ENGINE_PORT/api/collections" >/dev/null 2>&1 && break
  sleep 0.5
  [ "$i" = 60 ] && {
    echo "timeout waiting for fresh engine"
    timeout 15s docker logs kz-e2e-fresh-engine
    exit 1
  }
done

timeout 180s docker run --rm --name kz-e2e-fresh-install --user "$FRESH_USER" --network host -v "$WORK":/work -w /work \
  -e E2E_ENGINE="http://127.0.0.1:$FRESH_ENGINE_PORT" \
  -e E2E_FRESH_WAIT_MS=60000 -e E2E_UNREACHABLE=1 \
  -e HOME=/work/tests/.tmp-fresh/home -e TMPDIR=/work/tests/.tmp-fresh/tmp \
  --entrypoint node "$PW_IMAGE" \
  /work/tests/e2e/fresh-install.e2e.cjs
