#!/usr/bin/env bash
# The original strict VM guard is shared by the release consumers.
set -euo pipefail
HERE="$(realpath "$(dirname "$0")")"
exec python3 -B "$HERE/verify-image.py" "$@"
