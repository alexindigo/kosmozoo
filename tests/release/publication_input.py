"""One private, bounded standard-evdev keyboard owner for native acceptance.

ydotool1.0.4 CLI and Linux input-event-codes.h are the input authority. This is
a guest test tool, never an application or pacman runtime dependency.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import stat
import subprocess
import time

import publication_owner as owner
import publication_vm as vm

HERE = Path(__file__).resolve()
DAEMON = Path('/usr/bin/ydotoold')
CLIENT = Path('/usr/bin/ydotool')
KEYS = {'Return': 28, 'Tab': 15, 'F6': 64, 'Shift': 42}


def daemon_state(unit):
    return dict(line.split('=', 1) for line in subprocess.check_output(
        ['sudo', '-n', 'systemctl', 'show', unit,
         '--property=LoadState,ActiveState,MainPID,InvocationID,Result,ExecMainStatus'],
        text=True, timeout=15).splitlines())


def root_identity(pid, uuid):
    return json.loads(subprocess.check_output(['sudo', '-n', '/usr/bin/python3', '-B',
        str(HERE), '--inspect-pid', str(pid), '--expected-vm-uuid', uuid], text=True, timeout=15))


def devices():
    return {str(path.resolve()) for path in Path('/sys/class/input').glob('input*')
            if (path / 'name').read_text().strip() == 'ydotoold virtual device'}


class NativeKeyboard:
    def __init__(self, run, workspace, uuid):
        vm.require_vm(uuid)
        if uuid != '0053e86d-8233-49eb-97e0-4055e5428be7':
            raise RuntimeError('The approved native keyboard belongs only to the assigned native guest')
        self.run, self.workspace, self.uuid = vm.directory(run), vm.directory(workspace), uuid
        self.receipt = self.run / 'native-input.json'
        self.config = None

    def start(self, lifetime=900):
        pins = json.loads(HERE.with_name('native-input.json').read_text())
        if subprocess.check_output(['pacman', '-Q', 'ydotool'], text=True, timeout=15).strip() != pins['package']:
            raise RuntimeError('Native test keyboard package differs from characterized1.0.4-2')
        if any(vm.sha(path) != digest for path, digest in pins['executables'].items()):
            raise RuntimeError('Native keyboard executable differs from authenticated test input')
        short = self.workspace / 'tmp' / ('k-' + hashlib.sha256(str(self.run).encode()).hexdigest()[:16])
        short.mkdir(mode=0o700)
        socket = short / 'input.sock'
        if len(os.fsencode(str(socket))) >= 108:
            raise RuntimeError('Native input socket exceeds platform budget')
        unit = 'kz-publication-input-' + short.name + '.service'
        if daemon_state(unit)['LoadState'] != 'not-found':
            raise RuntimeError('Native input unit exists; preserve it')
        self.config = {'unit': unit, 'socket': str(socket), 'directory': str(short), 'workspace': str(self.workspace),
            'directoryInode': short.stat().st_ino, 'token': secrets.token_hex(24),
            'daemonSha256': vm.sha(DAEMON), 'clientSha256': vm.sha(CLIENT),
            'expectedVmUuid': self.uuid, 'lifetime': lifetime}
        vm.json_file(self.receipt, self.config)
        before = devices()
        subprocess.run(['sudo', '-n', 'systemd-run', '--unit=' + unit,
            '--property=RuntimeMaxSec=' + str(lifetime), '--property=TimeoutStopSec=10',
            '--property=StandardOutput=file:' + str(self.run / 'input-daemon.log'),
            '--property=StandardError=inherit', '--setenv=KZ_PUBLICATION_OWNER=' + self.config['token'],
            '/usr/bin/stdbuf', '-oL', str(DAEMON), '--mouse-off', '--socket-path=' + str(socket),
            '--socket-perm=0600', '--socket-own=' + str(os.getuid()) + ':' + str(os.getgid())],
            check=True, timeout=30)
        vm.wait_for(lambda: socket.exists() and devices() - before, 'Owned input socket/device absent')
        subprocess.run(['sudo', '-n', 'udevadm', 'settle', '--timeout=15'], check=True, timeout=20)
        vm.wait_for(lambda: 'READY' in (self.run / 'input-daemon.log').read_text(), 'Owned input daemon not ready')
        added = devices() - before
        if len(added) != 1:
            raise RuntimeError('Input device creation is ambiguous; preserve state')
        state = daemon_state(unit)
        identity = root_identity(int(state['MainPID']), self.uuid)
        self.config.update({'pid': identity['pid'], 'startTime': identity['startTime'],
            'invocationId': state['InvocationID'], 'socketInode': socket.stat().st_ino,
            'device': added.pop()})
        # Completion of a pending ownership receipt; retain the original request.
        vm.json_file(self.run / 'native-input-ready.json', self.config)
        self.verify()
        return self

    def verify(self):
        config = self.config
        state = daemon_state(config['unit'])
        pid = int(state['MainPID'])
        if not pid:
            raise RuntimeError('Owned native input daemon is not active')
        identity = root_identity(pid, self.uuid)
        if 'invocationId' in config and state['InvocationID'] != config['invocationId']:
            raise RuntimeError('Native input unit invocation differs; preserve it')
        if (identity['uid'] != 0 or identity['exe'] != str(DAEMON) or
                identity['env'].get('KZ_PUBLICATION_OWNER') != config['token'] or
                vm.sha(DAEMON) != config['daemonSha256'] or vm.sha(CLIENT) != config['clientSha256'] or
                ('startTime' in config and (pid != config['pid'] or identity['startTime'] != config['startTime']))):
            raise RuntimeError('Native input process identity differs; preserve it')
        if config['socket'] not in identity['argv'] and '--socket-path=' + config['socket'] not in identity['argv']:
            raise RuntimeError('Native input process socket scope differs; preserve it')
        directory = Path(config['directory'])
        socket = Path(config['socket']); info = socket.lstat()
        if (directory.is_symlink() or directory.stat().st_ino != config['directoryInode'] or
                directory.stat().st_uid != os.getuid() or directory.stat().st_mode & 0o077 or
                not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or
                ('socketInode' in config and info.st_ino != config['socketInode'])):
            raise RuntimeError('Native input socket/directory identity differs; preserve it')
        if 'device' in config and config['device'] not in devices():
            raise RuntimeError('Owned native input device disappeared')
        return identity

    def focus(self, config, window, gui):
        identity = owner.verified_window(config, window)
        if identity is None:
            raise RuntimeError('Native input target is not an owned publication window')
        self.verify()
        subprocess.run(['niri', 'msg', 'action', 'focus-window', '--id', str(window['id'])],
                       env=gui, check=True, timeout=15)
        current = json.loads(subprocess.check_output(['niri', 'msg', '--json', 'focused-window'],
                                                    env=gui, text=True, timeout=15))
        if current is None or current['id'] != window['id'] or current['pid'] != window['pid']:
            raise RuntimeError('Native input focus did not reach its owned target')
        if owner.process_identity(window['pid'])['startTime'] != identity['startTime']:
            raise RuntimeError('Native input target PID changed')
        self.target = (config, window, gui)

    def send(self, arguments):
        self.focus(*self.target)
        subprocess.run([str(CLIENT), *arguments], env={**os.environ, 'YDOTOOL_SOCKET': self.config['socket']},
                       check=True, timeout=15)

    def key(self, name):
        code = KEYS[name]
        self.send(['key', str(code) + ':1', str(code) + ':0'])

    def text(self, value):
        if not value.isascii() or value.startswith('-'):
            raise RuntimeError('Native keyboard text is outside the characterized US-layout test input')
        self.send(['type', value])

    def retire(self):
        if self.config is None:
            return
        state = daemon_state(self.config['unit'])
        if int(state['MainPID']):
            self.verify()
            subprocess.run(['sudo', '-n', 'systemctl', 'stop', self.config['unit']], check=True, timeout=20)
        if int(daemon_state(self.config['unit'])['MainPID']):
            raise RuntimeError('Owned input daemon did not retire')
        if 'device' in self.config:
            vm.wait_for(lambda: self.config['device'] not in devices(), 'Owned evdev device did not retire')
        # Socket, receipts, logs and private directory intentionally retained.


def retire_recorded_input(run, uuid):
    run = Path(run)
    ready, pending = run / 'native-input-ready.json', run / 'native-input.json'
    if not pending.exists():
        return
    config = json.loads((ready if ready.exists() else pending).read_text())
    keyboard = NativeKeyboard(run, config['workspace'], uuid)
    keyboard.config = config
    keyboard.retire()


def start_watchdog(run, uuid, lifetime=3500):
    vm.require_vm(uuid)
    run = vm.directory(run)
    unit = 'kz-publication-watch-' + hashlib.sha256(str(run).encode()).hexdigest()[:20]
    if owner.unit_state(unit)['LoadState'] != 'not-found':
        raise RuntimeError('Existing publication watchdog must be preserved')
    parent = owner.process_identity(os.getpid())
    subprocess.run(['systemd-run', '--user', '--unit=' + unit,
        '--property=RuntimeMaxSec=' + str(lifetime + 200), '--property=TimeoutStopSec=15',
        '--property=StandardOutput=file:' + str(run / 'watchdog.log'), '--property=StandardError=inherit',
        '/usr/bin/python3', '-B', str(HERE), '--expected-vm-uuid', uuid, '--watch', str(run),
        '--parent', str(os.getpid()), '--start-time', parent['startTime'], '--lifetime', str(lifetime)],
        check=True, timeout=30)
    vm.json_file(run / 'watchdog-identity.json', {'unit': unit, 'parentPid': parent['pid'],
        'parentStartTime': parent['startTime'], 'deadlineSeconds': lifetime})
    return unit


def finish_resources(run, gui, uuid):
    errors = []
    for retire in [lambda: owner.retire_registered(run, gui), lambda: retire_recorded_input(run, uuid)]:
        try:
            retire()
        except Exception as error:
            errors.append(repr(error))
    vm.json_file(Path(run) / 'resource-retirement.json', {'errors': errors, 'retainedEvidence': str(run)})
    if errors:
        raise RuntimeError('Native resource retirement incomplete: ' + '; '.join(errors))
    (Path(run) / 'ownership-finished').touch(exist_ok=False)


def watch(run, parent, start_time, uuid, lifetime):
    vm.require_vm(uuid)
    run = Path(run)
    gui = dict(line.split('=', 1) for line in subprocess.check_output(
        ['systemctl', '--user', 'show-environment'], text=True, timeout=15).splitlines())
    deadline = time.monotonic() + lifetime
    while time.monotonic() < deadline:
        try:
            if owner.process_identity(parent)['startTime'] != start_time:
                break
        except (FileNotFoundError, ProcessLookupError):
            break
        if (run / 'ownership-finished').exists():
            return
        time.sleep(.2)
    errors = []
    for retire in [lambda: owner.retire_registered(run, {**os.environ, **gui}),
                   lambda: retire_recorded_input(run, uuid)]:
        try:
            retire()
        except Exception as error:
            errors.append(repr(error))
    vm.json_file(run / 'watchdog-outcome.json', {'parentPid': parent, 'errors': errors,
        'reason': 'parent-ended-or-owned-deadline', 'retainedEvidence': str(run)})
    if errors:
        raise RuntimeError('Owned watchdog retirement failed: ' + '; '.join(errors))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--expected-vm-uuid', required=True)
    parser.add_argument('--inspect-pid', type=int)
    parser.add_argument('--watch', type=Path)
    parser.add_argument('--parent', type=int)
    parser.add_argument('--start-time')
    parser.add_argument('--lifetime', type=int, default=900)
    args = parser.parse_args()
    if args.inspect_pid is not None:
        if os.getuid() != 0 or args.expected_vm_uuid != '0053e86d-8233-49eb-97e0-4055e5428be7':
            raise RuntimeError('Privileged inspection is restricted to the assigned guest')
        subprocess.run(['systemd-detect-virt', '--vm'], check=True, stdout=subprocess.DEVNULL, timeout=15)
        if Path('/sys/class/dmi/id/product_uuid').read_text().strip().lower() != args.expected_vm_uuid:
            raise RuntimeError('Wrong privileged native input guest')
        value = owner.process_identity(args.inspect_pid)
        value['env'] = {key: value['env'][key] for key in ['KZ_PUBLICATION_OWNER'] if key in value['env']}
        print(json.dumps(value))
    else:
        watch(args.watch, args.parent, args.start_time, args.expected_vm_uuid, args.lifetime)
