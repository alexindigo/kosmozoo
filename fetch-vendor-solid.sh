#!/usr/bin/env bash
# fetch-vendor-solid.sh — vendor the SolidJS browser runtime + the Solid
# wrapper for the already-vendored @tanstack/virtual-core into client/vendor/.
# Pinned versions; re-run to repair, safe to re-run.
#
# Vendor-time path fix (same pattern as preact's hooks.mjs): the dists import
# each other by bare specifier, which a browser cannot resolve — rewrite those
# to relative paths at fetch time, so the served files are dependency-free ESM.
set -euo pipefail
cd "$(dirname "$0")"

SOLID_V=1.9.15
SOLID_BASE="https://cdn.jsdelivr.net/npm/solid-js@${SOLID_V}"
SV_V=3.13.37
SV_BASE="https://cdn.jsdelivr.net/npm/@tanstack/solid-virtual@${SV_V}"

mkdir -p client/vendor/solid client/vendor/tanstack

# solid-js core runtime (self-contained — no imports)
curl -fSL "${SOLID_BASE}/dist/solid.js" -o client/vendor/solid/solid.mjs

# web bindings: import + export-from 'solid-js' -> ./solid.mjs
curl -fSL "${SOLID_BASE}/web/dist/web.js" -o client/vendor/solid/web.mjs
sed -i "s|from 'solid-js'|from './solid.mjs'|g" client/vendor/solid/web.mjs

# store: import 'solid-js' -> ./solid.mjs
curl -fSL "${SOLID_BASE}/store/dist/store.js" -o client/vendor/solid/store.mjs
sed -i "s|from 'solid-js'|from './solid.mjs'|g" client/vendor/solid/store.mjs

# @tanstack/solid-virtual wraps the vendored virtual-core; bare imports of
# @tanstack/virtual-core, solid-js, solid-js/store -> vendored relatives
curl -fSL "${SV_BASE}/dist/esm/index.js" -o client/vendor/tanstack/solid-virtual.mjs
sed -i \
  -e 's|from "@tanstack/virtual-core"|from "./virtual-core.mjs"|g' \
  -e 's|from "solid-js/store"|from "../solid/store.mjs"|g' \
  -e 's|from "solid-js"|from "../solid/solid.mjs"|g' \
  client/vendor/tanstack/solid-virtual.mjs

# @tanstack/virtual-core and its helpers — the pinned upstream copy the
# Solid wrapper really depends on. Pristine upstream only: a hand edit to
# any vendored file fails tests/t_vendor_pristine.mjs against CHECKSUMS.
curl -fSL "https://cdn.jsdelivr.net/npm/@tanstack/virtual-core@3.17.8/dist/esm/index.js" -o client/vendor/tanstack/virtual-core.mjs
curl -fSL "https://cdn.jsdelivr.net/npm/@tanstack/virtual-core@3.17.8/dist/esm/lazy-measurements.js" -o client/vendor/tanstack/lazy-measurements.js
curl -fSL "https://cdn.jsdelivr.net/npm/@tanstack/virtual-core@3.17.8/dist/esm/utils.js" -o client/vendor/tanstack/utils.js

# the dists' process.env.NODE_ENV references are bundler-build-time
# substitutions; there is no bundler (and no `process`) in the browser —
# substitute the production value once, at vendor time. The checksum
# manifest covers the result: a hand edit to the dist is what the guard
# catches (tests/t_vendor_pristine.mjs).
sed -i 's|process\.env\.NODE_ENV !== "production"|false|g' \
  client/vendor/tanstack/virtual-core.mjs client/vendor/tanstack/utils.js

# checksum manifest — tests/t_vendor_pristine.mjs recomputes and compares;
# regenerated here so the files and their guard always move together.
# Repo-root-relative paths so `sha256sum -c client/vendor/CHECKSUMS` works.
sha256sum \
  client/vendor/solid/solid.mjs client/vendor/solid/web.mjs client/vendor/solid/store.mjs \
  client/vendor/tanstack/solid-virtual.mjs client/vendor/tanstack/virtual-core.mjs \
  client/vendor/tanstack/lazy-measurements.js client/vendor/tanstack/utils.js \
  > client/vendor/CHECKSUMS

# no bare specifiers may survive vendoring
if grep -nE "(from|import)[[:space:]]+['\"][^.]" \
  client/vendor/solid/solid.mjs client/vendor/solid/web.mjs \
  client/vendor/solid/store.mjs client/vendor/tanstack/solid-virtual.mjs \
  client/vendor/tanstack/virtual-core.mjs client/vendor/tanstack/lazy-measurements.js \
  client/vendor/tanstack/utils.js; then
  echo "fetch-vendor-solid: bare specifier survived the path fix" >&2
  exit 1
fi

echo "vendored OK ($(wc -l < client/vendor/CHECKSUMS) files checksummed):"
du -sh client/vendor/solid client/vendor/tanstack
