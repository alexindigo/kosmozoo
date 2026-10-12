#!/usr/bin/env bash
# Portable public input contract. Agent workloads still run in their assigned VM.
set -euo pipefail
HERE="$(realpath "$(dirname "$0")")"
exec python3 -B "$HERE/build-core.py" "$@"
