#!/usr/bin/env python3
"""Native Firefox acceptance phases; the operator enables prefs through its UI."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
from importlib.util import module_from_spec, spec_from_file_location

spec = spec_from_file_location('runtime_probe', Path(__file__).with_name('verify-runtime.py'))
probe = module_from_spec(spec); spec.loader.exec_module(probe)


def main():
    probe.require_vm()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--evidence', type=Path, required=True)
    parser.add_argument('--phase', choices=['setup', 'fallback', 'settings', 'enabled', 'handoff', 'port-change', 'finish'], required=True)
    args = parser.parse_args()
    session = dict(line.split('=', 1) for line in subprocess.check_output(['systemctl', '--user', 'show-environment']).decode().splitlines())
    keys = ['XDG_RUNTIME_DIR', 'WAYLAND_DISPLAY', 'NIRI_SOCKET', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_SESSION_TYPE', 'XDG_CURRENT_DESKTOP']
    gui = {key: session[key] for key in keys}
    gui.update({'PATH': '/usr/local/bin:/usr/bin:/bin', 'LANG': 'en_US.UTF-8'})
    run = args.evidence.resolve()
    binary = args.binary.resolve(strict=True)
    if args.phase == 'setup':
        run.parent.resolve(strict=True); run.mkdir(mode=0o700)
        for name in ['home', 'tmp', 'fixtures']:
            (run / name).mkdir(mode=0o700)
        temporary = Path('/home/tester') / ('kz-fftmp-' + hashlib.sha256(str(run).encode()).hexdigest()[:16])
        temporary.symlink_to(run / 'tmp', target_is_directory=True)
        assert temporary.resolve(strict=True) == run / 'tmp'
        source = Path(__file__).resolve().parents[2]
        shutil.copy2(source / 'tests/fixtures/flux-basic.png', run / 'fixtures/flux-basic.png')
        port = probe.available_port()
        env = {**gui, 'HOME': str(run / 'home'), 'XDG_DATA_HOME': str(run / 'home/data'),
            'XDG_CONFIG_HOME': str(run / 'home/config'), 'XDG_STATE_HOME': str(run / 'home/state'),
            'TMPDIR': str(temporary), 'KOZMOZOO_HOSTS': 'fixture=folder:' + str(run / 'fixtures'),
            'KOZMOZOO_BIND': '127.0.0.1', 'KOZMOZOO_PORT': str(port), 'BROWSER': '/usr/bin/firefox'}
        unit = 'kz-native-firefox-' + run.name
        config = {'env': env, 'unit': unit, 'origin': f'http://127.0.0.1:{port}', 'binarySha256': probe.sha(binary)}
        (run / 'session.json').write_text(json.dumps(config, indent=2) + '\n')
    else:
        config = json.loads((run / 'session.json').read_text())
        if args.phase != 'port-change': assert probe.sha(binary) == config['binarySha256']
    env, unit, origin = config['env'], config['unit'], config['origin']
    profile = run / 'home/data/kosmozoo/browser/firefox'

    def windows():
        return json.loads(subprocess.check_output(['niri', 'msg', '--json', 'windows'], env=gui))

    def wait_for(predicate, message, timeout=30):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            value = predicate()
            if value: return value
            time.sleep(.1)
        raise AssertionError(message)

    def cli(arguments, name):
        path = run / (name + '.log')
        number = 2
        while path.exists():
            path = run / (name + '-' + str(number) + '.log'); number += 1
        with path.open('xb') as log:
            result = subprocess.run([str(binary), *arguments], env=env, cwd=run,
                stdout=log, stderr=subprocess.STDOUT, timeout=30)
        assert result.returncode == 0, path.read_text()
        return path.read_text()

    def capture(name, window):
        subprocess.run(['niri', 'msg', 'action', 'focus-window', '--id', str(window['id'])], env=gui, check=True)
        time.sleep(.5)
        subprocess.run(['grim', str(run / (name + '.png'))], env=gui, check=True)
        (run / (name + '.json')).write_text(json.dumps(windows(), indent=2) + '\n')

    if args.phase == 'setup':
        assert not windows(), 'Native GUI baseline must be empty for isolated acceptance'
        command = ['systemd-run', '--user', '--unit=' + unit, '--working-directory=' + str(run),
            '--property=StandardOutput=file:' + str(run / 'engine.log'), '--property=StandardError=file:' + str(run / 'engine.log')]
        command += ['--setenv=' + key + '=' + value for key, value in env.items()]
        subprocess.run([*command, str(binary), 'serve'], check=True, env=gui)
        def ready():
            try: return probe.request(origin, '/api/runtime')
            except OSError: return None
        runtime = wait_for(ready, 'Engine readiness absent')
        (run / 'runtime.json').write_text(json.dumps(runtime, indent=2) + '\n')
        text = cli(['app', '--browser=/usr/bin/firefox'], 'disabled-launch')
        assert 'disabled in the dedicated profile' in text and 'browser.taskbarTabs.enabled' in text
        assert 'Regular-browser URL: http://localhost:' in text
        assert not (profile / 'user.js').exists() and not (profile / 'prefs.js').exists(), 'Disabled probe changed dedicated preferences'
        saved = json.loads((run / 'home/data/kosmozoo/launcher.json').read_text())
        assert saved['browser'] == '/usr/bin/firefox', 'Supported-disabled explicit choice was not retained for settings/relaunch'
        print('Disabled Firefox fallback requested. Complete any native first-run UI in the disposable ordinary browser, then run fallback phase.')
    elif args.phase == 'fallback':
        runtime = probe.request(origin, '/api/runtime')
        text = (run / 'disabled-launch.log').read_text()
        assert not (profile / 'user.js').exists() and not (profile / 'prefs.js').exists(), 'Disabled probe changed dedicated preferences'
        ordinary = wait_for(lambda: next((w for w in windows() if 'kosmozoo' in w['title'].lower()), None), 'Firefox regular-browser fallback did not reach Kosmozoo')
        capture('firefox-disabled-fallback', ordinary)
        (run / 'disabled-result.json').write_text(json.dumps({'runtime': runtime, 'window': ordinary,
            'noDedicatedPreferenceWrites': True, 'fallbackLog': text}, indent=2) + '\n')
        for window in windows():
            subprocess.run(['niri', 'msg', 'action', 'close-window', '--id', str(window['id'])], env=gui, check=True)
        wait_for(lambda: not windows(), 'Fallback browser did not close')
        print('FIREFOX DISABLED FALLBACK OBSERVED; capture needs spatial review')
    elif args.phase == 'settings':
        assert not windows(), 'Close preceding test windows before dedicated settings'
        cli(['browser-settings', 'firefox'], 'settings-launch')
        window = wait_for(lambda: next((w for w in windows() if 'firefox' in w['app_id'].lower()), None), 'Dedicated settings window absent')
        capture('firefox-settings', window)
        assert profile.is_dir() and not (profile / 'user.js').exists()
        print('Dedicated about:config window requested; enable browser.taskbarTabs.enabled using native UI, then close Firefox before enabled phase')
    elif args.phase == 'enabled':
        assert not windows(), 'Firefox must save the UI preference before native app launch'
        prefs = (profile / 'prefs.js').read_bytes()
        assert b'user_pref("browser.taskbarTabs.enabled", true);' in prefs
        (run / 'enabled-prefs-before.js').write_bytes(prefs)
        runtime = probe.request(origin, '/api/runtime')
        text = cli(['app'], 'enabled-launch')
        assert 'Regular-browser URL' not in text
        window = wait_for(lambda: next((w for w in windows() if 'kosmozoo' in w['title'].lower()), None), 'Firefox app did not render')
        capture('firefox-enabled-app', window)
        # Firefox itself updates its startup/update timestamps when opening.
        # Observe the user-selected capability rather than mistaking that native
        # housekeeping for launcher preference changes; retain both witnesses.
        after = (profile / 'prefs.js').read_bytes()
        (run / 'enabled-prefs-after.js').write_bytes(after)
        assert b'user_pref("browser.taskbarTabs.enabled", true);' in after
        assert not (profile / 'user.js').exists(), 'Launcher created an automatic preference override'
        registry = profile / 'taskbartabs/taskbartabs.json'
        wait_for(registry.exists, 'Firefox native registry was not created by the browser')
        registered = registry.read_bytes()
        subprocess.run(['niri', 'msg', 'action', 'close-window', '--id', str(window['id'])], env=gui, check=True)
        wait_for(lambda: not windows(), 'App window did not close')
        assert probe.request(origin, '/api/runtime')['instance'] == runtime['instance']
        cli(['app', '--browser=/usr/bin/firefox'], 'enabled-repeat')
        repeated = wait_for(lambda: next((w for w in windows() if 'kosmozoo' in w['title'].lower()), None), 'Repeated Firefox app absent')
        capture('firefox-enabled-repeat', repeated)
        assert probe.request(origin, '/api/runtime')['instance'] == runtime['instance']
        assert registry.read_bytes() == registered, 'Repeated launch did not reuse the native registration'
        (run / 'enabled-result.json').write_text(json.dumps({'runtime': runtime, 'window': window, 'repeated': repeated,
            'nativeRegistrySha256': hashlib.sha256(registered).hexdigest(), 'profile': str(profile), 'result': 'observed; visual-review-required'}, indent=2) + '\n')
        for window in windows():
            subprocess.run(['niri', 'msg', 'action', 'close-window', '--id', str(window['id'])], env=gui, check=True)
        print('FIREFOX ENABLED NATIVE OUTCOMES OBSERVED: app/repeat/private profile/native registry and retained engine')
    elif args.phase == 'handoff':
        assert not windows()
        ordinary = run / 'ordinary-profile'; ordinary.mkdir(mode=0o700)
        registry = profile / 'taskbartabs/taskbartabs.json'; before = registry.read_bytes()
        new_unit = unit + '-handoff'
        command = ['systemd-run', '--user', '--unit=' + new_unit, '--working-directory=' + str(run),
            '--property=StandardOutput=file:' + str(run / 'handoff-engine.log'),
            '--property=StandardError=file:' + str(run / 'handoff-engine.log')]
        command += ['--setenv=' + key + '=' + value for key, value in env.items()]
        subprocess.run([*command, str(binary), 'serve'], env=gui, check=True)
        with (run / 'ordinary-browser.log').open('xb') as log:
            browser_process = subprocess.Popen(['/usr/bin/firefox', '--new-instance', '-profile', str(ordinary), '-new-window', 'about:blank'],
                env=env, stdout=log, stderr=subprocess.STDOUT)
        try:
            def handoff_ready():
                try: return probe.request(origin, '/api/runtime')
                except OSError: return None
            runtime = wait_for(handoff_ready, 'Handoff engine readiness absent')
            wait_for(lambda: windows(), 'Ordinary Firefox instance absent')
            cli(['app', '--browser=/usr/bin/firefox'], 'handoff-first')
            app = wait_for(lambda: next((w for w in windows() if w['app_id'].startswith('firefox.webapp-') and 'kosmozoo' in w['title'].lower()), None),
                'Dedicated Firefox app was routed into the ordinary profile')
            assert app['pid'] != browser_process.pid
            cli(['app'], 'handoff-repeat')
            apps = wait_for(lambda: [w for w in windows() if w['app_id'].startswith('firefox.webapp-')], 'Live dedicated-profile handoff failed')
            assert all(w['pid'] == app['pid'] for w in apps)
            assert registry.read_bytes() == before and not (ordinary / 'taskbartabs/taskbartabs.json').exists()
            assert probe.request(origin, '/api/runtime')['instance'] == runtime['instance']
            capture('firefox-ordinary-profile-isolation-handoff', apps[-1])
            (run / 'handoff-result.json').write_text(json.dumps({'runtime': runtime, 'ordinaryPid': browser_process.pid,
                'dedicatedApps': apps, 'nativeRegistryUnchanged': True, 'ordinaryRegistryAbsent': True}, indent=2) + '\n')
            print('FIREFOX PROFILE HANDOFF PASS: separate ordinary process, one live dedicated process, repeated native apps and same engine')
        finally:
            for window in windows(): subprocess.run(['niri', 'msg', 'action', 'close-window', '--id', str(window['id'])], env=gui, check=True)
            browser_process.wait(timeout=30)
            subprocess.run(['systemctl', '--user', 'stop', new_unit], check=True)
    elif args.phase == 'port-change':
        assert not windows(), 'Port-change acceptance starts with owned windows closed'
        env = env.copy()
        env['KOZMOZOO_PORT'] = str(probe.available_port())
        origin = 'http://127.0.0.1:' + env['KOZMOZOO_PORT']
        new_unit = unit + '-changed-port'
        registry = profile / 'taskbartabs/taskbartabs.json'; before = registry.read_bytes()
        command = ['systemd-run', '--user', '--unit=' + new_unit, '--working-directory=' + str(run),
            '--property=StandardOutput=file:' + str(run / 'changed-port-engine.log'),
            '--property=StandardError=file:' + str(run / 'changed-port-engine.log')]
        command += ['--setenv=' + key + '=' + value for key, value in env.items()]
        subprocess.run([*command, str(binary), 'serve'], env=gui, check=True)
        try:
            def changed_ready():
                try: return probe.request(origin, '/api/runtime')
                except OSError: return None
            runtime = wait_for(changed_ready, 'Changed-port engine readiness absent')
            text = cli(['app', '--browser=/usr/bin/firefox'], 'changed-port-launch')
            assert 'registration points to a different URL' in text and ('http://localhost:' + env['KOZMOZOO_PORT'] + '/') in text
            window = wait_for(lambda: next((w for w in windows() if 'kosmozoo' in w['title'].lower()), None), 'Chosen-port regular-browser consumer absent')
            capture('firefox-changed-port-fallback', window)
            assert registry.read_bytes() == before, 'Native registration was rewritten to force another URL'
            assert probe.request(origin, '/api/runtime')['instance'] == runtime['instance']
            (run / 'changed-port-result.json').write_text(json.dumps({'runtime': runtime, 'window': window,
                'registryUnchanged': True, 'binarySha256': probe.sha(binary), 'reasonLog': text}, indent=2) + '\n')
            for window in windows(): subprocess.run(['niri', 'msg', 'action', 'close-window', '--id', str(window['id'])], env=gui, check=True)
            print('FIREFOX PORT OWNERSHIP PASS: correct selected-origin fallback and preserved native registration')
        finally:
            subprocess.run(['systemctl', '--user', 'stop', new_unit], check=True)
    else:
        assert not windows(), 'Close owned Firefox test windows before finishing'
        subprocess.run(['systemctl', '--user', 'stop', unit], check=True)
        output = subprocess.check_output(['systemctl', '--user', 'show', unit, '--property=ExecMainStatus,Result,MainPID']).decode()
        (run / 'engine-final.log').write_text(output)
        assert 'ExecMainStatus=0' in output and 'Result=success' in output
        print('Firefox acceptance engine stopped cleanly')


if __name__ == '__main__': main()
