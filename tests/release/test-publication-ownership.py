#!/usr/bin/env python3
"""Real native unit failed-path ownership and bounded-life tests. VM only."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import unittest

import publication_owner as owner
import publication_vm as vm
from publication_input import NativeKeyboard, daemon_state, devices

ROOT = Path('/home/tester/kosmozoo-aur-release')
BINARY = ROOT / 'artifacts/retained-f0f1cf3'
UUID = '0053e86d-8233-49eb-97e0-4055e5428be7'


class OwnershipContracts(unittest.TestCase):
    def setUp(self):
        vm.require_vm(UUID)
        self.root = Path(tempfile.mkdtemp(prefix='owned-publication-contract-', dir=ROOT / 'tmp'))
        self.names = []
        self.keyboards = []
        self.firefox = []
        self.children = []
        self.gui = {**os.environ, **dict(line.split('=', 1) for line in subprocess.check_output(
            ['systemctl', '--user', 'show-environment'], text=True, timeout=15).splitlines())}

    def boot(self, token, suffix, lifetime=45):
        root = self.root / suffix; root.mkdir(mode=0o700)
        for name in ['home', 'state', 'tmp', 'cache']: (root / name).mkdir(mode=0o700)
        with socket.socket() as sock: sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
        name = 'kz-owner-test-' + hashlib.sha256(str(root).encode()).hexdigest()[:16]
        env = {'HOME': str(root / 'home'), 'XDG_STATE_HOME': str(root / 'state'), 'KOZMOZOO_CACHE': str(root / 'cache'),
               'KOZMOZOO_HOSTS': '', 'KOZMOZOO_PORT': str(port), 'KOZMOZOO_BIND': '127.0.0.1',
               'TMPDIR': str(root / 'tmp'), 'KZ_PUBLICATION_OWNER': token}
        self.names.append(name)
        subprocess.run(['systemd-run', '--user', '--unit=' + name, '--property=RuntimeMaxSec=' + str(lifetime),
            '--property=TimeoutStopSec=30', '--property=StandardOutput=file:' + str(root / 'engine.log'),
            '--property=StandardError=inherit', *['--setenv=' + key + '=' + value for key, value in env.items()], str(BINARY), 'serve'], check=True, timeout=30)
        vm.wait_for(lambda: int(owner.unit_state(name)['MainPID']) > 0, 'Real test engine did not start')
        vm.wait_for(lambda: (root / 'state/kosmozoo/engine-instance.json').exists(), 'Real test engine ownership metadata absent')
        return {'unit': name, 'env': env, 'publicationOwner': {'token': token, 'binary': str(BINARY), 'binarySha256': vm.sha(BINARY)}}, root

    def tearDown(self):
        # Only this test's explicitly created unit names; never a shared product
        # unit or another fixture. All state/log/config directories remain.
        for run in self.firefox:
            owner.retire_firefox(run, self.gui)
        for keyboard in self.keyboards:
            keyboard.retire()
        for child in self.children:
            if child.poll() is None:
                child.terminate()
                child.wait(timeout=15)
        for name in self.names:
            if owner.unit_state(name)['LoadState'] != 'not-found':
                subprocess.run(['systemctl', '--user', 'stop', name], check=True, timeout=35)

    def test_failure_finally_stops_owned_engine_and_preserves_foreign_and_data(self):
        own, root = self.boot('owned-run-token', 'own')
        other, foreign = self.boot('foreign-run-token', 'foreign')
        witness = root / 'retained-work'; witness.write_bytes(b'owned unsaved fixture\n')
        marker = foreign / 'retained-work'; marker.write_bytes(b'foreign fixture\n')
        try:
            raise RuntimeError('deliberate owned aggregate failure')
        except RuntimeError:
            owner.retire_engine(own, own['unit'])
        self.assertEqual(owner.unit_state(own['unit'])['MainPID'], '0')
        self.assertGreater(int(owner.unit_state(other['unit'])['MainPID']), 0)
        wrong = {**other, 'publicationOwner': {**other['publicationOwner'], 'token': 'wrong-token'}}
        with self.assertRaisesRegex(RuntimeError, 'owner/private HOME differs'):
            owner.retire_engine(wrong, other['unit'])
        self.assertGreater(int(owner.unit_state(other['unit'])['MainPID']), 0)
        self.assertEqual(witness.read_bytes(), b'owned unsaved fixture\n')
        self.assertEqual(marker.read_bytes(), b'foreign fixture\n')

    def test_separate_unit_deadline_bounds_life_without_parent_finally(self):
        config, root = self.boot('deadline-token', 'deadline', lifetime=2)
        witness = root / 'retained-work'; witness.write_bytes(b'bounded fixture\n')
        vm.wait_for(lambda: owner.unit_state(config['unit'])['MainPID'] == '0', 'Separate unit deadline did not retire engine', timeout=10)
        self.assertEqual(witness.read_bytes(), b'bounded fixture\n')
        self.assertTrue((root / 'state/kosmozoo/metadata.db').is_file())

    def windows(self):
        return json.loads(subprocess.check_output(['niri', 'msg', '--json', 'windows'], env=self.gui, text=True, timeout=15))

    def setup_firefox(self, name):
        run = self.root / name; run.mkdir(mode=0o700)
        self.firefox.append(run)
        vm.command(['python3', '-B', Path(__file__).with_name('publication-worker.py'), '--worker', 'firefox',
            '--expected-vm-uuid', UUID, '--', '--binary', BINARY, '--evidence', run / 'firefox', '--phase', 'setup'],
            run / 'setup.log', env=self.gui, timeout=90)
        config = json.loads((run / 'firefox/session.json').read_text())
        window = vm.wait_for(lambda: next((w for w in self.windows() if w['title'] == 'Chromium Additional Terms of Service'), None), 'Native terms absent')
        return run, config, window

    def keyboard(self, run, lifetime=90):
        value = NativeKeyboard(run, ROOT, UUID)
        self.keyboards.append(value)
        value.start(lifetime=lifetime)
        return value

    def test_standard_first_key_reaches_two_fresh_native_clients_without_virtual_remap(self):
        for name in ['fresh-first', 'fresh-repeat']:
            run, config, window = self.setup_firefox(name)
            keyboard = self.keyboard(run)
            keyboard.focus(config, window, self.gui)
            keyboard.key('Return')
            vm.wait_for(lambda: any('kosmozoo' in w['title'].lower() for w in self.windows()), 'First physical Return did not reach actual ordinary consumer')
            sentinel = Path(config['env']['XDG_CONFIG_HOME']) / 'chromium/EULA Accepted'
            self.assertTrue(sentinel.is_file(), 'Browser did not record native Accept')
            self.assertTrue((Path(config['env']['HOME']) / 'state/kosmozoo/metadata.db').exists())
            owner.retire_firefox(run, self.gui)
            vm.wait_for(lambda: not self.windows(), 'Owned native browser did not retire')
            keyboard.retire()
            self.assertTrue(sentinel.exists(), 'Retirement discarded profile outcome')

    def test_input_deadline_retires_only_owned_device_and_preserves_socket_evidence(self):
        run = self.root / 'deadline-input'; run.mkdir(mode=0o700)
        keyboard = self.keyboard(run, lifetime=3)
        socket_path = Path(keyboard.config['socket']); inode = socket_path.stat().st_ino
        device = keyboard.config['device']
        vm.wait_for(lambda: daemon_state(keyboard.config['unit'])['MainPID'] == '0', 'Separate input lifetime not bounded', timeout=10)
        vm.wait_for(lambda: device not in devices(), 'Timed-out owned input device retained', timeout=10)
        self.assertEqual(socket_path.stat().st_ino, inode)
        self.assertTrue((run / 'native-input-ready.json').exists())

    def test_failed_parent_watchdog_preserves_foreign_ui_engine_data_and_configs(self):
        run, config, window = self.setup_firefox('abort')
        keyboard = self.keyboard(run)
        foreign, foreign_root = self.boot('foreign-watch-token', 'foreign-watch')
        profile = foreign_root / 'profile'; tmp = vm.short_temporary(foreign_root / 'tmp', ROOT)
        with (foreign_root / 'browser.log').open('xb') as log:
            browser = subprocess.Popen(['/usr/bin/chromium', '--no-first-run', '--ozone-platform=wayland',
                '--user-data-dir=' + str(profile), 'about:blank'], env={**self.gui, 'TMPDIR': str(tmp)},
                cwd=foreign_root, stdout=log, stderr=subprocess.STDOUT)
        self.children.append(browser)
        foreign_window = vm.wait_for(lambda: next((w for w in self.windows() if w['pid'] != window['pid']), None), 'Foreign native control window absent')
        with self.assertRaisesRegex(RuntimeError, 'not an owned'):
            keyboard.focus(config, foreign_window, self.gui)
        wrong = {**keyboard.config, 'token': 'unrelated-token'}
        actual = keyboard.config; keyboard.config = wrong
        with self.assertRaisesRegex(RuntimeError, 'identity differs'):
            keyboard.retire()
        keyboard.config = actual
        self.assertGreater(int(daemon_state(actual['unit'])['MainPID']), 0)
        marker = run / 'retained-work'; marker.write_bytes(b'unsaved own work\n')
        other_marker = foreign_root / 'retained-work'; other_marker.write_bytes(b'foreign work\n')
        canonical = Path('/home/tester/.config/kosmozoo/engine.env'); before = canonical.read_bytes()
        parent = subprocess.Popen(['/usr/bin/sleep', '60']); self.children.append(parent)
        identity = owner.process_identity(parent.pid)
        watcher = subprocess.Popen(['python3', '-B', Path(__file__).with_name('publication_input.py'),
            '--watch', run, '--parent', str(parent.pid), '--start-time', identity['startTime'],
            '--lifetime', '20', '--expected-vm-uuid', UUID], env=self.gui)
        self.children.append(watcher)
        parent.terminate(); parent.wait(timeout=15)
        self.assertEqual(watcher.wait(timeout=45), 0)
        self.assertEqual(owner.unit_state(config['unit'])['MainPID'], '0')
        self.assertEqual(daemon_state(actual['unit'])['MainPID'], '0')
        self.assertNotIn(actual['device'], devices())
        self.assertTrue(any(w['id'] == foreign_window['id'] for w in self.windows()))
        self.assertGreater(int(owner.unit_state(foreign['unit'])['MainPID']), 0)
        self.assertEqual(marker.read_bytes(), b'unsaved own work\n')
        self.assertEqual(other_marker.read_bytes(), b'foreign work\n')
        self.assertEqual(canonical.read_bytes(), before)
        # Retire only this explicitly created control browser, never a foreign
        # window through the aggregate's ownership routine.
        subprocess.run(['niri', 'msg', 'action', 'close-window', '--id', str(foreign_window['id'])], env=self.gui, check=True, timeout=15)
        browser.wait(timeout=15)

    def test_watchdog_deadline_retires_native_resources_while_parent_is_still_alive(self):
        run, config, window = self.setup_firefox('bounded-parent')
        keyboard = self.keyboard(run)
        marker = run / 'retained-draft'; marker.write_bytes(b'deadline-owned draft\n')
        parent = subprocess.Popen(['/usr/bin/sleep', '60']); self.children.append(parent)
        identity = owner.process_identity(parent.pid)
        watcher = subprocess.Popen(['python3', '-B', Path(__file__).with_name('publication_input.py'),
            '--watch', run, '--parent', str(parent.pid), '--start-time', identity['startTime'],
            '--lifetime', '2', '--expected-vm-uuid', UUID], env=self.gui)
        self.children.append(watcher)
        self.assertEqual(watcher.wait(timeout=45), 0)
        self.assertIsNone(parent.poll(), 'Deadline test accidentally killed the parent')
        self.assertEqual(owner.unit_state(config['unit'])['MainPID'], '0')
        self.assertEqual(daemon_state(keyboard.config['unit'])['MainPID'], '0')
        self.assertNotIn(keyboard.config['device'], devices())
        self.assertFalse(any(w['id'] == window['id'] for w in self.windows()))
        self.assertEqual(marker.read_bytes(), b'deadline-owned draft\n')
        self.assertTrue((run / 'firefox/session.json').exists())

    def test_private_firefox_explicit_owner_survives_different_caller_cwd(self):
        run, config, window = self.setup_firefox('caller-cwd')
        owner.close_owned_windows(config, self.gui)
        ordinary = run / 'firefox/ordinary-profile'; ordinary.mkdir(mode=0o700)
        with (run / 'ordinary.log').open('xb') as log:
            browser = subprocess.Popen(['/usr/bin/firefox', '--new-instance', '-profile', str(ordinary),
                '-new-window', 'about:blank'], env=config['env'], cwd=self.root, stdout=log, stderr=subprocess.STDOUT)
        self.children.append(browser)
        control = vm.wait_for(lambda: next((w for w in self.windows() if w['pid'] == browser.pid), None), 'Actual private ordinary Firefox control absent')
        identity = owner.verified_window(config, control)
        self.assertIsNotNone(identity, 'Explicit private run ownership was lost at a caller cwd boundary')
        self.assertEqual(identity['cwd'], str(self.root))
        owner.close_owned_windows(config, self.gui)
        browser.wait(timeout=15)
        self.assertTrue(ordinary.exists(), 'Normal retirement discarded private browser profile')
        self.assertGreater(int(owner.unit_state(config['unit'])['MainPID']), 0, 'UI retirement accidentally stopped engine')

    def test_native_settings_admits_owned_document_and_saves_ui_capability(self):
        run, config, window = self.setup_firefox('settings-document')
        keyboard = self.keyboard(run)
        spec = importlib.util.spec_from_file_location('native_acceptance', Path(__file__).with_name('verify-native-publication.py'))
        acceptance = importlib.util.module_from_spec(spec); spec.loader.exec_module(acceptance)
        acceptance.native_firefox_ui(run, 'ordinary-origin', keyboard)
        for phase in ['fallback', 'settings']:
            vm.command(['python3', '-B', Path(__file__).with_name('publication-worker.py'), '--worker', 'firefox',
                '--expected-vm-uuid', UUID, '--', '--binary', BINARY, '--evidence', run / 'firefox', '--phase', phase],
                run / (phase + '.log'), env=self.gui, timeout=90)
        acceptance.native_firefox_ui(run, 'settings-capability', keyboard)
        prefs = Path(config['env']['XDG_DATA_HOME']) / 'kosmozoo/browser/firefox/prefs.js'
        self.assertIn(b'user_pref("browser.taskbarTabs.enabled", true);', prefs.read_bytes())
        self.assertFalse((prefs.parent / 'user.js').exists())
        self.assertFalse(self.windows())


if __name__ == '__main__': unittest.main()
