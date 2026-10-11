#!/usr/bin/env bash
set -euo pipefail
exec python3 -B "$(realpath "$(dirname "$0")")/verify-deployed-readonly.py" "$@"
