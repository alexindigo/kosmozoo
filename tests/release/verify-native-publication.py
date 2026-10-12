#!/usr/bin/env python3
"""Complete current-ELF native publication witnesses, never a Docker engine/observer."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time

import publication_vm as vm
import publication_owner as ownership
from publication_input import NativeKeyboard, start_watchdog, finish_resources

HERE = Path(__file__).resolve().parent


def worker(name, arguments, run, uuid, log_name=None):
    vm.command(['/usr/bin/python3', '-B', HERE / 'publication-worker.py', '--worker', name,
                '--expected-vm-uuid', uuid, '--', *arguments], run / ((log_name or name) + '.log'), cwd=run)


def gui_environment():
    session = dict(line.split('=', 1) for line in subprocess.check_output(['systemctl', '--user', 'show-environment'], text=True, timeout=15).splitlines())
    required = ['XDG_RUNTIME_DIR', 'WAYLAND_DISPLAY', 'NIRI_SOCKET', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_SESSION_TYPE', 'XDG_CURRENT_DESKTOP']
    return {**os.environ, **{key: session[key] for key in required}}


def native_firefox_ui(run, phase, keyboard):
    env = gui_environment()
    config = json.loads((run / 'firefox/session.json').read_text())
    def windows():
        return json.loads(subprocess.check_output(['niri', 'msg', '--json', 'windows'], env=env, text=True, timeout=15))
    def phase_ready():
        # Window creation precedes native document/navigation readiness. Admit
        # only the requested, owned page; never act on its initial generic title.
        current = [item for item in windows() if ownership.verified_window(config, item) is not None]
        if phase == 'ordinary-origin':
            return next((item for item in current if 'kosmozoo' in item['title'].lower() or
                         item['title'] == 'Chromium Additional Terms of Service'), None)
        return next((item for item in current if item['app_id'] == 'firefox' and
                     item['title'].startswith('Advanced Preferences')), None)
    window = vm.wait_for(phase_ready, 'Expected owned native page did not reach its requested state')
    if phase == 'ordinary-origin':
        # The product requests the actual default ordinary opener. It need not
        # be Firefox, and its new private HOME can present native first-run UI.
        if window['title'] == 'Chromium Additional Terms of Service':
            keyboard.focus(config, window, env)
            subprocess.run(['grim', str(run / 'ordinary-first-run-before.png')], env=env, check=True, timeout=15)
            keyboard.key('Return')
            vm.wait_for(lambda: any('kosmozoo' in item['title'].lower() for item in windows()), 'Actual ordinary opener did not reach selected engine')
            sentinel = Path(config['env']['XDG_CONFIG_HOME']) / 'chromium/EULA Accepted'
            assert sentinel.is_file(), 'Native browser did not record real Accept; no test-written first-run sentinel'
            subprocess.run(['grim', str(run / 'ordinary-first-run-after.png')], env=env, check=True, timeout=15)
        return
    keyboard.focus(config, window, env)
    subprocess.run(['grim', str(run / ('firefox-ui-' + phase + '-before.png'))], env=env, check=True, timeout=15)
    # Exact observed native focus route: browser tab -> document -> warning
    # button, then the auto-focused search and one filtered Boolean toggle.
    # Capability is selected only via UI; the saved preference is an outcome.
    for key in ['Tab', 'F6', 'Tab', 'Tab', 'Return']:
        keyboard.key(key)
    time.sleep(.5)
    keyboard.text('browser.taskbarTabs.enabled')
    time.sleep(.5)
    for key in ['Tab', 'Tab', 'Return']:
        keyboard.key(key)
    time.sleep(1)
    subprocess.run(['grim', str(run / ('firefox-ui-' + phase + '-after.png'))], env=env, check=True, timeout=15)
    ownership.close_owned_windows(config, env)
    vm.wait_for(lambda: not windows(), 'Disposable Firefox settings did not close')
    prefs = run / 'firefox/home/data/kosmozoo/browser/firefox/prefs.js'
    vm.wait_for(lambda: prefs.exists() and b'user_pref("browser.taskbarTabs.enabled", true);' in prefs.read_bytes(),
                'Native UI did not save the explicitly selected Firefox capability; preserve captures and inspect')


def accept(binary, previous, older_firefox, workspace, evidence, uuid):
    vm.require_vm(uuid)
    run = vm.directory(evidence, fresh=True)
    gui = gui_environment()
    start_watchdog(run, uuid)
    try:
        consumers(binary, previous, older_firefox, workspace, run, uuid)
    finally:
        finish_resources(run, gui, uuid)
    verify_witnesses(run, Path(binary).resolve())
    print('NATIVE PUBLICATION ACCEPTANCE PASS')


def consumers(binary, previous, older_firefox, workspace, evidence, uuid):
    vm.require_vm(uuid)
    workspace = vm.directory(workspace)
    run = vm.directory(evidence)
    binary, previous, older_firefox = [Path(path).resolve(strict=True) for path in [binary, previous, older_firefox]]
    assert vm.sha(binary) != vm.sha(previous), 'Update/recovery needs a genuinely different previous ELF'
    for path in [binary, previous]:
        with path.open('rb') as stream:
            assert stream.read(6) == b'\x7fELF\x02\x01'
    pins = json.loads((HERE.parents[1] / 'packaging/linux/inputs.json').read_text())
    inputs = workspace / 'inputs/build-inputs'
    for pin in pins['inputs'].values():
        path = inputs / pin['relativePath']
        assert path.is_file() and not path.is_symlink() and vm.sha(path) == pin['sha256'], 'Native test input differs from source authority'
    gui = gui_environment()
    assert json.loads(subprocess.check_output(['niri', 'msg', '--json', 'windows'], env=gui, text=True, timeout=15)) == [], 'Unexpected native windows must be preserved'
    vm.json_file(run / 'inputs.json', {'binary': str(binary), 'binarySha256': vm.sha(binary), 'previousBinary': str(previous),
        'previousBinarySha256': vm.sha(previous), 'olderFirefox': str(older_firefox), 'olderFirefoxSha256': vm.sha(older_firefox), 'expectedVmUuid': uuid})
    for name in ['runtime', 'chromium', 'dropins', 'abi', 'installer']:
        arguments = ['--binary', binary, '--evidence', run / name]
        if name == 'abi':
            arguments += ['--inputs', inputs]
        if name == 'installer':
            arguments += ['--previous-binary', previous, '--native-node', '--isolated-config']
        worker(name, arguments, run, uuid)
    vm.command(['/usr/bin/python3', '-B', HERE / 'native-five-suites.py', '--binary', binary, '--workspace', workspace,
                '--evidence', run / 'five-suites', '--expected-vm-uuid', uuid], run / 'five-suites.log', cwd=run, timeout=900)
    vm.command(['/usr/bin/python3', '-B', HERE / 'native-cold.py', '--binary', binary, '--workspace', workspace,
                '--evidence', run / 'cold', '--expected-vm-uuid', uuid], run / 'cold.log', cwd=run)
    firefox_args = ['--binary', binary, '--evidence', run / 'firefox']
    keyboard = NativeKeyboard(run, workspace, uuid)
    try:
        keyboard.start()
        worker('firefox', [*firefox_args, '--phase', 'setup'], run, uuid, 'firefox-setup')
        native_firefox_ui(run, 'ordinary-origin', keyboard)
        worker('firefox', [*firefox_args, '--phase', 'fallback'], run, uuid, 'firefox-fallback')
        worker('firefox', [*firefox_args, '--phase', 'settings'], run, uuid, 'firefox-settings')
        native_firefox_ui(run, 'settings-capability', keyboard)
        worker('firefox', [*firefox_args, '--phase', 'enabled'], run, uuid, 'firefox-enabled')
        worker('firefox', [*firefox_args, '--phase', 'finish'], run, uuid, 'firefox-finish')
        worker('firefox', [*firefox_args, '--phase', 'handoff'], run, uuid, 'firefox-handoff')
        worker('firefox', [*firefox_args, '--phase', 'port-change'], run, uuid, 'firefox-port-change')
        worker('browser-fallbacks', ['--binary', binary, '--evidence', run / 'browser-fallbacks', '--session', run / 'firefox/session.json',
                                   '--older-firefox', older_firefox], run, uuid)
    finally:
        try:
            ownership.retire_firefox(run, gui)
        finally:
            keyboard.retire()


def verify_witnesses(run, binary):
    digest = vm.sha(binary)
    required = {
        'runtime': 'COMPILED RUNTIME CONSUMER PASS', 'chromium': 'NATIVE CHROMIUM OUTCOMES:',
        'dropins': 'COMPILED LOCAL DROP-IN PARITY PASS', 'abi': 'MEASURED GNU ELF/ARCH DEPENDENCY CLOSURE PASS:',
        'installer': 'NATIVE INSTALLER OUTCOMES PASS', 'five-suites': 'NATIVE FIVE SUITES PASS',
        'cold': 'NATIVE BOOKWORM COLD AND FAILURE OUTCOMES PASS', 'browser-fallbacks': 'NATIVE BROWSER FALLBACK OUTCOMES PASS',
        'firefox-fallback': 'FIREFOX DISABLED FALLBACK OBSERVED', 'firefox-enabled': 'FIREFOX ENABLED NATIVE OUTCOMES OBSERVED:',
        'firefox-handoff': 'FIREFOX PROFILE HANDOFF PASS:', 'firefox-port-change': 'FIREFOX PORT OWNERSHIP PASS:',
        'firefox-finish': 'Firefox acceptance engine stopped cleanly',
    }
    for name, marker in required.items():
        assert marker in (run / (name + '.log')).read_text(), 'Mandatory current native witness absent: ' + name
    for name in ['runtime', 'installer', 'cold', 'browser-fallbacks']:
        value = json.loads((run / name / 'results.json').read_text())
        assert value['binarySha256'] == digest and value['cases'] and all(case['result'] == 'pass' for case in value['cases'])
    suites = json.loads((run / 'five-suites/results.json').read_text())
    assert suites['binarySha256'] == digest and suites['engineExitCode'] == 0
    assert [item['suite'] for item in suites['suites']] == ['workbench', 'variations', 'diff', 'cache', 'feed']
    assert all(item['result'] == 'pass' for item in suites['suites'])
    chromium = json.loads((run / 'chromium/results.json').read_text())
    assert chromium['binarySha256'] == digest and chromium['runtime']['status'] == 'ready' and chromium['cookieInode'] > 0
    dropins = json.loads((run / 'dropins/results.json').read_text())
    assert dropins['binarySha256'] == digest and dropins['engineExitCode'] == 0 and len(dropins['routes']) == 2
    assert json.loads((run / 'abi/abi.json').read_text())['files']['binary']['sha256'] == digest
    assert json.loads((run / 'firefox/session.json').read_text())['binarySha256'] == digest
    for name in ['disabled-result', 'enabled-result', 'handoff-result', 'changed-port-result']:
        assert json.loads((run / 'firefox' / (name + '.json')).read_text())['runtime']['status'] == 'ready'
    assert json.loads((run / 'firefox/changed-port-result.json').read_text())['binarySha256'] == digest
    assert 'ExecMainStatus=0' in (run / 'firefox/engine-final.log').read_text()
    assert 'Result=success' in (run / 'firefox/engine-final.log').read_text()
    menu = json.loads((run / 'installer/native-menu-consumer.json').read_text())
    assert menu['source'] == 'fixtures' and menu['decoded'] > 0 and menu['card'] and menu['bookmark'] and menu['note'] == 'retained across installer update'
    vm.json_file(run / 'acceptance.json', {'binarySha256': digest, 'functionalAcceptance': 'pass',
        'route': 'native processes/observers only', 'witnesses': required, 'visualReview': 'separate spatial capture review required'})


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['binary', 'previous-binary', 'older-firefox', 'workspace', 'evidence']:
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--expected-vm-uuid', required=True)
    args = parser.parse_args()
    accept(args.binary, args.previous_binary, args.older_firefox, args.workspace, args.evidence, args.expected_vm_uuid)
