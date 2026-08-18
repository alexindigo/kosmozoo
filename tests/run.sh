#!/usr/bin/env bash
# tests/run.sh — the test runner. All tests are Deno; run them in the
# devcontainer (or any Deno 2 environment).
#
#   ./tests/run.sh            # run the whole suite
#   ./tests/run.sh t_fake     # run tests matching a filter
#
# Synthetic fixtures are (re)generated if tests/fixtures is empty; drop real
# stripped PNGs in there to extend coverage.

set -euo pipefail
cd "$(dirname "$0")/.."

if [ -z "$(ls -A tests/fixtures 2>/dev/null)" ]; then
  deno run --allow-read --allow-write tests/make-synthetic-fixtures.mjs
fi

FILTER="${1:-}"
deno test --allow-all ${FILTER:+--filter "$FILTER"} tests/t_*.mjs
