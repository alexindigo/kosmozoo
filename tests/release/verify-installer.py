#!/usr/bin/env python3
"""Real user-unit/menu/version activation and recovery on disposable guest data."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import time
from importlib.util import module_from_spec, spec_from_file_location

spec = spec_from_file_location('runtime_probe', Path(__file__).with_name('verify-runtime.py'))
probe = module_from_spec(spec); spec.loader.exec_module(probe)


def main():
    probe.require_vm()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--previous-binary', type=Path, required=True)
    parser.add_argument('--evidence', type=Path, required=True)
    args = parser.parse_args()
    session = dict(line.split('=', 1) for line in subprocess.check_output(['systemctl', '--user', 'show-environment']).decode().splitlines())
    gui = {key: session[key] for key in ['XDG_RUNTIME_DIR', 'WAYLAND_DISPLAY', 'NIRI_SOCKET', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_SESSION_TYPE', 'XDG_CURRENT_DESKTOP']}
    gui.update({'PATH': '/usr/local/bin:/usr/bin:/bin', 'LANG': 'en_US.UTF-8'})
    unit = 'kosmozoo-engine.service'
    real_config = Path('/home/tester/.config')
    env_file = real_config / 'kosmozoo/engine.env'
    unit_file = real_config / 'systemd/user' / unit
    def unit_state():
        text = subprocess.check_output(['systemctl', '--user', 'show', unit, '--property=LoadState,ActiveState,MainPID,Result,ExecMainStatus,FragmentPath']).decode()
        return dict(line.split('=', 1) for line in text.splitlines())
    assert unit_state()['LoadState'] == 'not-found', 'Existing unmanaged unit must be preserved'
    assert not unit_file.exists() and not unit_file.is_symlink()
    assert not env_file.exists() and not env_file.is_symlink()
    run = args.evidence.resolve()
    run.parent.resolve(strict=True); run.mkdir(mode=0o700)
    for name in ['home space % "quote"', 'data space % "quote"', 'state', 'cache', 'tmp', 'fixtures']:
        (run / name).mkdir(mode=0o700)
    home, data = run / 'home space % "quote"', run / 'data space % "quote"'
    temporary = Path('/home/tester') / ('kz-instmp-' + hashlib.sha256(str(run).encode()).hexdigest()[:16])
    temporary.symlink_to(run / 'tmp', target_is_directory=True)
    source = Path(__file__).resolve().parents[2]
    shutil.copy2(source / 'tests/fixtures/flux-basic.png', run / 'fixtures/flux-basic.png')
    port = probe.available_port(); origin = f'http://127.0.0.1:{port}'
    debug_port = probe.available_port()
    wrapper = run / 'browser-observer/chromium'; wrapper.parent.mkdir(mode=0o700)
    wrapper.write_text('#!/bin/sh\nexec /usr/bin/chromium --remote-debugging-port=' + str(debug_port) + ' "$@"\n')
    wrapper.chmod(0o755)
    env = {**gui, 'HOME': str(home), 'XDG_DATA_HOME': str(data), 'XDG_CONFIG_HOME': str(real_config),
        'TMPDIR': str(temporary), 'KOZMOZOO_STATE': str(run / 'state'), 'KOZMOZOO_CACHE': str(run / 'cache'),
        'KOZMOZOO_HOSTS': '', 'KOZMOZOO_PORT': str(port), 'KOZMOZOO_BIND': '127.0.0.1'}
    # The real guest's user manager reads its canonical config location. Code/
    # launcher/data paths contain spaces/%/quotes; the explicit engine env file
    # keeps service state/cache/seed entirely on this disposable evidence tree.
    env_file.parent.mkdir(mode=0o700, exist_ok=True)
    def quoted(value):
        return '"' + value.replace('\\', '\\\\').replace('"', '\\"') + '"'
    content = '\n'.join(key + '=' + quoted(value) for key, value in env.items() if key.startswith(('KOZMOZOO_', 'XDG_DATA_HOME')) or key == 'TMPDIR') + '\n'
    with env_file.open('x') as file: file.write(content)
    env_file.chmod(0o600)
    (run / 'engine-env-witness.txt').write_text(content)
    binary, previous = args.binary.resolve(strict=True), args.previous_binary.resolve(strict=True)
    assert probe.sha(binary) != probe.sha(previous)
    launcher = home / '.local/bin/kosmozoo'
    root = data / 'kosmozoo/application'
    menu = data / 'applications/kosmozoo.desktop'
    icon = data / 'icons/hicolor/256x256/apps/kosmozoo.png'
    results = []
    def record(name, **details):
        results.append({'case': name, 'result': 'pass', **details})
        (run / 'results.json').write_text(json.dumps({'binarySha256': probe.sha(binary), 'previousBinarySha256': probe.sha(previous), 'cases': results}, indent=2) + '\n')
        print('PASS:', name, flush=True)
    def cli(executable, arguments, name, expected=0):
        with (run / (name + '.log')).open('xb') as log:
            output = subprocess.run([str(executable), *arguments], env=env, cwd=run, stdout=log, stderr=subprocess.STDOUT, timeout=30)
        text = (run / (name + '.log')).read_text()
        assert output.returncode == expected, (name, output.returncode, text)
        return text
    def ready():
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            try:
                runtime = probe.request(origin, '/api/runtime')
                if runtime['status'] == 'ready': return runtime
            except OSError: pass
            time.sleep(.1)
        raise AssertionError('Managed engine readiness absent')
    def windows(): return json.loads(subprocess.check_output(['niri', 'msg', '--json', 'windows'], env=gui))
    def wait_window():
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            window = next((w for w in windows() if w['title'] == 'kosmozoo'), None)
            if window: return window
            time.sleep(.1)
        raise AssertionError('Managed launcher did not produce app window')
    def close(window):
        subprocess.run(['niri', 'msg', 'action', 'close-window', '--id', str(window['id'])], env=gui, check=True)
        deadline = time.monotonic() + 10
        while windows() and time.monotonic() < deadline: time.sleep(.1)
        assert not windows()
    assert not windows(), 'Native acceptance must have an empty GUI baseline'
    try:
        launcher.parent.mkdir(parents=True, mode=0o700)
        marker = b'owned unmanaged-conflict fixture\n'
        launcher.write_bytes(marker)
        text = cli(binary, ['install'], 'unmanaged-conflict', expected=1)
        assert 'conflict' in text.lower() and launcher.read_bytes() == marker
        assert not unit_file.exists()
        record('unmanaged launcher refused with exact bytes preserved')
        assert launcher.read_bytes() == marker; launcher.unlink()
        cli(previous, ['install'], 'initial-install')
        target_before = os.readlink(root / 'current')
        assert launcher.is_symlink() and menu.is_symlink() and icon.is_symlink() and unit_file.is_symlink()
        assert probe.sha(launcher) == probe.sha(previous)
        assert unit_state()['ActiveState'] == 'inactive'
        subprocess.run(['desktop-file-validate', str(menu)], check=True, env=env)
        receipt = json.loads((root / target_before / 'receipt.json').read_text())
        assert receipt['executableSha256'] == probe.sha(previous)
        record('ordinary install atomically creates managed launcher/unit/menu/icon and leaves service inactive', target=target_before)
        cli(previous, ['install'], 'idempotent-install')
        assert os.readlink(root / 'current') == target_before
        record('same-artifact install is idempotent')
        cli(previous, ['install', '--service'], 'service-opt-in')
        first = ready()
        assert first['mode'] == 'serve' and first['binding'] == {'hostname': '127.0.0.1', 'port': port}
        assert not windows()
        record('explicit service opt-in enables engine-only unit and honors environment-file bind/port', runtime=first)
        probe.request(origin, '/api/collections', {'name': 'fixtures', 'address': 'folder:' + str(run / 'fixtures')})
        probe.request(origin, '/api/collections/fixtures/entries/flux-basic.png/bytes')
        probe.request(origin, '/api/collections/fixtures/entries/flux-basic.png/judgment', {'bookmark': True, 'notes': {'pos': 'retained across installer update'}}, method='PATCH')
        probe.request(origin, '/api/settings/core.releaseInstaller', {'retained': 'explicit native settings witness'}, method='PATCH')
        cli(binary, ['install'], 'active-upgrade')
        second = ready(); target_after = os.readlink(root / 'current')
        assert target_after != target_before and second['instance'] != first['instance']
        assert (root / target_before / 'kosmozoo').is_file()
        assert probe.sha(launcher) == probe.sha(binary)
        judgment = probe.request(origin, '/api/collections/fixtures/entries/flux-basic.png')['judgment']
        assert judgment['bookmark'] is True and judgment['notes']['pos'] == 'retained across installer update'
        record('active atomic upgrade stops/replaces/restarts only managed code and preserves actual judgments', previous=target_before, current=target_after)
        cli(launcher, ['app', '--browser=' + str(wrapper)], 'installed-app')
        window = wait_window()
        assert probe.request(origin, '/api/runtime')['instance'] == second['instance']
        close(window)
        with (run / 'menu-launch.log').open('xb') as log:
            output = subprocess.run(['gio', 'launch', str(menu)], env=env, cwd=run, stdout=log, stderr=subprocess.STDOUT, timeout=30)
        assert output.returncode == 0
        window = wait_window()
        # Observe the final native consumer, not just window creation/API
        # readiness. The fixture wrapper adds only this loopback diagnostic
        # endpoint; app/profile/display arguments still come from the adapter.
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            with socket.socket() as sock:
                if sock.connect_ex(('127.0.0.1', debug_port)) == 0: break
            time.sleep(.1)
        else: raise AssertionError('Native browser diagnostic endpoint absent')
        subprocess.run(['docker', 'run', '--rm', '--pull=never', '--network', 'host',
            '-v', str(source) + ':/work:ro', '-v', str(run) + ':/evidence',
            '-e', 'NATIVE_CDP=http://127.0.0.1:' + str(debug_port), '-e', 'NATIVE_ORIGIN=http://localhost:' + str(port),
            '-e', 'NATIVE_SOURCE=fixtures', '-e', 'NATIVE_RESULT=/evidence/native-menu-consumer.json',
            '--entrypoint', 'node', 'sha256:70e367e0cbf60340a5b5fd562f6247a34eb3196efab9f88a3dd56482d9fe09d2',
            '/work/tests/release/native-browser-read.cjs'], check=True)
        subprocess.run(['grim', str(run / 'installed-menu-app.png')], env=gui, check=True)
        assert probe.request(origin, '/api/runtime')['instance'] == second['instance']
        close(window)
        record('actual desktop entry parses quoted executable path and opens app against existing managed service')
        # Failure fixture belongs entirely to this private test. Preserve the
        # original valid document for explicit test repair; never auto-restart.
        settings = run / 'state/settings.json'
        valid_settings = settings.read_bytes(); (run / 'valid-settings-witness.json').write_bytes(valid_settings)
        corrupt = b'{ deliberate invalid installer acceptance fixture\n'
        settings.write_bytes(corrupt)
        text = cli(previous, ['install'], 'failed-upgrade', expected=1)
        assert 'left stopped' in text
        assert os.readlink(root / 'current') == target_after
        state = unit_state(); assert state['ActiveState'] != 'active' and state['MainPID'] == '0'
        quarantine = list((run / 'state').glob('settings.json.corrupt-*'))
        assert len(quarantine) == 1 and quarantine[0].read_bytes() == corrupt
        assert not settings.exists(), 'Failure recovery silently created replacement settings'
        record('failed quarantining upgrade restores prior code but leaves engine stopped and preserves exact quarantine', state=state, quarantine=str(quarantine[0]))
        # Explicit fixture repair is separate from installer recovery.
        settings.write_bytes(valid_settings)
        subprocess.run(['systemctl', '--user', 'start', unit], check=True)
        ready()
        assert probe.request(origin, '/api/collections/fixtures/entries/flux-basic.png')['judgment'] == judgment
        assert probe.request(origin, '/api/settings/core.releaseInstaller')['retained'] == 'explicit native settings witness'
        record('explicit fixture repair/start retains existing database judgments')
        profile = data / 'kosmozoo/browser/chromium'
        assert profile.is_dir(); cookies = profile / 'Default/Cookies'; inode = cookies.stat().st_ino
        database_sha = probe.sha(run / 'state/metadata.db')
        cli(binary, ['uninstall'], 'uninstall')
        assert not launcher.is_symlink() and not menu.is_symlink() and not icon.is_symlink() and not unit_file.is_symlink()
        assert not (root / 'current').is_symlink()
        assert (root / target_before).is_dir() and (root / target_after).is_dir()
        assert cookies.stat().st_ino == inode and quarantine[0].read_bytes() == corrupt
        assert (run / 'state/metadata.db').is_file() and (run / 'cache').is_dir()
        record('uninstall removes matching links only and retains data/cache/profiles/quarantine/previous versions', profileCookieInode=inode, databaseBeforeStopSha256=database_sha)
        print('NATIVE INSTALLER OUTCOMES PASS; final clean-tree release gates remain required')
    finally:
        # Stop only a unit whose installed fragment belongs to this owned root.
        state = unit_state()
        if unit_file.is_symlink() and os.readlink(unit_file).startswith(str(root)):
            subprocess.run(['systemctl', '--user', 'stop', unit], check=True)
        (run / 'unit-final.json').write_text(json.dumps(unit_state(), indent=2) + '\n')


if __name__ == '__main__': main()
