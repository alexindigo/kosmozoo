#!/usr/bin/env python3
"""Actual compiled-runtime consumer proof on disposable state. VM only."""
import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import time
import urllib.error
import urllib.request


def require_vm():
    subprocess.run(['systemd-detect-virt', '--vm'], check=True, stdout=subprocess.DEVNULL)
    uuid = subprocess.check_output(['sudo', '-n', '/usr/bin/cat', '/sys/class/dmi/id/product_uuid']).decode().strip().lower()
    if uuid != '838fd0e0-e75a-4b21-9ada-8dad6562b151':
        raise RuntimeError('Wrong execution guest')


def sha(path):
    with path.open('rb') as file:
        return hashlib.file_digest(file, 'sha256').hexdigest()


def request(origin, path, value=None, method=None):
    data = None if value is None else json.dumps(value).encode()
    req = urllib.request.Request(origin + path, data=data, method=method,
                                 headers={} if data is None else {'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=10) as response:
        body = response.read()
        return json.loads(body) if 'application/json' in response.headers.get('Content-Type', '') else body


def available_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def main(publication_uuid=None):
    if publication_uuid is None:
        require_vm()
    else:
        from publication_vm import require_vm as require_publication_vm
        require_publication_vm(publication_uuid)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--evidence', type=Path, required=True)
    args = parser.parse_args()
    args.evidence.parent.resolve(strict=True)
    args.evidence.mkdir(mode=0o700)
    run = args.evidence.resolve()
    source = Path(__file__).resolve().parents[2]
    # Encoded/spaced destination; engine receives binary and disposable fixture
    # data only and starts outside the checkout, with no Deno/native override.
    binary = run / 'kosmozoo space % café'
    shutil.copy2(args.binary.resolve(strict=True), binary)
    fixtures = run / 'fixtures'; fixtures.mkdir()
    shutil.copy2(source / 'tests/fixtures/flux-basic.png', fixtures / 'flux-basic.png')
    (run / 'tmp').mkdir(mode=0o700)
    (run / 'home').mkdir(mode=0o700)
    env = {key: value for key, value in os.environ.items() if not key.startswith(('DENO_', 'KOZMOZOO_', 'XDG_')) and key not in ['DISPLAY', 'WAYLAND_DISPLAY', 'NIRI_SOCKET']}
    env.update({'HOME': str(run / 'home'), 'XDG_STATE_HOME': str(run / 'home/state'),
                'XDG_DATA_HOME': str(run / 'home/data'), 'XDG_CONFIG_HOME': str(run / 'home/config'),
                'TMPDIR': str(run / 'tmp'), 'KOZMOZOO_HOSTS': '', 'PATH': '/nonexistent'})
    cases = []

    def record(name, **details):
        cases.append({'case': name, 'result': 'pass', **details})
        (run / 'results.json').write_text(json.dumps({'binarySha256': sha(binary), 'cases': cases}, indent=2) + '\n')
        print('PASS:', name, flush=True)

    def cli(arguments, expected=0, extra=None):
        output = subprocess.run([str(binary), *arguments], env={**env, **(extra or {})}, cwd=run, capture_output=True, timeout=30)
        (run / ('cli-' + str(len(cases)) + '.log')).write_bytes(output.stdout + output.stderr)
        assert output.returncode == expected, (arguments, output.returncode, output.stdout, output.stderr)
        return (output.stdout + output.stderr).decode()

    for command in ['--help', '--version']:
        cli([command], extra={'DENO_SQLITE_PATH': '/absent.so', 'DENO_SQLITE_LOCAL': '1'})
        assert not (run / 'home/state').exists()
        record(command + ' avoids SQLite and engine state')
    for invalid in ['', '2084junk', '0', '65536', ' 2084']:
        text = cli(['serve'], expected=1, extra={'KOZMOZOO_PORT': invalid})
        assert 'KOZMOZOO_PORT' in text
        assert not (run / 'home/state').exists()
        record('invalid whole port fails without fallback', value=invalid)
    port = available_port()
    origin = f'http://127.0.0.1:{port}'
    running_env = {**env, 'KOZMOZOO_PORT': str(port), 'KOZMOZOO_BIND': '127.0.0.1'}

    def boot(command='serve', extra=None):
        log = (run / ('engine-' + str(len(cases)) + '.log')).open('xb')
        process = subprocess.Popen([str(binary), command], env={**running_env, **(extra or {})}, cwd=run, stdout=log, stderr=subprocess.STDOUT)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if process.poll() is not None:
                log.close()
                raise AssertionError(f'Engine exited {process.returncode}; see {log.name}')
            try:
                runtime = request(origin, '/api/runtime')
                if runtime['status'] == 'ready':
                    return process, log, runtime
            except (OSError, urllib.error.URLError):
                pass
            time.sleep(0.05)
        process.send_signal(signal.SIGTERM)
        process.wait(timeout=30)
        log.close()
        raise AssertionError('Engine readiness deadline exceeded')

    def stop(process, log):
        start = time.monotonic()
        process.send_signal(signal.SIGTERM)
        code = process.wait(timeout=30)
        log.close()
        assert code == 0, (code, log.name)
        assert not (run / 'home/state/kosmozoo/engine-instance.json').exists()
        return time.monotonic() - start

    process, log, runtime = boot()
    try:
        assert runtime['binding'] == {'hostname': '127.0.0.1', 'port': port}, runtime
        assert runtime['mode'] == 'serve'
        record('selected bind/port and ready identity published', runtime=runtime)
        mappings = Path(f'/proc/{process.pid}/maps').read_text()
        (run / 'maps.log').write_text(mappings)
        # The characterized Deno loader names extracted libraries from executable
        # stem + path/content hashes, not the original SQLite basename. Preserve
        # spaces in /proc mappings and authenticate the mapped file's bytes.
        mapped_paths = {line.split(None, 5)[5] for line in mappings.splitlines() if 'deno-native-addons' in line}
        selected = [path for path in mapped_paths if sha(Path(path)) == '2e6eef9a727f081f0d453b4e5e6cbd8b9ef8b6f86cbf7681cbad444d3b0b55c8']
        assert len(selected) == 1, mapped_paths
        library = selected[0]
        assert sha(Path(library)) == '2e6eef9a727f081f0d453b4e5e6cbd8b9ef8b6f86cbf7681cbad444d3b0b55c8'
        assert library.startswith(str(run / 'tmp'))
        record('embedded native mapping matches pinned bytes', path=library)
        for path in ['/shared/extractor.mjs', '/shared/entry-path.mjs', '/shared/source-origin.mjs', '/shared/features/variations/shared.mjs', '/js/launch-notice.mjs', '/store/app-store.js', '/plugins/difference/client.js', '/plugins/detector/client.js', '/']:
            assert len(request(origin, path)) > 50, path
        plugins = request(origin, '/api/plugins')
        assert {item['name'] for item in plugins} == {'hello', 'difference', 'detector', 'critic'}, plugins
        hello = request(origin, '/api/plugins/hello/hello')
        record('complete embedded SPA/shared assets and selected plugin discovery', plugins=plugins, hello=hello)
        request(origin, '/api/collections', {'name': 'fixtures', 'address': 'folder:' + str(fixtures)})
        content = request(origin, '/api/collections/fixtures/entries/flux-basic.png/bytes')
        assert content == (fixtures / 'flux-basic.png').read_bytes()
        request(origin, '/api/collections/fixtures/entries/flux-basic.png/judgment', {'bookmark': True, 'notes': {'pos': 'native persisted'}}, method='PATCH')
        request(origin, '/api/settings/core.releaseProbe', {'retained': 'pinned-native'}, method='PATCH')
        record('actual native write/read consumers and fixture bytes')
        text = cli(['app'], extra={'KOZMOZOO_PORT': str(port), 'KOZMOZOO_BIND': '127.0.0.1'})
        assert 'Reusing serve engine' in text and request(origin, '/api/runtime')['instance'] == runtime['instance']
        record('app reuses selected service without a second writer or binding change')
        text = cli(['app'], expected=1, extra={'KOZMOZOO_PORT': str(port + 1)})
        assert 'conflict' in text and request(origin, '/api/runtime')['instance'] == runtime['instance']
        record('explicit conflicting override refused without killing/reconfiguring engine')
        stream = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
        stream.request('GET', '/api/events')
        response = stream.getresponse()
        assert response.status == 200 and response.read(1)
        elapsed = stop(process, log)
        stream.close()
        record('open native SSE subscribers do not strand graceful SIGTERM', elapsed=elapsed)
    finally:
        if process.poll() is None:
            stop(process, log)
    process, log, restarted = boot()
    try:
        assert restarted['instance'] != runtime['instance']
        entry = request(origin, '/api/collections/fixtures/entries/flux-basic.png')
        assert entry['judgment']['bookmark'] is True and entry['judgment']['notes']['pos'] == 'native persisted', entry
        assert request(origin, '/api/settings/core.releaseProbe')['retained'] == 'pinned-native'
        shutil.move(fixtures / 'flux-basic.png', run / 'retained-fixture.png')
        assert request(origin, '/api/collections/fixtures/entries/flux-basic.png/bytes') == (run / 'retained-fixture.png').read_bytes()
        record('restart retains native judgments/settings and serves cached bytes after source removal')
    finally:
        stop(process, log)
    print('COMPILED RUNTIME CONSUMER PASS; portability/browser/installer/five-suite gates remain separate', flush=True)


if __name__ == '__main__':
    main()
