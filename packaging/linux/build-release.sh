#!/usr/bin/env bash
# Build workloads run only inside the explicitly identified release VM.
set -euo pipefail
SOURCE="$(realpath "$(dirname "$0")/../..")"
systemd-detect-virt --vm >/dev/null
test "$(sudo -n /usr/bin/cat /sys/class/dmi/id/product_uuid | tr 'A-Z' 'a-z')" = 838fd0e0-e75a-4b21-9ada-8dad6562b151
test -n "${EVIDENCE:?Set the private disk-backed guest evidence directory}"
test -d "$EVIDENCE" && test -w "$EVIDENCE"
test "$(findmnt -rn -o FSTYPE -T "$EVIDENCE")" != tmpfs
python3 -B "$SOURCE/packaging/linux/build-release.py" "$@"
