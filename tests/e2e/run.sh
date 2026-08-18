#!/usr/bin/env bash
# tests/e2e/run.sh — orchestrate the browser e2e: fake host + engine + headless
# Chromium (Playwright image). All three run in docker with --network host.
#
#   ./tests/e2e/run.sh
#
# Requires: denoland/deno:latest and mcr.microsoft.com/playwright images.

set -euo pipefail
cd "$(dirname "$0")/../.."
WORK=/home/user/Projects/kosmozoo.dev

FAKE_PORT="${E2E_FAKE_PORT:-18261}"
ENGINE_PORT="${E2E_ENGINE_PORT:-18260}"
PW_IMAGE="${PW_IMAGE:-mcr.microsoft.com/playwright:v1.49.1-noble}"

cleanup() {
  docker rm -f kz-e2e-fake kz-e2e-engine >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

# 1. fake ComfyUI host: fixtures + 3000 synthetic bulk images
docker run -d --name kz-e2e-fake --network host -v "$WORK":/work -w /work \
  denoland/deno:latest run --allow-net --allow-read \
  tests/fake-comfy.mjs --port "$FAKE_PORT" --bulk 3000 >/dev/null

# 2. engine against the fake host, plugins from the repo tier
docker run -d --name kz-e2e-engine --network host -v "$WORK":/work -w /work \
  -e KOZMOZOO_HOSTS="fake=127.0.0.1:$FAKE_PORT" \
  -e KOZMOZOO_PORT="$ENGINE_PORT" \
  -e KOZMOZOO_STATE=/tmp/kz-e2e-state \
  -e KOZMOZOO_FEEDBACK=/tmp/kz-e2e-state/feedback.json \
  -e KOZMOZOO_PLUGINS=/work/plugins \
  denoland/deno:latest run --allow-all src/main.mjs >/dev/null

# wait for both
for url in "http://127.0.0.1:$FAKE_PORT/api/system_stats" "http://127.0.0.1:$ENGINE_PORT/api/hosts"; do
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
