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

cleanup() {
  docker rm -f kz-e2e-fake kz-e2e-fake2 kz-e2e-engine >/dev/null 2>&1 || true
  rm -rf "$WORK/tests/.tmp-mutable" "$WORK/tests/.tmp-comfy"
}
trap cleanup EXIT
cleanup

# 0. mutable folder host for the cache-revalidation e2e: a writable copy of a
#    fixture that the spec rewrites in place while the engine is running —
#    plus a writable file served BY THE FAKE COMFYUI host (reused filename,
#    stat-derived ETag)
mkdir -p "$WORK/tests/.tmp-mutable" "$WORK/tests/.tmp-comfy"
cp "$WORK/tests/fixtures/flux-basic.png" "$WORK/tests/.tmp-mutable/flux-basic.png"

# 1. fake ComfyUI host: fixtures + 3000 synthetic bulk images
docker run -d --name kz-e2e-fake --network host -v "$WORK":/work -w /work \
  denoland/deno:latest run --allow-net --allow-read \
  tests/fake-comfy.mjs --port "$FAKE_PORT" --bulk 3000 \
  --mutable-dir /work/tests/.tmp-comfy >/dev/null

# 1b. a second fake host (different fixtures dir? same fixtures is fine — the
# point is the host switch reloads the feed from ITS list)
FAKE2_PORT="${E2E_FAKE2_PORT:-18262}"
docker run -d --name kz-e2e-fake2 --network host -v "$WORK":/work -w /work \
  denoland/deno:latest run --allow-net --allow-read \
  tests/fake-comfy.mjs --port "$FAKE2_PORT" --bulk 40 >/dev/null

# 2. engine against both fake hosts + a folder host, plugins from the repo tier
#    (revalidate interval shortened so the cache e2e can observe it)
docker run -d --name kz-e2e-engine --network host -v "$WORK":/work -w /work \
  -e KOZMOZOO_HOSTS="fake=127.0.0.1:$FAKE_PORT,another=127.0.0.1:$FAKE2_PORT,fixture-dir=folder:/work/tests/fixtures,mut=folder:/work/tests/.tmp-mutable" \
  -e KOZMOZOO_PORT="$ENGINE_PORT" \
  -e KOZMOZOO_STATE=/tmp/kz-e2e-state \
  -e KOZMOZOO_PLUGINS=/work/plugins \
  -e KOZMOZOO_REVALIDATE_MS=1500 \
  denoland/deno:latest run --allow-all src/main.mjs >/dev/null

# wait for both
for url in "http://127.0.0.1:$FAKE_PORT/api/system_stats" "http://127.0.0.1:$ENGINE_PORT/api/collections"; do
  for i in $(seq 1 60); do
    curl -sf "$url" >/dev/null 2>&1 && break
    sleep 0.5
    [ "$i" = 60 ] && { echo "timeout waiting for $url"; docker logs kz-e2e-engine | tail -5; exit 1; }
  done
done

# 3. headless Chromium drives the SPA — raw CDP, no npm dependencies.
#    The Playwright image supplies the browser; Node 22 supplies WebSocket.
docker run --rm --network host -v "$WORK":/work -w /work \
  -e E2E_ENGINE="http://127.0.0.1:$ENGINE_PORT" \
  -e E2E_FAKE="http://127.0.0.1:$FAKE_PORT" \
  --entrypoint node "$PW_IMAGE" \
  /work/tests/e2e/workbench.e2e.cjs

# 4. variations panel e2e
docker run --rm --network host -v "$WORK":/work -w /work \
  -e E2E_ENGINE="http://127.0.0.1:$ENGINE_PORT" \
  -e E2E_FAKE="http://127.0.0.1:$FAKE_PORT" \
  --entrypoint node "$PW_IMAGE" \
  /work/tests/e2e/variations.e2e.cjs

# 5. /diff comparison view e2e
docker run --rm --network host -v "$WORK":/work -w /work \
  -e E2E_ENGINE="http://127.0.0.1:$ENGINE_PORT" \
  -e E2E_FAKE="http://127.0.0.1:$FAKE_PORT" \
  --entrypoint node "$PW_IMAGE" \
  /work/tests/e2e/diff.e2e.cjs

# 6. cache revalidation e2e (pure HTTP — no browser involved)
docker run --rm --network host -v "$WORK":/work -w /work \
  -e E2E_ENGINE="http://127.0.0.1:$ENGINE_PORT" \
  --entrypoint node "$PW_IMAGE" \
  /work/tests/e2e/cache.e2e.cjs
