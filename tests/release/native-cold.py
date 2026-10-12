#!/usr/bin/env python3
"""Complete cold GNU consumer in native systemd namespaces; no Docker invocation."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import time

import publication_vm as vm

BOOKWORM = 'debian@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587'


def root_inventory(root):
    rows = []
    for path in sorted(root.rglob('*')):
        if path.is_symlink():
            rows.append({'path': str(path.relative_to(root)), 'link': os.readlink(path)})
        elif path.is_file():
            rows.append({'path': str(path.relative_to(root)), 'sha256': vm.sha(path), 'mode': oct(path.stat().st_mode & 0o777)})
    return rows


def run(binary, workspace, evidence, expected_uuid):
    vm.require_vm(expected_uuid)
    workspace = vm.directory(workspace)
    run = vm.directory(evidence, fresh=True)
    input_root = workspace / 'inputs/cold-bookworm'
    receipt = json.loads((input_root / 'rootfs.json').read_text())
    assert BOOKWORM in receipt['image']['RepoDigests'] and 'debian:bookworm-slim' in receipt['image']['RepoTags']
    assert root_inventory(input_root / 'root') == receipt['files'], 'Cold root input bytes/modes/links differ'
    root = run / 'root'
    shutil.copytree(input_root / 'root', root, symlinks=True)
    assert 'VERSION_CODENAME=bookworm' in (root / 'etc/os-release').read_text()
    assert 'Package: libsqlite3-0\n' not in (root / 'var/lib/dpkg/status').read_text()
    assert not (root / 'usr/bin/deno').exists() and not (root / 'usr/bin/docker').exists()
    for name in ['home', 'state', 'cache', 'tmp', 'fixtures', 'browser-tmp', 'readonly-tmp']:
        (run / name).mkdir(mode=0o700)
    source = Path(__file__).resolve().parents[2]
    supplied = Path(binary).resolve(strict=True)
    binary = run / 'kosmozoo space % café'
    shutil.copy2(supplied, binary)
    shutil.copy2(source / 'tests/fixtures/flux-basic.png', run / 'fixtures/flux-basic.png')
    fixture = (run / 'fixtures/flux-basic.png').read_bytes()
    unit_prefix = 'kz-native-cold-' + hashlib.sha256(str(run).encode()).hexdigest()[:16]
    results, units = [], []
    unit = None
    def record(case, **details):
        results.append({'case': case, 'result': 'pass', **details})
        (run / 'results.json').write_text(json.dumps({'binarySha256': vm.sha(binary), 'imageId': receipt['image']['Id'],
            'rootfsInputSha256': vm.sha(input_root / 'rootfs.json'), 'route': 'native systemd RootDirectory/PrivateNetwork; no Docker', 'cases': results}, indent=2) + '\n')
        print('PASS:', case, flush=True)
    def state(name):
        text = subprocess.check_output(['sudo', '-n', 'systemctl', 'show', name, '--property=MainPID,User,RootDirectory,PrivateNetwork,BindPaths,BindReadOnlyPaths,Result,ExecMainStatus'], text=True, timeout=15)
        return dict(line.split('=', 1) for line in text.splitlines())
    def path_value(value):
        # Transient D-Bus properties take literal paths, not unit-file specifier
        # syntax. Quote each path field, never the colon-separated definition.
        return '"' + str(value).replace('\\', '\\\\').replace('"', '\\"') + '"'
    def launch(label, temporary=None, extra=None, noexec=False):
        nonlocal unit
        unit = unit_prefix + '-' + label + '.service'
        assert subprocess.check_output(['sudo', '-n', 'systemctl', 'show', unit, '--property=LoadState', '--value'], text=True, timeout=15).strip() == 'not-found'
        command = ['sudo', '-n', 'systemd-run', '--unit=' + unit, '--uid=1000', '--gid=1000', '--working-directory=/data/home',
            '--property=RootDirectory=' + str(root), '--property=PrivateNetwork=yes', '--property=ProtectSystem=strict',
            '--property=RuntimeMaxSec=600', '--property=TimeoutStopSec=30', '--property=RemainAfterExit=yes',
            '--property=StandardOutput=file:' + str(run / (label + '-engine.log')), '--property=StandardError=inherit']
        for original, destination in [(binary, '/artifact/kosmozoo'), (run / 'fixtures', '/fixtures')]:
            command.append('--property=BindReadOnlyPaths=' + path_value(original) + ':' + destination)
        for original, destination in [(run / 'state', '/data/state'), (run / 'cache', '/data/cache'),
                                      (temporary or run / 'tmp', '/data/tmp'), (run / 'home', '/data/home')]:
            command.append('--property=BindPaths=' + path_value(original) + ':' + destination)
        if noexec:
            command.append('--property=NoExecPaths=+/data/tmp')
        env = {'HOME': '/data/home', 'TMPDIR': '/data/tmp', 'KOZMOZOO_STATE': '/data/state', 'KOZMOZOO_CACHE': '/data/cache',
               'KOZMOZOO_HOSTS': '', 'KOZMOZOO_PORT': '2084', 'KOZMOZOO_BIND': '0.0.0.0', **(extra or {})}
        command += ['--setenv=' + key + '=' + value for key, value in env.items()]
        units.append(unit)
        subprocess.run([*command, '/artifact/kosmozoo', 'serve'], check=True, timeout=30)
        return unit
    def query(path, value=None, method=None, raw=False):
        pid = int(state(unit)['MainPID'])
        assert pid > 0
        code = 'import urllib.request,json,base64; request=urllib.request.Request("http://127.0.0.1:2084"+' + repr(path) + ',data=' + repr(None if value is None else json.dumps(value).encode()) + ',method=' + repr(method) + ',headers=' + repr({} if value is None else {'Content-Type': 'application/json'}) + '); response=urllib.request.urlopen(request,timeout=10); body=response.read(); print(base64.b64encode(body).decode() if ' + repr(raw) + ' else body.decode())'
        output = subprocess.check_output(['sudo', '-n', 'nsenter', '--target', str(pid), '--net', '--', 'python3', '-B', '-c', code], timeout=15)
        return base64.b64decode(output) if raw else json.loads(output)
    def ready():
        def check():
            try:
                value = query('/api/runtime')
                return value if value['status'] == 'ready' else None
            except (OSError, subprocess.CalledProcessError, AssertionError):
                return None
        return vm.wait_for(check, 'Cold native GNU readiness absent')
    def stop(label):
        subprocess.run(['sudo', '-n', 'systemctl', 'stop', unit], check=True, timeout=35)
        final = state(unit)
        vm.json_file(run / (label + '-final.json'), final)
        assert final['MainPID'] == '0' and final['Result'] == 'success' and final['ExecMainStatus'] == '0'
    try:
        launch('first')
        first = ready()
        initial = state(unit)
        assert initial['User'] == '1000' and initial['PrivateNetwork'] == 'yes' and initial['RootDirectory'] == str(root)
        assert first['binding'] == {'hostname': '0.0.0.0', 'port': 2084}
        vm.json_file(run / 'engine-start.json', initial)
        pid = int(initial['MainPID'])
        maps = subprocess.check_output(['sudo', '-n', '/usr/bin/cat', f'/proc/{pid}/maps'], text=True, timeout=15)
        (run / 'maps.log').write_text(maps)
        native = {line.split(None, 5)[5] for line in maps.splitlines() if 'deno-native-addons' in line}
        matched = [path for path in native if path.startswith('/data/tmp/') and vm.sha(run / 'tmp' / Path(path).relative_to('/data/tmp')) == '2e6eef9a727f081f0d453b4e5e6cbd8b9ef8b6f86cbf7681cbad444d3b0b55c8']
        assert len(matched) == 1
        libc = subprocess.check_output(['sudo', '-n', 'chroot', str(root), '/usr/bin/getconf', 'GNU_LIBC_VERSION'], text=True, timeout=15).strip()
        assert libc == 'glibc 2.36'
        record('fresh outbound-isolated Bookworm native binary/data only, UID1000, no installed Deno/Docker/system SQLite, pinned mapped library', runtime=first, libc=libc, mappedPath=matched[0])
        for path in ['/', '/shared/extractor.mjs', '/shared/entry-path.mjs', '/shared/source-origin.mjs', '/shared/features/variations/shared.mjs', '/plugins/detector/client.js']:
            assert len(query(path, raw=True)) > 50
        query('/api/collections', {'name': 'fixtures', 'address': 'folder:/fixtures'})
        assert query('/api/collections/fixtures/entries/flux-basic.png/bytes', raw=True) == fixture
        query('/api/collections/fixtures/entries/flux-basic.png/judgment', {'bookmark': True, 'notes': {'pos': 'cold Bookworm retained'}}, 'PATCH')
        query('/api/collections/fixtures', {'pinned': True, 'autoRefresh': False}, 'PATCH')
        query('/api/settings/core.portable', {'retained': 'cold-offline'}, 'PATCH')
        record('native cold bytes/judgment/settings/source-flag writes reach actual consumers')
        observer_env = {**os.environ, 'TMPDIR': str(vm.short_temporary(run / 'browser-tmp', workspace)), 'CHROME_BIN': '/usr/bin/chromium',
                         'E2E_ENGINE': 'http://127.0.0.1:2084', 'E2E_EVIDENCE': str(run)}
        # Root is needed only for entering the engine's network namespace.
        # Observer descendants retain the same owner as private temp/profile
        # files; root Chromium privilege separation cannot traverse those files.
        vm.command(['sudo', '-n', 'nsenter', '--target', str(pid), '--net', '--', 'runuser', '-u', 'tester', '--', '/usr/bin/env',
                    *[key + '=' + observer_env[key] for key in ['TMPDIR', 'CHROME_BIN', 'E2E_ENGINE', 'E2E_EVIDENCE']],
                    '/usr/bin/node', source / 'tests/release/cold-ui.cjs'], run / 'cold-ui.log', timeout=120)
        actual = json.loads((run / 'cold-ui.json').read_text())
        assert actual['decoded'] == 1024 and actual['bookmark'] and actual['renderedNote'] == 'cold Bookworm retained'
        record('actual native Node/Chromium cold SPA renders decoded bytes and persisted bookmark/notes without outbound network')
        stop('first')
        with sqlite3.connect(run / 'state/metadata.db') as db:
            assert db.execute('PRAGMA user_version').fetchone()[0] == 9
            assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
            assert db.execute('PRAGMA foreign_key_check').fetchall() == []
        record('stopped native storage schema9/integrity ok/zero foreign-key violations')
        shutil.move(run / 'fixtures/flux-basic.png', run / 'retained-fixture.png')
        launch('recreated')
        second = ready()
        assert second['instance'] != first['instance']
        judgment = query('/api/collections/fixtures/entries/flux-basic.png')['judgment']
        assert judgment['bookmark'] and judgment['notes']['pos'] == 'cold Bookworm retained'
        assert query('/api/settings/core.portable')['retained'] == 'cold-offline'
        flags = query('/api/collections')['fixtures']
        assert flags['pinned'] and not flags['autoRefresh']
        assert query('/api/collections/fixtures/entries/flux-basic.png/bytes', raw=True) == fixture
        record('cold recreation preserves SQLite/settings/flags/cache after source removal')
        stop('recreated')
        database = vm.sha(run / 'state/metadata.db')
        settings = (run / 'state/settings.json').read_bytes()
        (run / 'readonly-tmp').chmod(0o500)
        for case, temporary, extra, needle, noexec in [
            ('invalid-override', run / 'tmp', {'DENO_SQLITE_PATH': '/missing.so'}, 'DENO_SQLITE_PATH', False),
            ('local-download-refused', run / 'tmp', {'DENO_SQLITE_LOCAL': '1'}, 'DENO_SQLITE_LOCAL', False),
            ('readonly-cache', run / 'readonly-tmp', {}, 'Permission denied', False),
            ('noexec-cache', run / 'tmp', {}, 'failed to map', True),
        ]:
            launch(case, temporary, extra, noexec)
            vm.wait_for(lambda: state(unit)['MainPID'] == '0', 'Native failure process did not exit')
            failure = state(unit)
            text = (run / (case + '-engine.log')).read_text()
            assert failure['ExecMainStatus'] == '1' and needle.lower() in text.lower(), (case, failure, text)
            assert vm.sha(run / 'state/metadata.db') == database and (run / 'state/settings.json').read_bytes() == settings
            assert not (run / 'state/engine-instance.json').exists()
            record('native failure ' + case + ' preserves exact state, reports cause and never downloads/reseeds', output=text)
        print('NATIVE BOOKWORM COLD AND FAILURE OUTCOMES PASS')
    finally:
        for owned in units:
            if int(state(owned)['MainPID']) > 0:
                subprocess.run(['sudo', '-n', 'systemctl', 'stop', owned], check=True, timeout=35)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['binary', 'workspace', 'evidence']:
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--expected-vm-uuid', required=True)
    args = parser.parse_args()
    run(args.binary, args.workspace, args.evidence, args.expected_vm_uuid)
