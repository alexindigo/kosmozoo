#!/usr/bin/env python3
"""Actual pacman-owned executable/menu/user-unit consumers and preserved data."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import subprocess
import time
import urllib.request

import publication_vm as vm
import publication_owner as ownership
from publication_input import start_watchdog, finish_resources

VARIANTS = {'kosmozoo', 'kosmozoo-bin', 'kosmozoo-git'}
FILES = ['usr/bin/kosmozoo', 'usr/share/applications/kosmozoo.desktop',
         'usr/share/icons/hicolor/256x256/apps/kosmozoo.png', 'usr/lib/systemd/user/kosmozoo-engine.service',
         'usr/share/licenses/kosmozoo/LICENSE', 'usr/share/licenses/kosmozoo/LICENSE.GPL',
         'usr/share/licenses/kosmozoo/THIRD_PARTY_NOTICES.txt', 'usr/share/licenses/kosmozoo/NOTICE-SOURCES.json']


def pkginfo_fields(info):
    fields = {}
    for line in info.splitlines():
        if ' = ' in line:
            key, value = line.split(' = ', 1)
            fields.setdefault(key, []).append(value)
    return fields


def validate_package_contract(expected_name, version, fields, inventory, elf_header):
    if '.INSTALL' in inventory or not set(FILES) <= set(inventory):
        raise RuntimeError('Package contains activation hook or lacks required global resources')
    if fields['arch'] != ['x86_64']:
        raise RuntimeError('Package architecture differs')
    if expected_name in ['kosmozoo', 'kosmozoo-bin'] and version != '0.2.0-1':
        raise RuntimeError('Stable package version/pkgrel differs')
    if any(re.match(r'^(python|deno|nodejs|docker|sqlite)(?:[<>=]|$)', name) for name in fields.get('depend', [])):
        raise RuntimeError('Interpreter/container/system-SQLite engine dependency found')
    conflicts = {re.split(r'[<>=]', value)[0] for value in fields.get('conflict', [])}
    if not (VARIANTS - {expected_name}) <= conflicts:
        raise RuntimeError('Native variant conflicts incomplete')
    if expected_name != 'kosmozoo' and not any(re.split(r'[<>=]', value)[0] == 'kosmozoo' for value in fields.get('provides', [])):
        raise RuntimeError('Native variant does not provide kosmozoo')
    if elf_header[:6] != b'\x7fELF\x02\x01' or elf_header[18:20] != b'\x3e\x00':
        raise RuntimeError('Package executable is not native x86_64 ELF64')


def package(path, expected_name):
    path = Path(path).resolve(strict=True)
    identity = subprocess.check_output(['pacman', '-Qp', str(path)], text=True, timeout=30).strip().split()
    if len(identity) != 2 or identity[0] != expected_name:
        raise RuntimeError('Package file/name selection differs')
    inventory = subprocess.check_output(['bsdtar', '-tf', str(path)], text=True, timeout=30).splitlines()
    info = subprocess.check_output(['bsdtar', '-xOf', str(path), '.PKGINFO'], text=True, timeout=30)
    fields = pkginfo_fields(info)
    elf = subprocess.check_output(['bsdtar', '-xOf', str(path), 'usr/bin/kosmozoo'], timeout=60)
    validate_package_contract(expected_name, identity[1], fields, inventory, elf[:20])
    return {'path': str(path), 'name': expected_name, 'version': identity[1], 'sha256': vm.sha(path),
            'binarySha256': hashlib.sha256(elf).hexdigest(), 'fields': fields, 'files': inventory}


def accept(package_file, package_name, workspace, evidence, uuid):
    vm.require_vm(uuid)
    if uuid != '0053e86d-8233-49eb-97e0-4055e5428be7' or package_name not in VARIANTS:
        raise RuntimeError('Installed acceptance requires the assigned native/package guest and variant')
    run = vm.directory(evidence, fresh=True)
    start_watchdog(run, uuid)
    gui = {**os.environ, **dict(line.split('=', 1) for line in subprocess.check_output(
        ['systemctl', '--user', 'show-environment'], text=True, timeout=15).splitlines())}
    try:
        installed_consumers(package_file, package_name, workspace, run, uuid)
    finally:
        finish_resources(run, gui, uuid)
    print('AUR NATIVE ACCEPTANCE PASS')


def installed_consumers(package_file, package_name, workspace, evidence, uuid):
    vm.require_vm(uuid)
    if uuid != '0053e86d-8233-49eb-97e0-4055e5428be7' or package_name not in VARIANTS:
        raise RuntimeError('Installed acceptance requires the assigned native/package guest and variant')
    workspace = vm.directory(workspace)
    run = vm.directory(evidence)
    source = Path(__file__).resolve().parents[2]
    target = package(package_file, package_name)
    # M04 supplies exact locally reviewed package/cache identities, including a
    # real legacy package. No package is fabricated to stand in for pacman.
    inputs = json.loads((workspace / 'packages/acceptance-inputs.json').read_text())
    candidates = {}
    for row in inputs['variants']:
        value = package(row['file'], row['name'])
        if value['sha256'] != row['sha256']:
            raise RuntimeError('Reviewed package candidate hash differs')
        candidates[row['name']] = value
    if set(candidates) != VARIANTS or candidates[package_name] != target:
        raise RuntimeError('Installed acceptance requires the exact three reviewed candidates')
    if candidates['kosmozoo-bin']['binarySha256'] != inputs['officialBinarySha256']:
        raise RuntimeError('Prebuilt package bytes differ from frozen official ELF')
    legacy = inputs['legacy']
    legacy_file = Path(legacy['file']).resolve(strict=True)
    if vm.sha(legacy_file) != legacy['sha256']:
        raise RuntimeError('Legacy package hash differs')
    legacy_id = subprocess.check_output(['pacman', '-Qp', str(legacy_file)], text=True, timeout=30).strip().split()
    if legacy_id != [legacy['name'], legacy['version']] or legacy['name'] != 'kosmozoo-git':
        raise RuntimeError('Legacy package identity differs')
    for name in VARIANTS:
        if subprocess.run(['pacman', '-Q', name], capture_output=True, timeout=15).returncode == 0:
            raise RuntimeError('Existing installed variant must be reconciled, not removed implicitly')
    session = dict(line.split('=', 1) for line in subprocess.check_output(['systemctl', '--user', 'show-environment'], text=True, timeout=15).splitlines())
    gui = {**os.environ, **{key: session[key] for key in ['XDG_RUNTIME_DIR', 'WAYLAND_DISPLAY', 'NIRI_SOCKET', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_SESSION_TYPE', 'XDG_CURRENT_DESKTOP']}}
    unit = 'kosmozoo-engine.service'
    def unit_state():
        text = subprocess.check_output(['systemctl', '--user', 'show', unit, '--property=LoadState,ActiveState,MainPID,FragmentPath,DropInPaths,Result,ExecMainStatus'], text=True, timeout=15)
        return dict(line.split('=', 1) for line in text.splitlines())
    assert unit_state()['LoadState'] == 'not-found', 'Unexpected user/global unit must be preserved'
    windows = lambda: json.loads(subprocess.check_output(['niri', 'msg', '--json', 'windows'], env=gui, text=True, timeout=15))
    assert not windows(), 'Unexpected native windows must be preserved'
    for name in ['home', 'state', 'cache', 'tmp', 'data', 'fixtures']:
        (run / name).mkdir(mode=0o700)
    fixture = (source / 'tests/fixtures/flux-basic.png').read_bytes()
    (run / 'fixtures/flux-basic.png').write_bytes(fixture)
    import socket
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0)); debug_port = sock.getsockname()[1]
    assert debug_port != port, 'Observer and engine test ports collide'
    origin = f'http://127.0.0.1:{port}'
    env = {**gui, 'HOME': str(run / 'home'), 'XDG_DATA_HOME': str(run / 'data'), 'TMPDIR': str(vm.short_temporary(run / 'tmp', workspace)),
           'KOZMOZOO_STATE': str(run / 'state'), 'KOZMOZOO_CACHE': str(run / 'cache'), 'KOZMOZOO_HOSTS': '',
           'KOZMOZOO_BIND': '127.0.0.1', 'KOZMOZOO_PORT': str(port)}
    env['KZ_PUBLICATION_OWNER'] = secrets.token_hex(24)
    env['XDG_CONFIG_HOME'] = str(run / 'config')
    (run / 'config').mkdir(mode=0o700)
    # The global unit keeps the real user-manager HOME; state/data are the
    # explicit private environment-file test inputs used by all consumers.
    owned = {'unit': unit, 'units': [unit], 'env': {**env, 'HOME': session['HOME']}, 'uiScopes': [str(run)],
             'publicationOwner': {'token': env['KZ_PUBLICATION_OWNER'], 'binary': '/usr/bin/kosmozoo',
                'binaryHashes': [value['binarySha256'] for value in candidates.values()],
                'fragmentPath': '/usr/lib/systemd/user/kosmozoo-engine.service'}}
    vm.json_file(run / 'ownership.json', owned)
    # A test-owned drop-in overrides existing user config without overwriting it.
    # The actual unit FragmentPath stays the pacman-owned global resource.
    config = Path(session.get('XDG_CONFIG_HOME', '/home/tester/.config'))
    user_unit = config / 'systemd/user' / unit
    assert not user_unit.exists() and not user_unit.is_symlink()
    dropins = config / 'systemd/user' / (unit + '.d')
    if dropins.exists() and any(dropins.iterdir()):
        raise RuntimeError('Existing user unit drop-ins must be preserved')
    dropins.mkdir(parents=True, exist_ok=True)
    dropin = dropins / ('publication-' + hashlib.sha256(str(run).encode()).hexdigest()[:16] + '.conf')
    environment_file = run / 'engine.env'
    quoted = lambda value: '"' + value.replace('\\', '\\\\').replace('"', '\\"') + '"'
    with environment_file.open('x') as file:
        file.write(''.join(key + '=' + quoted(value) + '\n' for key, value in env.items() if key.startswith(('KOZMOZOO_', 'XDG_DATA_HOME')) or key in ['TMPDIR', 'KZ_PUBLICATION_OWNER']))
    environment_file.chmod(0o600)
    with dropin.open('x') as file:
        file.write('[Service]\nRuntimeMaxSec=900\nTimeoutStopSec=30\nEnvironmentFile=\nEnvironmentFile=' + str(environment_file).replace('%', '%%') + '\n')
    wrapper = run / 'chromium'
    wrapper.write_text('#!/bin/sh\nexec /usr/bin/chromium --remote-debugging-port=' + str(debug_port) + ' "$@"\n')
    wrapper.chmod(0o755)
    cases, installed = [], None
    def record(case, **details):
        cases.append({'case': case, 'result': 'pass', **details})
        (run / 'results.json').write_text(json.dumps({'package': target, 'officialBinarySha256': inputs['officialBinarySha256'],
            'expectedVmUuid': uuid, 'route': 'actual pacman/native /usr/bin/GIO/user-unit/Node; no Docker', 'cases': cases}, indent=2) + '\n')
        print('PASS:', case, flush=True)
    def manager(*arguments):
        return subprocess.run(['systemctl', '--user', *arguments], check=True, capture_output=True, timeout=35)
    def install(value, label):
        nonlocal installed
        vm.command(['sudo', '-n', 'pacman', '-U', '--noconfirm', value['path']], run / (label + '-pacman.log'), timeout=300)
        installed = value['name']
        manager('daemon-reload')
        assert unit_state()['MainPID'] == '0', 'Package installation unexpectedly activated engine'
        assert vm.sha('/usr/bin/kosmozoo') == value['binarySha256']
        for name in FILES:
            owner = subprocess.check_output(['pacman', '-Qoq', '/' + name], text=True, timeout=15).strip()
            assert owner == value['name'], ('wrong package file owner', name, owner)
        subprocess.run(['pacman', '-Qkk', value['name']], check=True, capture_output=True, timeout=30)
    def remove(label):
        nonlocal installed
        assert unit_state()['MainPID'] == '0'
        vm.command(['sudo', '-n', 'pacman', '-R', '--noconfirm', installed], run / (label + '-remove.log'), timeout=300)
        installed = None
        manager('daemon-reload')
    def request(path, value=None, method=None):
        data = None if value is None else json.dumps(value).encode()
        query = urllib.request.Request(origin + path, data=data, method=method, headers={} if data is None else {'Content-Type': 'application/json'})
        with urllib.request.urlopen(query, timeout=10) as response:
            body = response.read()
            return json.loads(body) if 'application/json' in response.headers.get('Content-Type', '') else body
    def ready():
        def check():
            try: return request('/api/runtime')
            except OSError: return None
        value = vm.wait_for(check, 'Pacman-installed engine did not publish readiness')
        assert value['status'] == 'ready' and value['mode'] == 'serve' and value['binding'] == {'hostname': '127.0.0.1', 'port': port}
        state = unit_state()
        assert state['FragmentPath'] == '/usr/lib/systemd/user/kosmozoo-engine.service'
        pid = int(state['MainPID'])
        assert pid > 0 and Path(f'/proc/{pid}/exe').resolve() == Path('/usr/bin/kosmozoo')
        assert vm.sha(Path(f'/proc/{pid}/exe')) == candidates[installed]['binarySha256']
        return value
    def stop():
        ownership.retire_engine(owned, unit)
        state = unit_state()
        assert state['MainPID'] == '0' and state['Result'] == 'success' and state['ExecMainStatus'] == '0'
    def retained():
        assert request('/api/collections/fixtures/entries/flux-basic.png/bytes') == fixture
        judgment = request('/api/collections/fixtures/entries/flux-basic.png')['judgment']
        assert judgment['bookmark'] and judgment['notes']['pos'] == 'pacman native retained'
        assert request('/api/settings/core.package')['retained'] == 'native-global'
        flags = request('/api/collections')['fixtures']
        assert flags['pinned'] and not flags['autoRefresh']
    try:
        # Real legacy package installation/transition; no legacy engine activation.
        vm.command(['sudo', '-n', 'pacman', '-U', '--noconfirm', str(legacy_file)], run / 'legacy-install.log', timeout=300)
        installed = legacy['name']
        assert unit_state()['MainPID'] == '0'
        remove('legacy')
        install(target, 'initial')
        record('actual legacy-to-native package transition with package ownership and no automatic engine activation')
        shadow = run / 'home/.local/bin/kosmozoo'
        shadow.parent.mkdir(parents=True)
        shadow_bytes = b'#!/bin/sh\n# retained unmanaged local shadow fixture\nexit 77\n'
        shadow.write_bytes(shadow_bytes); shadow.chmod(0o755)
        located = subprocess.check_output(['/bin/sh', '-c', 'command -v kosmozoo'],
            env={**env, 'PATH': str(shadow.parent) + ':/usr/bin:/bin'}, text=True, timeout=15).strip()
        assert located == str(shadow)
        guidance = Path('/usr/share/doc/kosmozoo/PUBLICATION.md').read_text()
        assert 'shadow' in guidance and 'FragmentPath' in guidance and 'kosmozoo uninstall' in guidance
        refused = subprocess.run(['/usr/bin/kosmozoo', 'install'], env=env, cwd=run, capture_output=True, timeout=30)
        assert refused.returncode == 1 and b'conflict' in refused.stdout + refused.stderr and shadow.read_bytes() == shadow_bytes
        record('actual user-local shadow detection/guidance and self-installer refusal preserve unmanaged bytes; global consumers remain explicit /usr/bin')
        subprocess.run(['desktop-file-validate', '/usr/share/applications/kosmozoo.desktop'], check=True, timeout=15)
        text = Path('/usr/lib/systemd/user/kosmozoo-engine.service').read_text()
        assert '"/usr/bin/kosmozoo" serve' in text and 'EnvironmentFile=-%E/kosmozoo/engine.env' in text and 'Restart=no' in text
        manager('enable', '--now', unit)
        first = ready()
        assert not windows()
        request('/api/collections', {'name': 'fixtures', 'address': 'folder:' + str(run / 'fixtures')})
        assert request('/api/collections/fixtures/entries/flux-basic.png/bytes') == fixture
        request('/api/collections/fixtures/entries/flux-basic.png/judgment', {'bookmark': True, 'notes': {'pos': 'pacman native retained'}}, 'PATCH')
        request('/api/collections/fixtures', {'pinned': True, 'autoRefresh': False}, 'PATCH')
        request('/api/settings/core.package', {'retained': 'native-global'}, 'PATCH')
        vm.command(['/usr/bin/kosmozoo', 'app', '--browser=' + str(wrapper)], run / 'installed-app.log', env, run, timeout=30)
        vm.wait_for(lambda: any(item['title'] == 'kosmozoo' for item in windows()), 'Actual global app window absent')
        assert request('/api/runtime')['instance'] == first['instance']
        ownership.close_owned_windows(owned, gui)
        vm.wait_for(lambda: not windows(), 'Owned app window did not close')
        vm.command(['gio', 'launch', '/usr/share/applications/kosmozoo.desktop'], run / 'global-desktop.log', env, run, timeout=30)
        vm.wait_for(lambda: any(item['title'] == 'kosmozoo' for item in windows()), 'Pacman-owned desktop consumer absent')
        vm.command(['/usr/bin/node', source / 'tests/release/native-browser-read.cjs'], run / 'native-menu.log',
            {**env, 'NATIVE_CDP': f'http://127.0.0.1:{debug_port}', 'NATIVE_ORIGIN': f'http://localhost:{port}',
             'NATIVE_SOURCE': 'fixtures', 'NATIVE_NOTE': 'pacman native retained', 'NATIVE_RESULT': str(run / 'native-menu.json')}, run, timeout=120)
        subprocess.run(['grim', str(run / 'pacman-menu.png')], env=gui, check=True, timeout=15)
        record('pacman-owned desktop/user-unit/MainPID /usr/bin app renders decoded native fixture and reuses engine', runtime=first, unit=unit_state())
        ownership.close_owned_windows(owned, gui)
        vm.wait_for(lambda: not windows(), 'Owned package window did not close')
        conflict = subprocess.run(['/usr/bin/kosmozoo', 'app'], env={**env, 'KOZMOZOO_PORT': str(port + 1)}, cwd=run, capture_output=True, timeout=30)
        assert conflict.returncode == 1 and b'conflict' in conflict.stdout + conflict.stderr
        assert request('/api/runtime')['instance'] == first['instance']
        record('installed conflicting override refuses without a second writer or changing the active engine')
        cookie = run / 'data/kosmozoo/browser/chromium/Default/Cookies'
        inode = cookie.stat().st_ino
        stop()
        manager('start', unit); second = ready(); retained()
        assert second['instance'] != first['instance'] and cookie.stat().st_ino == inode
        record('actual installed restart retains new SQLite/settings/source flags/cache and browser profile')
        stop()
        # A real unrelated listener must not be killed/reused/reconfigured.
        import http.server
        import threading
        server = http.server.ThreadingHTTPServer(('127.0.0.1', port), http.server.BaseHTTPRequestHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        before = vm.sha(run / 'state/metadata.db')
        try:
            occupied = subprocess.run(['/usr/bin/kosmozoo', 'app'], env=env, cwd=run, capture_output=True, timeout=30)
            (run / 'occupied-port.log').write_bytes(occupied.stdout + occupied.stderr)
            assert occupied.returncode == 1 and vm.sha(run / 'state/metadata.db') == before
            with socket.create_connection(('127.0.0.1', port), timeout=5): pass
            assert unit_state()['MainPID'] == '0'
            record('installed app refuses actual unrelated occupied port without killing listener or changing retained database')
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=10)
            assert not thread.is_alive()
        valid_settings = (run / 'state/settings.json').read_bytes()
        (run / 'valid-settings-before-failure.json').write_bytes(valid_settings)
        corrupt = b'{ deliberate owned package transition failure fixture\n'
        (run / 'state/settings.json').write_bytes(corrupt)
        install(target, 'failed-transition-code-reinstall')
        started = subprocess.run(['systemctl', '--user', 'start', unit], capture_output=True, timeout=35)
        (run / 'failed-transition-start.log').write_bytes(started.stdout + started.stderr)
        vm.wait_for(lambda: unit_state()['MainPID'] == '0' and unit_state()['ExecMainStatus'] == '1', 'Failed native transition did not remain stopped')
        quarantines = list((run / 'state').glob('settings.json.corrupt-*'))
        assert len(quarantines) == 1 and quarantines[0].read_bytes() == corrupt and not (run / 'state/settings.json').exists()
        assert vm.sha(run / 'state/metadata.db') == before and cookie.stat().st_ino == inode
        record('actual code reinstall/failed unit transition stays stopped and preserves exact quarantine/database/profile without reseeding')
        # Explicit repair of this exact owned fixture is separate from failure
        # recovery; it never substitutes for retaining the failed bytes.
        (run / 'state/settings.json').write_bytes(valid_settings)
        manager('start', unit); ready(); retained(); stop()
        record('explicit package-test fixture repair/start retains pre-failure new native writes')
        for peer_name in sorted(VARIANTS - {package_name}):
            peer = candidates[peer_name]
            refusal = subprocess.run(['sudo', '-n', 'pacman', '-U', '--noconfirm', peer['path']], capture_output=True, timeout=300)
            (run / (peer_name + '-conflict.log')).write_bytes(refusal.stdout + refusal.stderr)
            assert refusal.returncode != 0 and vm.sha('/usr/bin/kosmozoo') == target['binarySha256']
            remove(peer_name + '-transition')
            install(peer, peer_name)
            manager('start', unit); ready(); retained(); stop()
            assert cookie.stat().st_ino == inode
            remove(peer_name)
            install(target, peer_name + '-return')
            record('actual ' + peer_name + ' conflict refusal and explicit package replacement preserve new native writes/profile')
        manager('start', unit); ready(); retained(); stop()
        with sqlite3.connect(run / 'state/metadata.db') as db:
            assert db.execute('PRAGMA user_version').fetchone()[0] == 9
            assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
            assert db.execute('PRAGMA foreign_key_check').fetchall() == []
        data_hash = vm.sha(run / 'state/metadata.db')
        manager('disable', unit)
        remove('final')
        assert vm.sha(run / 'state/metadata.db') == data_hash and cookie.stat().st_ino == inode and (run / 'cache').is_dir()
        assert shadow.read_bytes() == shadow_bytes and quarantines[0].read_bytes() == corrupt
        assert not Path('/usr/bin/kosmozoo').exists()
        record('pacman removal retires package-owned executable/resources while exact user data/cache/profile persist', databaseSha256=data_hash, cookieInode=inode)
        # Archive only this test's drop-in after final removal; caller configuration
        # and all retained application data are untouched.
        dropin.rename(run / 'preserved-unit-dropin.conf')
        manager('daemon-reload')
        vm.json_file(run / 'acceptance.json', {'packageSha256': target['sha256'], 'installedBinarySha256': target['binarySha256'],
            'functionalAcceptance': 'pass', 'visualReview': 'separate spatial capture review required'})
    finally:
        state = unit_state()
        ownership.close_owned_windows(owned, gui)
        if int(state['MainPID']) > 0:
            stop()
        vm.json_file(run / 'retained-state.json', {'installedPackage': installed, 'unit': unit_state(), 'ownedDropIn': str(dropin), 'evidence': str(run)})


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--package-file', type=Path, required=True)
    parser.add_argument('--package-name', required=True)
    parser.add_argument('--workspace', type=Path, required=True)
    parser.add_argument('--evidence', type=Path, required=True)
    parser.add_argument('--expected-vm-uuid', required=True)
    args = parser.parse_args()
    accept(args.package_file, args.package_name, args.workspace, args.evidence, args.expected_vm_uuid)
