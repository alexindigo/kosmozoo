#!/usr/bin/env bash
# Run inside the authorized test VM: the engine comes entirely from the image.
set -euo pipefail
WORK="$(realpath "$(dirname "$0")/../..")"
FAKE_PORT="${E2E_FAKE_PORT:-18261}"
FAKE2_PORT="${E2E_FAKE2_PORT:-18262}"
ENGINE_PORT="${E2E_ENGINE_PORT:-18260}"
PW_IMAGE="${PW_IMAGE:-mcr.microsoft.com/playwright:v1.49.1-noble}"
IMAGE="$(docker image inspect --format '{{.Id}}' "${KOSMOZOO_IMAGE:-kosmozoo:local}")"
EVIDENCE="${E2E_IMAGE_EVIDENCE:-$HOME/kosmozoo-container-evidence}"
test -d "$EVIDENCE" && test -w "$EVIDENCE"
test "$(findmnt -rn -o FSTYPE -T "$EVIDENCE")" != tmpfs
systemd-detect-virt --vm >/dev/null
RUN="$(mktemp -d "$EVIDENCE/e2e-XXXXXXXX")"
mkdir "$RUN/mutable" "$RUN/comfy" "$RUN/tmp"
export TMPDIR="$RUN/tmp"
cp "$WORK/tests/fixtures/flux-basic.png" "$RUN/mutable/flux-basic.png"
STATE="kz-e2e-image-state-${RUN##*/}"
CACHE="kz-e2e-image-cache-${RUN##*/}"
containers=()
volumes=()

cleanup() {
  local status=$?
  trap - EXIT
  if [[ " ${containers[*]} " == *" kz-e2e-engine "* ]]; then
    docker logs kz-e2e-engine >"$RUN/engine.log" 2>&1 || status=1
    docker inspect kz-e2e-engine >"$RUN/engine-final.json" || status=1
  fi
  for name in "${containers[@]}"; do
    docker rm -f "$name" || status=1
  done
  if [ "$status" = 0 ]; then
    for name in "${volumes[@]}"; do docker volume rm "$name" || status=1; done
  fi
  printf 'image e2e evidence: %s\n' "$RUN"
  exit "$status"
}
trap cleanup EXIT

# Fail before launch rather than removing somebody else's test resources.
existing="$(docker ps -a --format '{{.Names}}')"
for name in kz-e2e-fake kz-e2e-fake2 kz-e2e-engine \
  kz-e2e-image-workbench kz-e2e-image-variations kz-e2e-image-diff kz-e2e-image-cache kz-e2e-image-feed; do
  if [[ $'\n'"$existing"$'\n' == *$'\n'"$name"$'\n'* ]]; then
    printf 'test container is occupied: %s\n' "$name" >&2
    exit 1
  fi
done
python - "$FAKE_PORT" "$FAKE2_PORT" "$ENGINE_PORT" <<'PY'
import socket,sys
for port in map(int,sys.argv[1:]):
    with socket.socket() as probe:
        probe.bind(('127.0.0.1',port))
PY
for name in "$STATE" "$CACHE"; do
  docker volume create "$name" >/dev/null
  volumes+=("$name")
done
docker image inspect "$IMAGE" >"$RUN/image.json"

launch() {
  local name=$1
  shift
  # Own the created container before starting it: runc failures also clean up.
  docker create --name "$name" "$@" >/dev/null
  containers+=("$name")
  docker start "$name" >/dev/null
}

launch kz-e2e-fake --network host \
  -v "$WORK":/work -v "$RUN/comfy":/work/tests/.tmp-comfy:ro -w /work \
  docker.io/denoland/deno:latest run --allow-net --allow-read \
  tests/fake-comfy.mjs --port "$FAKE_PORT" --bulk 3000 \
  --mutable-dir /work/tests/.tmp-comfy
launch kz-e2e-fake2 --network host -v "$WORK":/work -w /work \
  docker.io/denoland/deno:latest run --allow-net --allow-read \
  tests/fake-comfy.mjs --port "$FAKE2_PORT" --bulk 40

# Fixture-only binds; no application source, dist, plugins or configuration bind.
launch kz-e2e-engine --network host \
  --mount "type=volume,src=$STATE,dst=/data/state" \
  --mount "type=volume,src=$CACHE,dst=/data/cache" \
  --mount "type=bind,src=$WORK/tests/fixtures,dst=/work/tests/fixtures,readonly" \
  --mount "type=bind,src=$RUN/mutable,dst=/work/tests/.tmp-mutable,readonly" \
  -e KOZMOZOO_HOSTS="fake=127.0.0.1:$FAKE_PORT,another=127.0.0.1:$FAKE2_PORT,fixture-dir=folder:/work/tests/fixtures,mut=folder:/work/tests/.tmp-mutable" \
  -e KOZMOZOO_PORT="$ENGINE_PORT" -e KOZMOZOO_REVALIDATE_MS=1500 "$IMAGE"
docker inspect kz-e2e-engine >"$RUN/engine-start.json"
jq -e --arg image "$IMAGE" --arg fixtures "$WORK/tests/fixtures" --arg mutable "$RUN/mutable" '
  .[0] | .Image == $image and (.Mounts | length == 4) and
  (.Mounts | all(
    (.Type == "volume" and (.Destination == "/data/state" or .Destination == "/data/cache")) or
    (.Type == "bind" and .RW == false and
      ((.Source == $fixtures and .Destination == "/work/tests/fixtures") or
       (.Source == $mutable and .Destination == "/work/tests/.tmp-mutable")))))
' "$RUN/engine-start.json" >/dev/null
test "$(docker exec kz-e2e-engine id -u)" = 1000

wait_url() {
  for i in $(seq 1 60); do
    if curl -fsS "$1" >/dev/null 2>&1; then return; fi
    sleep 0.5
  done
  printf 'timeout waiting for %s\n' "$1" >&2
  docker logs kz-e2e-engine >&2
  return 1
}
wait_url "http://127.0.0.1:$FAKE_PORT/api/system_stats"
wait_url "http://127.0.0.1:$FAKE2_PORT/api/system_stats"
wait_url "http://127.0.0.1:$ENGINE_PORT/api/collections"
for i in $(seq 1 240); do
  if [ "$(curl -fsS "http://127.0.0.1:$ENGINE_PORT/api/prefetch" | jq -r '.dimsPending')" = 0 ]; then break; fi
  sleep 1
done
test "$(curl -fsS "http://127.0.0.1:$ENGINE_PORT/api/prefetch" | jq -r '.dimsPending')" = 0

for suite in workbench variations diff cache feed; do
  launch "kz-e2e-image-$suite" --network host \
    -v "$WORK":/work -v "$RUN/mutable":/work/tests/.tmp-mutable \
    -v "$RUN/comfy":/work/tests/.tmp-comfy -w /work \
    -e E2E_ENGINE="http://127.0.0.1:$ENGINE_PORT" \
    -e E2E_FAKE="http://127.0.0.1:$FAKE_PORT" --entrypoint node "$PW_IMAGE" \
    "/work/tests/e2e/$suite.e2e.cjs"
  docker logs -f "kz-e2e-image-$suite" 2>&1 | tee "$RUN/$suite.log"
  test "$(docker wait "kz-e2e-image-$suite")" = 0
done
docker logs kz-e2e-engine >"$RUN/engine.log" 2>&1
if grep -E 'register failed|kz\.exporter' "$RUN/engine.log"; then exit 1; fi
docker stop --timeout 30 kz-e2e-engine
test "$(docker inspect --format '{{.State.ExitCode}}' kz-e2e-engine)" = 0
test "$(docker inspect --format '{{.State.OOMKilled}}' kz-e2e-engine)" = false
printf 'IMAGE E2E: packaged engine, data-only mounts, uid 1000, five suites and graceful shutdown PASS\n'
