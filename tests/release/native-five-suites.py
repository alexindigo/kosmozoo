#!/usr/bin/env python3
"""All unchanged browser/fake witnesses against an actual native executable."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import urllib.request

import publication_vm as vm


def fixture_dimensions_ready(entries, prefetch):
    bulk = [entry for entry in entries if entry['name'].startswith('bulk-')]
    return len(bulk) == 3000 and all(entry['width'] and entry['height'] for entry in bulk) and prefetch['dimsPending'] == 0


def run(binary, workspace, evidence, expected_uuid):
    vm.require_vm(expected_uuid)
    workspace = vm.directory(workspace)
    evidence = vm.directory(evidence, fresh=True)
    source = Path(__file__).resolve().parents[2]
    driver = evidence / 'driver'
    driver.mkdir(mode=0o700)
    rows = []
    # Test tools share the complete selected source graph, just like the Docker
    # observer/fake route. An expanding local import graph cannot outgrow a
    # manually maintained test-dependency list. The native engine still starts
    # outside this snapshot and consumes its embedded graph plus fixture data.
    excluded = ['.git', 'client-solid-dist', 'state', 'cache', '.shots', '.tmp*', '*.bak', '__pycache__']
    for original in sorted(source.iterdir()):
        if original.name in ['.git', 'client-solid-dist', 'state', 'cache', '__pycache__'] or original.name.endswith('.bak'):
            continue
        destination = driver / original.name
        if original.is_dir():
            shutil.copytree(original, destination, ignore=shutil.ignore_patterns(*excluded))
            copied_paths = sorted(destination.rglob('*'))
        else:
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(original, destination)
            copied_paths = [destination]
        for copied in copied_paths:
            if copied.is_file():
                relative = copied.relative_to(driver)
                if vm.sha(copied) != vm.sha(source / relative):
                    raise RuntimeError('Native driver snapshot differs')
                rows.append({'path': str(relative), 'sha256': vm.sha(copied), 'mode': oct(copied.stat().st_mode & 0o777)})
    vm.json_file(evidence / 'driver-input.json', rows)
    for name in ['state', 'cache', 'home', 'tmp', 'browser-tmp']:
        (evidence / name).mkdir(mode=0o700)
    for name in ['.tmp-comfy', '.tmp-mutable', 'e2e/.shots']:
        (driver / 'tests' / name).mkdir(mode=0o700)
    shutil.copy2(driver / 'tests/fixtures/flux-basic.png', driver / 'tests/.tmp-mutable/flux-basic.png')
    deno = workspace / 'inputs/build-inputs/deno/deno'
    pins = json.loads((source / 'packaging/linux/inputs.json').read_text())
    if vm.sha(deno) != pins['inputs']['compiler']['sha256']:
        raise RuntimeError('Native fake test tool differs from authenticated compiler input')
    ports = []
    import socket
    for _ in range(3):
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            ports.append(probe.getsockname()[1])
    if len(set(ports)) != 3:
        raise RuntimeError('Native test ports collide')
    engine_port, fake_port, fake2_port = ports
    env = {key: value for key, value in os.environ.items() if not key.startswith(('DENO_', 'KOZMOZOO_', 'XDG_'))}
    env.update({'HOME': str(evidence / 'home'), 'TMPDIR': str(evidence / 'tmp'), 'PATH': '/usr/bin:/bin',
                'DENO_DIR': str(workspace / 'inputs/deno-cache'), 'DENO_NO_UPDATE_CHECK': '1'})
    engine_env = {**env, 'KOZMOZOO_STATE': str(evidence / 'state'), 'KOZMOZOO_CACHE': str(evidence / 'cache'),
                  'KOZMOZOO_PORT': str(engine_port), 'KOZMOZOO_REVALIDATE_MS': '1500',
                  'KOZMOZOO_HOSTS': f'fake=127.0.0.1:{fake_port},another=127.0.0.1:{fake2_port},fixture-dir=folder:{driver}/tests/fixtures,mut=folder:{driver}/tests/.tmp-mutable'}
    processes, streams = [], []
    def launch(argv, name, child_env):
        stream = (evidence / (name + '.log')).open('xb')
        streams.append(stream)
        process = subprocess.Popen(list(map(str, argv)), env=child_env, cwd=evidence, stdout=stream, stderr=subprocess.STDOUT)
        processes.append(process)
        return process
    def ready(port, path):
        def check():
            try:
                with urllib.request.urlopen(f'http://127.0.0.1:{port}{path}', timeout=2) as response:
                    return json.loads(response.read())
            except OSError:
                if any(process.poll() is not None for process in processes):
                    raise RuntimeError('Native test process exited before readiness; preserved logs')
                return None
        return vm.wait_for(check, 'Native process readiness absent')
    binary = Path(binary).resolve(strict=True)
    try:
        launch([deno, 'run', '--frozen', '--cached-only', '--allow-net', '--allow-read', driver / 'tests/fake-comfy.mjs',
                '--port', fake_port, '--bulk', '3000', '--mutable-dir', driver / 'tests/.tmp-comfy'], 'fake', env)
        launch([deno, 'run', '--frozen', '--cached-only', '--allow-net', '--allow-read', driver / 'tests/fake-comfy.mjs',
                '--port', fake2_port, '--bulk', '40'], 'fake2', env)
        ready(fake_port, '/api/system_stats')
        ready(fake2_port, '/api/system_stats')
        engine = launch([binary, 'serve'], 'engine', engine_env)
        runtime = ready(engine_port, '/api/runtime')
        if runtime['status'] != 'ready' or runtime['mode'] != 'serve' or runtime['binding'] != {'hostname': '0.0.0.0', 'port': engine_port}:
            raise RuntimeError('Native engine runtime identity differs')
        executable = Path(f'/proc/{engine.pid}/exe').resolve()
        if executable != binary or vm.sha(executable) != vm.sha(binary):
            raise RuntimeError('Native suites are not observing the supplied executable')
        vm.json_file(evidence / 'runtime.json', {'runtime': runtime, 'exe': str(executable), 'binarySha256': vm.sha(binary)})
        def dimensions_observed():
            # An idle counter before the first inventory flight is not a
            # completed dimension pass. Observe the fixture at the consumer end
            # before admitting the unchanged size-known volume/UI witnesses.
            with urllib.request.urlopen(f'http://127.0.0.1:{engine_port}/api/collections/fake/entries', timeout=10) as response:
                entries = json.loads(response.read())
            return fixture_dimensions_ready(entries, ready(engine_port, '/api/prefetch'))
        vm.wait_for(dimensions_observed, 'Native initial fixture dimensions did not reach the consumer', timeout=240)
        markers = {'workbench': 'e2e OK', 'variations': 'ALL PASS', 'diff': 'DIFF E2E: ALL PASS',
                   'cache': 'CACHE E2E: ALL PASS', 'feed': 'FEED E2E: ALL PASS'}
        suites = []
        for suite, marker in markers.items():
            temporary = evidence / 'browser-tmp' / suite
            temporary.mkdir(mode=0o700)
            browser_env = {**env, 'TMPDIR': str(vm.short_temporary(temporary, workspace)), 'E2E_WORKSPACE': str(driver), 'CHROME_BIN': '/usr/bin/chromium',
                           'E2E_ENGINE': f'http://127.0.0.1:{engine_port}', 'E2E_FAKE': f'http://127.0.0.1:{fake_port}'}
            vm.command(['/usr/bin/node', driver / f'tests/e2e/{suite}.e2e.cjs'], evidence / (suite + '.log'), browser_env, driver)
            if marker not in (evidence / (suite + '.log')).read_text():
                raise RuntimeError('Complete native suite terminal witness absent: ' + suite)
            suites.append({'suite': suite, 'result': 'pass', 'marker': marker})
        engine.terminate()
        code = engine.wait(timeout=30)
        if code != 0:
            raise RuntimeError('Native suites engine did not stop cleanly')
        value = {'binarySha256': vm.sha(binary), 'engineExitCode': code, 'engineExecutable': str(executable),
                 'route': 'native engine/fakes/Node/Chromium; no container', 'suites': suites}
        vm.json_file(evidence / 'results.json', value)
        print('NATIVE FIVE SUITES PASS')
        return value
    finally:
        for process in reversed(processes):
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=30)
        for stream in streams:
            stream.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ['binary', 'workspace', 'evidence']:
        parser.add_argument('--' + option, type=Path, required=True)
    parser.add_argument('--expected-vm-uuid', required=True)
    args = parser.parse_args()
    run(args.binary, args.workspace, args.evidence, args.expected_vm_uuid)
