#!/usr/bin/env bash
# tests/e2e/diagnose.sh — capture the live engine's feed at several
# viewport sizes and scroll positions, so CSS/layout claims can be
# verified visually before shipping.
#
# Screenshots + layout JSON land in $OUT (default /tmp/kz-diagnose on the
# host, mounted into the browser container as /diagnose). Read the PNGs.

set -euo pipefail

WORK="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${DIAGNOSE_OUT:-/tmp/kz-diagnose}"
URL="${DIAGNOSE_URL:-http://127.0.0.1:2085}"
PW_IMAGE="${PW_IMAGE:-mcr.microsoft.com/playwright:v1.49.1-noble}"

mkdir -p "$OUT"
# Wipe previous run so the folder shows only this run's output
rm -f "$OUT"/viewport-*.png "$OUT"/layout-*.json "$OUT"/summary-*.json

echo "diagnose: engine=$URL out=$OUT"
docker run --rm --network host \
  -v "$WORK":/work -v "$OUT":/diagnose -w /work \
  -e DIAGNOSE_URL="$URL" \
  -e DIAGNOSE_OUT=/diagnose \
  --entrypoint node "$PW_IMAGE" \
  /work/tests/e2e/feed-diagnose.cjs

echo
echo "output in $OUT:"
ls -1 "$OUT" | sort
