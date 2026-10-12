"""Verified ownership for separately launched publication test resources."""
import json
import os
from pathlib import Path
import subprocess
import time

import publication_vm as vm


def process_identity(pid):
    root = Path('/proc') / str(pid)
    stat = (root / 'stat').read_text().rsplit(')', 1)[1].split()
    return {'pid': pid, 'startTime': stat[19], 'state': stat[0], 'uid': root.stat().st_uid,
            'exe': str((root / 'exe').resolve()), 'cwd': str((root / 'cwd').resolve()),
            'argv': (root / 'cmdline').read_bytes().decode().split('\0'),
            'cgroup': (root / 'cgroup').read_text(),
            'env': dict(value.split('=', 1) for value in (root / 'environ').read_bytes().decode().split('\0') if '=' in value)}


def unit_state(name):
    raw = subprocess.check_output(['systemctl', '--user', 'show', name,
        '--property=LoadState,ActiveState,MainPID,ExecMainStatus,Result,FragmentPath,InvocationID,ControlGroup'], text=True, timeout=15)
    return dict(line.split('=', 1) for line in raw.splitlines())


def verified_engine(config, name):
    owner = config['publicationOwner']
    allowed = config.get('units', [config['unit'], config['unit'] + '-handoff', config['unit'] + '-changed-port', config['unit'] + '-browser-fallbacks'])
    if name not in allowed:
        raise RuntimeError('Unregistered publication unit; preserve it')
    state = unit_state(name)
    pid = int(state.get('MainPID', '0'))
    if not pid:
        return state, None
    identity = process_identity(pid)
    env = identity['env']
    if state['ControlGroup'] != identity['cgroup'].strip().rsplit(':', 1)[-1]:
        raise RuntimeError('Publication unit/process cgroup differs; preserve it')
    if 'fragmentRoot' in owner and not Path(state['FragmentPath']).resolve().is_relative_to(owner['fragmentRoot']):
        raise RuntimeError('Publication unit fragment scope differs; preserve it')
    matches = identity['exe'] == owner.get('binary') and vm.sha(identity['exe']) in owner.get('binaryHashes', [owner.get('binarySha256')])
    if 'fragmentPath' in owner and state['FragmentPath'] != owner['fragmentPath']:
        raise RuntimeError('Publication unit fragment identity differs; preserve it')
    if 'binaryRoot' in owner:
        matches = Path(identity['exe']).is_relative_to(owner['binaryRoot']) and vm.sha(identity['exe']) in owner['binaryHashes']
    if identity['uid'] != os.getuid() or not matches:
        raise RuntimeError('Publication engine executable/account differs; preserve it')
    if env.get('KZ_PUBLICATION_OWNER') != owner['token'] or env.get('HOME') != config['env']['HOME']:
        raise RuntimeError('Publication engine owner/private HOME differs; preserve it')
    state_key = 'KOZMOZOO_STATE' if 'KOZMOZOO_STATE' in config['env'] else 'XDG_STATE_HOME'
    if env.get(state_key) != config['env'][state_key]:
        raise RuntimeError('Publication engine state scope differs; preserve it')
    return state, identity


def retire_registered(run, gui):
    """Retire every registered separate user-unit/UI path, including early failures."""
    errors = []
    for receipt in [Path(run) / 'ownership.json', Path(run) / 'chromium/ownership.json', Path(run) / 'installer/ownership.json']:
        if not receipt.exists():
            continue
        config = json.loads(receipt.read_text())
        try:
            close_owned_windows(config, gui)
        except Exception as error:
            errors.append(repr(error))
        try:
            retire_engine(config, config['unit'])
        except Exception as error:
            errors.append(repr(error))
    try:
        retire_firefox(run, gui)
    except Exception as error:
        errors.append(repr(error))
    if errors:
        raise RuntimeError('Owned resource retirement incomplete: ' + '; '.join(errors))


def retire_engine(config, name):
    state, identity = verified_engine(config, name)
    if identity is not None:
        # Recheck start identity immediately before the manager operation.
        _, current = verified_engine(config, name)
        if current is None or current['startTime'] != identity['startTime']:
            raise RuntimeError('Publication PID identity changed; preserve it')
        subprocess.run(['systemctl', '--user', 'stop', name], check=True, timeout=35)
    result = unit_state(name)
    if int(result.get('MainPID', '0')):
        raise RuntimeError('Owned publication engine did not retire')
    return result


def retire_firefox(run, gui):
    session = Path(run) / 'firefox/session.json'
    if not session.exists():
        return
    config = json.loads(session.read_text())
    if 'publicationOwner' not in config:
        raise RuntimeError('Publication ownership receipt missing; preserve resources')
    records = {'units': {}, 'windows': []}
    records['windows'] = close_owned_windows(config, gui)
    for name in [config['unit'], config['unit'] + '-handoff', config['unit'] + '-changed-port', config['unit'] + '-browser-fallbacks']:
        records['units'][name] = retire_engine(config, name)
    # Finally and the independent parent watchdog can both retire the same run.
    path = Path(run) / 'retained-ownership.json'
    if path.exists():
        path = Path(run) / ('retained-ownership-' + str(time.monotonic_ns()) + '.json')
    vm.json_file(path, records)


def verified_window(config, window):
    """Recognize a fresh private browser even when Chromium scrubs environ."""
    identity = process_identity(window['pid'])
    scope = Path(config['env']['HOME']).parent
    if identity['uid'] != os.getuid():
        return None
    env = identity['env']
    token = env.get('KZ_PUBLICATION_OWNER')
    if token is not None and token != config['publicationOwner']['token']:
        return None
    explicit_scope = (token == config['publicationOwner']['token'] and
                      env.get('HOME') == config['env']['HOME'] and
                      env.get('XDG_DATA_HOME') == config['env']['XDG_DATA_HOME'])
    # Only the explicitly created Firefox scope and the sibling fallback scope.
    cwd_scope = any(Path(identity['cwd']).is_relative_to(path) for path in config.get('uiScopes', [scope, scope.parent / 'browser-fallbacks']))
    if not explicit_scope and not cwd_scope:
        return None
    if identity['exe'] == '/usr/lib/chromium/chromium':
        locks = [Path(config['env']['XDG_CONFIG_HOME']) / 'chromium/SingletonLock',
                 Path(config['env']['XDG_DATA_HOME']) / 'kosmozoo/browser/chromium/SingletonLock']
        if not any(lock.is_symlink() and lock.lstat().st_uid == os.getuid() and os.readlink(lock).rsplit('-', 1)[-1] == str(window['pid']) for lock in locks):
            return None
    elif identity['exe'] == '/usr/lib/firefox/firefox':
        argv = ' '.join(identity['argv'])
        if str(scope / 'home/data/kosmozoo/browser/firefox') not in argv and str(scope / 'ordinary-profile') not in argv:
            return None
    else:
        return None
    if identity['startTime'] != process_identity(window['pid'])['startTime']:
        raise RuntimeError('Publication UI PID changed; preserve it')
    return identity


def close_owned_windows(config, gui):
    records = []
    windows = json.loads(subprocess.check_output(['niri', 'msg', '--json', 'windows'], env=gui, text=True, timeout=15))
    for window in windows:
        try:
            identity = verified_window(config, window)
        except FileNotFoundError:
            continue
        if identity is None:
            records.append({'id': window['id'], 'result': 'unrelated-preserved'})
            continue
        before = identity['startTime']
        if process_identity(window['pid'])['startTime'] != before:
            raise RuntimeError('Publication UI PID changed; preserve it')
        subprocess.run(['niri', 'msg', 'action', 'close-window', '--id', str(window['id'])], env=gui, check=True, timeout=15)
        records.append({'id': window['id'], 'pid': window['pid'], 'startTime': before, 'result': 'owned-close-requested'})
    retired = [record for record in records if record['result'] == 'owned-close-requested']
    def closed():
        for record in retired:
            try:
                current = process_identity(record['pid'])
                if current['startTime'] == record['startTime'] and current['state'] != 'Z':
                    return False
            except (FileNotFoundError, ProcessLookupError):
                pass
        return True
    vm.wait_for(closed, 'Owned native browser did not exit after normal window closure')
    return records
