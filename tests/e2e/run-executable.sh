#!/usr/bin/env bash
# The engine is the actual compiled binary; source binds belong to fake/driver
# containers only. All workloads execute in the authorized release VM.
set -euo pipefail
WORK="$(realpath "$(dirname "$0")/../..")"
systemd-detect-virt --vm >/dev/null
test "$(sudo -n /usr/bin/cat /sys/class/dmi/id/product_uuid | tr 'A-Z' 'a-z')" = 838fd0e0-e75a-4b21-9ada-8dad6562b151
BINARY="$(realpath "${1:?Supply the actual compiled executable}")"
test -x "$BINARY"
test -d "${EVIDENCE:?Supply the private disk-backed guest evidence directory}"
test "$(findmnt -rn -o FSTYPE -T "$EVIDENCE")" != tmpfs
RUN="$(mktemp -d "$EVIDENCE/executable-e2e-XXXXXXXX")"
mkdir -m 700 "$RUN/state" "$RUN/cache" "$RUN/tmp" "$RUN/home" "$RUN/mutable" "$RUN/comfy" "$RUN/shots" "$RUN/browser-tmp"
# Browser consumers own temporary downloads beneath /work/tests. Give them a
# verified writable snapshot, not write access to the source being packaged.
python3 - "$WORK/tests" "$RUN/driver-tests" "$RUN/driver-test-input.json" <<'PY'
import hashlib,json,os,shutil,sys
from pathlib import Path
source,destination,manifest=map(Path,sys.argv[1:])
destination.mkdir(mode=0o700)
rows=[]
for parent,dirs,files in os.walk(source):
    dirs[:]=sorted(name for name in dirs if name!='.shots' and not name.startswith('.tmp'))
    relative=Path(parent).relative_to(source)
    target=destination/relative
    target.mkdir(parents=True,exist_ok=True)
    for name in sorted(files):
        if name.endswith('.bak'): continue
        original=Path(parent)/name
        if original.is_symlink(): raise RuntimeError(f'Unexpected test-source symlink: {original}')
        copied=target/name
        shutil.copy2(original,copied)
        digest=hashlib.sha256(original.read_bytes()).hexdigest()
        if hashlib.sha256(copied.read_bytes()).hexdigest()!=digest:
            raise RuntimeError(f'Test copy differs: {original}')
        rows.append({'path':str(relative/name),'sha256':digest,'mode':oct(original.stat().st_mode&0o777)})
manifest.write_text(json.dumps({'version':1,'files':sorted(rows,key=lambda row:row['path'])},indent=2)+'\n')
PY
# Fake-host and browser snapshots supply their own nested mountpoints. The
# compiled engine still receives only the binary and data/fixture binds below.
mkdir -p "$WORK/tests/.tmp-comfy" "$RUN/driver-tests/.tmp-comfy" "$RUN/driver-tests/.tmp-mutable" "$RUN/driver-tests/e2e/.shots"
export TMPDIR="$RUN/tmp"
cp "$WORK/tests/fixtures/flux-basic.png" "$RUN/mutable/flux-basic.png"
FAKE_PORT="${E2E_FAKE_PORT:-18261}"
FAKE2_PORT="${E2E_FAKE2_PORT:-18262}"
ENGINE_PORT="${E2E_ENGINE_PORT:-18260}"
DENO_IMAGE=sha256:fa335acdf6b72106eda2cb6a8cb5f4187e7630e357467489db4b2e7352d5e432
PW_IMAGE=sha256:70e367e0cbf60340a5b5fd562f6247a34eb3196efab9f88a3dd56482d9fe09d2
RUNTIME_IMAGE="${KOSMOZOO_EXECUTABLE_RUNTIME_IMAGE:-$DENO_IMAGE}"
RUNTIME_IMAGE="$(docker image inspect --format '{{.Id}}' "$RUNTIME_IMAGE")"
containers=()
cleanup() {
  local status=$?
  trap - EXIT
  if [[ " ${containers[*]} " == *" kz-e2e-executable-engine "* ]]; then
    docker logs kz-e2e-executable-engine >"$RUN/engine.log" 2>&1 || status=1
    docker stop --timeout 30 kz-e2e-executable-engine || status=1
    docker inspect kz-e2e-executable-engine >"$RUN/engine-final.json" || status=1
    test "$(docker inspect --format '{{.State.ExitCode}}' kz-e2e-executable-engine)" = 0 || status=1
  fi
  for name in "${containers[@]}"; do docker rm -f "$name" || status=1; done
  printf 'executable e2e evidence: %s\n' "$RUN"
  exit "$status"
}
trap cleanup EXIT
existing="$(docker ps -a --format '{{.Names}}')"
for name in kz-e2e-executable-fake kz-e2e-executable-fake2 kz-e2e-executable-engine \
  kz-e2e-executable-workbench kz-e2e-executable-variations kz-e2e-executable-diff kz-e2e-executable-cache kz-e2e-executable-feed; do
  if [[ $'\n'"$existing"$'\n' == *$'\n'"$name"$'\n'* ]]; then
    printf 'test container is occupied: %s\n' "$name" >&2
    exit 1
  fi
done
python3 - "$FAKE_PORT" "$FAKE2_PORT" "$ENGINE_PORT" <<'PY'
import socket,sys
for port in map(int,sys.argv[1:]):
    with socket.socket() as probe:
        probe.bind(('127.0.0.1',port))
PY
sha256sum "$BINARY" >"$RUN/binary.sha256"
docker image inspect "$RUNTIME_IMAGE" "$DENO_IMAGE" "$PW_IMAGE" >"$RUN/images.json"
launch() {
  local name=$1
  shift
  docker create --pull=never --name "$name" "$@" >/dev/null
  containers+=("$name")
  docker start "$name" >/dev/null
}
launch kz-e2e-executable-fake --network host \
  -v "$WORK":/work:ro -v "$RUN/comfy":/work/tests/.tmp-comfy:ro -w /work \
  "$DENO_IMAGE" run --allow-net --allow-read tests/fake-comfy.mjs \
  --port "$FAKE_PORT" --bulk 3000 --mutable-dir /work/tests/.tmp-comfy
launch kz-e2e-executable-fake2 --network host -v "$WORK":/work:ro -w /work \
  "$DENO_IMAGE" run --allow-net --allow-read tests/fake-comfy.mjs --port "$FAKE2_PORT" --bulk 40
launch kz-e2e-executable-engine --network host --user 1000:1000 -w /data/home \
  --entrypoint /artifact/kosmozoo \
  --mount "type=bind,src=$BINARY,dst=/artifact/kosmozoo,readonly" \
  --mount "type=bind,src=$RUN/state,dst=/data/state" \
  --mount "type=bind,src=$RUN/cache,dst=/data/cache" \
  --mount "type=bind,src=$RUN/tmp,dst=/data/tmp" \
  --mount "type=bind,src=$RUN/home,dst=/data/home" \
  --mount "type=bind,src=$WORK/tests/fixtures,dst=/work/tests/fixtures,readonly" \
  --mount "type=bind,src=$RUN/mutable,dst=/work/tests/.tmp-mutable,readonly" \
  -e HOME=/data/home -e TMPDIR=/data/tmp -e KOZMOZOO_STATE=/data/state -e KOZMOZOO_CACHE=/data/cache \
  -e KOZMOZOO_HOSTS="fake=127.0.0.1:$FAKE_PORT,another=127.0.0.1:$FAKE2_PORT,fixture-dir=folder:/work/tests/fixtures,mut=folder:/work/tests/.tmp-mutable" \
  -e KOZMOZOO_PORT="$ENGINE_PORT" -e KOZMOZOO_REVALIDATE_MS=1500 "$RUNTIME_IMAGE" serve
docker inspect kz-e2e-executable-engine >"$RUN/engine-start.json"
jq -e --arg binary "$BINARY" --arg fixtures "$WORK/tests/fixtures" --arg mutable "$RUN/mutable" --arg run "$RUN" '
  .[0] | .Config.User == "1000:1000" and .Config.Entrypoint == ["/artifact/kosmozoo"] and
  .Config.Cmd == ["serve"] and (.Mounts | length == 7) and (.Mounts | all(.Type == "bind" and
    ((.Source == $binary and .Destination == "/artifact/kosmozoo" and .RW == false) or
     (.Source == $fixtures and .Destination == "/work/tests/fixtures" and .RW == false) or
     (.Source == $mutable and .Destination == "/work/tests/.tmp-mutable" and .RW == false) or
     (.Source == ($run + "/state") and .Destination == "/data/state") or
     (.Source == ($run + "/cache") and .Destination == "/data/cache") or
     (.Source == ($run + "/home") and .Destination == "/data/home") or
     (.Source == ($run + "/tmp") and .Destination == "/data/tmp"))))
' "$RUN/engine-start.json" >/dev/null
wait_url() {
  for i in $(seq 1 60); do
    if curl -fsS "$1" >/dev/null 2>&1; then return; fi
    sleep 0.5
  done
  printf 'timeout waiting for %s\n' "$1" >&2
  docker logs kz-e2e-executable-engine >&2
  return 1
}
wait_url "http://127.0.0.1:$FAKE_PORT/api/system_stats"
wait_url "http://127.0.0.1:$FAKE2_PORT/api/system_stats"
wait_url "http://127.0.0.1:$ENGINE_PORT/api/runtime"
curl -fsS "http://127.0.0.1:$ENGINE_PORT/api/runtime" >"$RUN/runtime.json"
jq -e --argjson port "$ENGINE_PORT" '.mode == "serve" and .status == "ready" and .binding == {hostname:"0.0.0.0",port:$port}' "$RUN/runtime.json" >/dev/null
for i in $(seq 1 240); do
  if [ "$(curl -fsS "http://127.0.0.1:$ENGINE_PORT/api/prefetch" | jq -r '.dimsPending')" = 0 ]; then break; fi
  sleep 1
done
test "$(curl -fsS "http://127.0.0.1:$ENGINE_PORT/api/prefetch" | jq -r '.dimsPending')" = 0
for suite in workbench variations diff cache feed; do
  # Browser subprocesses need sticky temp permissions across process identities.
  # The parent evidence tree and engine data stay private.
  # Separate suites retain fresh browser state; every CDP profile port and
  # temporary file is backed by disk without changing helper paths/arguments.
  mkdir -m 1777 "$RUN/browser-tmp/$suite"
  launch "kz-e2e-executable-$suite" --network host \
    -v "$WORK":/work:ro -v "$RUN/driver-tests":/work/tests \
    -v "$RUN/mutable":/work/tests/.tmp-mutable \
    -v "$RUN/comfy":/work/tests/.tmp-comfy -v "$RUN/shots":/work/tests/e2e/.shots \
    -v "$RUN/browser-tmp/$suite":/evidence-tmp -v "$RUN/browser-tmp/$suite":/tmp \
    -e TMPDIR=/evidence-tmp -w /work \
    -e E2E_ENGINE="http://127.0.0.1:$ENGINE_PORT" -e E2E_FAKE="http://127.0.0.1:$FAKE_PORT" \
    --entrypoint node "$PW_IMAGE" "/work/tests/e2e/$suite.e2e.cjs"
  docker logs -f "kz-e2e-executable-$suite" 2>&1 | tee "$RUN/$suite.log"
  test "$(docker wait "kz-e2e-executable-$suite")" = 0
done
docker stop --timeout 30 kz-e2e-executable-engine
test "$(docker inspect --format '{{.State.ExitCode}}' kz-e2e-executable-engine)" = 0
test "$(docker inspect --format '{{.State.OOMKilled}}' kz-e2e-executable-engine)" = false
printf 'EXECUTABLE E2E PASS\n'
