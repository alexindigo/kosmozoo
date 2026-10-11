#!/usr/bin/env bash
# VM-only acceptance entry point. Native Firefox preference changes stay in its
# actual settings UI; phased execution retains the same artifact and witnesses.
set -euo pipefail
HERE="$(realpath "$(dirname "$0")")"
binary= evidence= previous= older_firefox= image_input= phase=core
while (($#)); do
  case "$1" in
    --binary) binary="${2:?}"; shift 2 ;;
    --evidence) evidence="${2:?}"; shift 2 ;;
    --previous-binary) previous="${2:?}"; shift 2 ;;
    --older-firefox) older_firefox="${2:?}"; shift 2 ;;
    --image-input) image_input="${2:?}"; shift 2 ;;
    --phase) phase="${2:?}"; shift 2 ;;
    *) printf 'Unknown acceptance option: %s\n' "$1" >&2; exit 2 ;;
  esac
done
test -n "$binary" && test -n "$evidence"
binary="$(realpath "$binary")"
python3 -B - "$HERE" <<'PY'
import importlib.util,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('runtime_probe',Path(sys.argv[1])/'verify-runtime.py')
probe=importlib.util.module_from_spec(spec);spec.loader.exec_module(probe)
probe.require_vm()
PY
case "$phase" in
  core)
    test -n "$previous" || { printf 'Core acceptance requires --previous-binary for real update/recovery.\n' >&2; exit 2; }
    test -n "$image_input" || { printf 'Core acceptance requires --image-input for the characterized cold runtime.\n' >&2; exit 2; }
    test -d "$(dirname "$evidence")"
    test ! -e "$evidence"
    mkdir -m 700 "$evidence"
    test "$(findmnt -rn -o FSTYPE -T "$evidence")" != tmpfs
    sha256sum "$binary" >"$evidence/binary.sha256"
    for probe in runtime chromium dropins portable abi installer; do
      bash "$HERE/verify-linux.sh" --binary "$binary" --evidence "$evidence" --previous-binary "$previous" --image-input "$image_input" --phase "$probe"
    done
    printf 'LINUX CORE ACCEPTANCE PASS; native Firefox UI phases and finish remain required.\n'
    ;;
  runtime|chromium|dropins|portable|abi|installer)
    test -d "$evidence"
    extra=()
    if [[ "$phase" = portable ]]; then test -n "$image_input"; extra+=(--image-input "$image_input"); fi
    if [[ "$phase" = installer ]]; then test -n "$previous"; extra+=(--previous-binary "$previous"); fi
    test ! -e "$evidence/$phase"
    log="$evidence/$phase.log"
    # A rejected invocation may have logged usage before creating its evidence.
    # Preserve that failure and retain this fresh invocation in another log.
    while test -e "$log"; do log="${log%.log}-retry.log"; done
    python3 -B "$HERE/verify-$phase.py" --binary "$binary" --evidence "$evidence/$phase" "${extra[@]}" 2>&1 | tee "$log"
    ;;
  firefox-setup|firefox-fallback|firefox-settings|firefox-enabled|firefox-handoff|firefox-port-change|firefox-finish)
    test -d "$evidence"
    native_phase="${phase#firefox-}"
    test ! -e "$evidence/$phase.log"
    python3 -B "$HERE/verify-firefox.py" --binary "$binary" --evidence "$evidence/firefox" --phase "$native_phase" 2>&1 | tee "$evidence/$phase.log"
    ;;
  browser-fallbacks)
    test -n "$older_firefox"
    test ! -e "$evidence/browser-fallbacks.log"
    python3 -B "$HERE/verify-browser-fallbacks.py" --binary "$binary" --evidence "$evidence/browser-fallbacks" --session "$evidence/firefox/session.json" --older-firefox "$older_firefox" 2>&1 | tee "$evidence/browser-fallbacks.log"
    ;;
  finish)
    python3 -B - "$binary" "$evidence" <<'PY'
import hashlib,json,sys
from pathlib import Path
binary,run=map(Path,sys.argv[1:])
sha=hashlib.sha256(binary.read_bytes()).hexdigest()
assert (run/'binary.sha256').read_text().split()[0]==sha
markers={
    'runtime':'COMPILED RUNTIME CONSUMER PASS',
    'chromium':'NATIVE CHROMIUM OUTCOMES:',
    'dropins':'COMPILED LOCAL DROP-IN PARITY PASS',
    'portable':'BOOKWORM COLD PORTABILITY AND NATIVE FAILURE OUTCOMES PASS',
    'abi':'MEASURED GNU ELF/ARCH DEPENDENCY CLOSURE PASS:',
    'installer':'NATIVE INSTALLER OUTCOMES PASS',
    'browser-fallbacks':'NATIVE BROWSER FALLBACK OUTCOMES PASS',
    'firefox-fallback':'FIREFOX DISABLED FALLBACK OBSERVED',
    'firefox-enabled':'FIREFOX ENABLED NATIVE OUTCOMES OBSERVED:',
    'firefox-handoff':'FIREFOX PROFILE HANDOFF PASS:',
    'firefox-port-change':'FIREFOX PORT OWNERSHIP PASS:',
    'firefox-finish':'Firefox acceptance engine stopped cleanly',
}
for name,marker in markers.items():
    assert any(marker in log.read_text() for log in run.glob(name+'*.log')),(name,'terminal proof absent')
for name in ['runtime','browser-fallbacks','portable','installer']:
    value=json.loads((run/name/'results.json').read_text())
    assert value['binarySha256']==sha,(name,'wrong artifact')
    assert value['cases'] and all(row['result']=='pass' for row in value['cases']),name
chromium=json.loads((run/'chromium/results.json').read_text())
assert chromium['binarySha256']==sha
assert chromium['runtime']['status']=='ready' and chromium['cookieInode']>0
assert chromium['firstWindow']['title']=='kosmozoo' and chromium['repeatedWindow']['title']=='kosmozoo'
dropins=json.loads((run/'dropins/results.json').read_text())
assert dropins['binarySha256']==sha and dropins['engineExitCode']==0
assert dropins['routes']==[
    {'plugin':'local-js','actual':{'result':'external-relative-module'}},
    {'plugin':'local-ts','actual':{'result':'external-typescript'}},
]
abi=json.loads((run/'abi/abi.json').read_text())
assert abi['files']['binary']['sha256']==sha
native=run/'firefox'
assert json.loads((native/'session.json').read_text())['binarySha256']==sha
for name in ['disabled-result','enabled-result','handoff-result','changed-port-result']:
    assert json.loads((native/(name+'.json')).read_text())['runtime']['status']=='ready',name
assert json.loads((native/'changed-port-result.json').read_text())['binarySha256']==sha
assert 'ExecMainStatus=0' in (native/'engine-final.log').read_text()
assert 'Result=success' in (native/'engine-final.log').read_text()
value={'binarySha256':sha,'functionalAcceptance':'pass','visualReview':'separate capture review required','evidenceRoot':str(run)}
receipt=run/'acceptance.json'
if receipt.exists():
    assert json.loads(receipt.read_text())==value,'Prior acceptance receipt differs; preserved for reconciliation'
else:
    with receipt.open('x') as file:
        json.dump(value,file,indent=2);file.write('\n')
print('LINUX RELEASE ACCEPTANCE PASS')
PY
    ;;
  *) printf 'Unknown acceptance phase: %s\n' "$phase" >&2; exit 2 ;;
esac
