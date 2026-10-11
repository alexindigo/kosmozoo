#!/usr/bin/env python3
"""Native Chromium windows/profile handoff with the actual compiled launcher."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import urllib.request

from importlib.util import module_from_spec, spec_from_file_location
spec = spec_from_file_location('runtime_probe', Path(__file__).with_name('verify-runtime.py'))
runtime_probe = module_from_spec(spec); spec.loader.exec_module(runtime_probe)


def main():
    runtime_probe.require_vm()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--evidence', type=Path, required=True)
    args = parser.parse_args()
    args.evidence.parent.resolve(strict=True)
    args.evidence.mkdir(mode=0o700)
    run = args.evidence.resolve()
    binary = args.binary.resolve(strict=True)
    source = Path(__file__).resolve().parents[2]
    for name in ['home', 'tmp', 'fixtures']:
        (run / name).mkdir(mode=0o700)
    # Observe native app/profile/window outcomes, not Chromium's AF_UNIX path
    # limit on the deliberately verbose evidence location. A short private alias
    # retains all actual temp bytes on the same approved disk-backed directory.
    temporary = Path('/home/tester') / ('kz-tmp-' + hashlib.sha256(str(run).encode()).hexdigest()[:16])
    temporary.symlink_to(run / 'tmp', target_is_directory=True)
    assert temporary.resolve(strict=True) == run / 'tmp'
    (run / 'temp-alias.json').write_text(json.dumps({'alias': str(temporary), 'actual': str(run / 'tmp')}) + '\n')
    shutil.copy2(source / 'tests/fixtures/flux-basic.png', run / 'fixtures/flux-basic.png')
    session = dict(line.split('=', 1) for line in subprocess.check_output(['systemctl', '--user', 'show-environment']).decode().splitlines())
    gui = {**os.environ, **{key: session[key] for key in ['XDG_RUNTIME_DIR', 'WAYLAND_DISPLAY', 'NIRI_SOCKET', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_SESSION_TYPE', 'XDG_CURRENT_DESKTOP']}}
    env = {**gui, 'HOME': str(run / 'home'), 'XDG_DATA_HOME': str(run / 'home/data'),
           'XDG_STATE_HOME': str(run / 'home/state'), 'XDG_CONFIG_HOME': str(run / 'home/config'),
           'TMPDIR': str(temporary), 'KOZMOZOO_HOSTS': 'fixture=folder:' + str(run / 'fixtures')}
    for key in list(env):
        if key.startswith('DENO_') or key in ['KOZMOZOO_BIND', 'KOZMOZOO_PORT', 'KOZMOZOO_PLUGINS', 'KOZMOZOO_CACHE', 'KOZMOZOO_STATE']:
            del env[key]
    origin = 'http://127.0.0.1:2084'
    with __import__('socket').socket() as sock:
        sock.bind(('127.0.0.1', 2084))
    unit = 'kz-native-chromium-' + run.name
    assert subprocess.run(['systemctl', '--user', 'is-active', unit], capture_output=True).returncode != 0
    initial = json.loads(subprocess.check_output(['niri', 'msg', '--json', 'windows'], env=gui))
    initial_ids = {window['id'] for window in initial}
    started = False

    def windows():
        return json.loads(subprocess.check_output(['niri', 'msg', '--json', 'windows'], env=gui))

    def wait_for(predicate, message, timeout=30):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            result = predicate()
            if result:
                return result
            time.sleep(0.1)
        raise AssertionError(message)

    def app_window():
        return next((window for window in windows() if window['id'] not in initial_ids and window['title'] == 'kosmozoo'), None)

    def capture(name, window):
        subprocess.run(['niri', 'msg', 'action', 'focus-window', '--id', str(window['id'])], env=gui, check=True)
        time.sleep(0.5)
        subprocess.run(['grim', str(run / (name + '.png'))], env=gui, check=True)
        (run / (name + '.json')).write_text(json.dumps(windows(), indent=2) + '\n')

    try:
        command = ['systemd-run', '--user', '--unit=' + unit, '--working-directory=' + str(run),
                   '--property=StandardOutput=file:' + str(run / 'launcher.log'),
                   '--property=StandardError=file:' + str(run / 'launcher.log')]
        command += ['--setenv=' + key + '=' + value for key, value in env.items()]
        command += [str(binary), 'app', '--browser=/usr/bin/chromium']
        subprocess.run(command, env=gui, check=True)
        started = True
        def ready():
            try:
                return runtime_probe.request(origin, '/api/runtime')
            except OSError:
                return None
        runtime = wait_for(ready, 'Compiled app readiness missing')
        assert runtime['binding'] == {'hostname': '127.0.0.1', 'port': 2084}, runtime
        assert runtime['mode'] == 'app'
        window = wait_for(app_window, 'Native Chromium app window not rendered')
        capture('chromium-first-window', window)
        profile = run / 'home/data/kosmozoo/browser/chromium'
        wait_for(lambda: (profile / 'Default/Cookies').is_file(), 'Persistent Chromium profile was not created')
        cookie_inode = (profile / 'Default/Cookies').stat().st_ino
        subprocess.run(['niri', 'msg', 'action', 'close-window', '--id', str(window['id'])], env=gui, check=True)
        wait_for(lambda: app_window() is None, 'Browser window did not close')
        assert runtime_probe.request(origin, '/api/runtime')['instance'] == runtime['instance']
        # Browser children intentionally inherit launcher diagnostics. A pipe
        # waits for inherited browser descriptors even after the launcher exits;
        # measure launcher process exit itself and retain native logs in a file.
        with (run / 'repeat-launch.log').open('xb') as repeat_log:
            output = subprocess.run([str(binary), 'app', '--browser=/usr/bin/chromium'], env=env, cwd=run,
                                    stdout=repeat_log, stderr=subprocess.STDOUT, timeout=30)
        assert output.returncode == 0 and 'Reusing app engine' in (run / 'repeat-launch.log').read_text(), output
        repeated = wait_for(app_window, 'Repeated native app window missing')
        capture('chromium-repeated-window', repeated)
        assert (profile / 'Default/Cookies').stat().st_ino == cookie_inode
        assert runtime_probe.request(origin, '/api/runtime')['instance'] == runtime['instance']
        processes = []
        for directory in Path('/proc').iterdir():
            if not directory.name.isdigit():
                continue
            try:
                argv = (directory / 'cmdline').read_bytes().replace(b'\0', b' ').decode()
                if '--user-data-dir=' + str(profile) in argv and '--app=http://localhost:2084/' in argv:
                    processes.append({'pid': int(directory.name), 'argv': argv})
            except (OSError, UnicodeError):
                pass
        assert processes, 'Actual native browser process lacks app/private-profile arguments'
        (run / 'results.json').write_text(json.dumps({'binarySha256': runtime_probe.sha(binary), 'runtime': runtime,
             'firstWindow': window, 'repeatedWindow': repeated, 'profile': str(profile), 'cookieInode': cookie_inode,
             'processes': processes, 'result': 'native-window-and-profile-outcomes-observed; visual-review-required'}, indent=2) + '\n')
        subprocess.run(['niri', 'msg', 'action', 'close-window', '--id', str(repeated['id'])], env=gui, check=True)
        print('NATIVE CHROMIUM OUTCOMES: first/repeated window, private persistent profile, one surviving engine; review captures for app chrome')
    finally:
        for window in windows():
            if window['id'] in initial_ids:
                continue
            try:
                argv = Path(f"/proc/{window['pid']}/cmdline").read_bytes().replace(b'\0', b' ').decode()
                if '--user-data-dir=' + str(run / 'home/data/kosmozoo/browser/chromium') in argv:
                    subprocess.run(['niri', 'msg', 'action', 'close-window', '--id', str(window['id'])], env=gui, check=True)
            except FileNotFoundError:
                pass
        if started:
            subprocess.run(['systemctl', '--user', 'stop', unit], check=True)
            details = subprocess.check_output(['systemctl', '--user', 'show', unit, '--property=ExecMainStatus,Result,MainPID']).decode()
            (run / 'unit-final.log').write_text(details)
            assert 'ExecMainStatus=0' in details and 'Result=success' in details, details


if __name__ == '__main__':
    main()
