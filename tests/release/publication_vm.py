"""Separate strict publication-test identity; old primary guards stay unchanged."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

GUESTS = {'838fd0e0-e75a-4b21-9ada-8dad6562b151', '0053e86d-8233-49eb-97e0-4055e5428be7'}


def require_vm(expected_uuid):
    if expected_uuid not in GUESTS:
        raise RuntimeError('Expected UUID is not an assigned publication VM')
    subprocess.run(['systemd-detect-virt', '--vm'], check=True, stdout=subprocess.DEVNULL, timeout=15)
    actual = subprocess.check_output(['sudo', '-n', '/usr/bin/cat', '/sys/class/dmi/id/product_uuid'], timeout=15).decode().strip().lower()
    if actual != expected_uuid or os.getuid() != 1000:
        raise RuntimeError('Wrong publication guest/account')


def directory(path, fresh=False):
    path = Path(path).absolute()
    parent = path.parent.resolve(strict=True)
    if path.is_symlink() or str(path).startswith(('/tmp/', '/run/', '/dev/shm/')):
        raise RuntimeError('Publication workspace must be a private disk-backed directory')
    if subprocess.check_output(['findmnt', '-rn', '-o', 'FSTYPE', '-T', str(parent)], timeout=15).strip() in [b'tmpfs', b'ramfs']:
        raise RuntimeError('Publication workspace must be disk-backed')
    if fresh:
        path.mkdir(mode=0o700)
    path = path.resolve(strict=True)
    if not path.is_dir() or path.stat().st_uid != os.getuid() or path.stat().st_mode & 0o022:
        raise RuntimeError('Publication workspace ownership/permissions differ')
    return path


def sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def short_temporary(actual, workspace):
    """Disk-backed temp capability with a Unix-socket-safe lexical path.

    Chromium allocates SingletonSocket below TMPDIR. Keep its own suffix room
    regardless of the retained evidence tree depth, without relocating profiles
    or data to /tmp or discarding an existing state.
    """
    actual = directory(actual)
    parent = directory(Path(workspace) / 'tmp')
    alias = parent / ('c-' + hashlib.sha256(str(actual).encode()).hexdigest()[:12])
    if len(os.fsencode(str(alias))) > 60:
        raise RuntimeError('Assigned native workspace temp path leaves no Unix socket suffix budget')
    if alias.exists() or alias.is_symlink():
        if not alias.is_symlink() or alias.lstat().st_uid != os.getuid() or alias.resolve() != actual:
            raise RuntimeError('Existing temporary capability differs; preserve it')
    else:
        alias.symlink_to(actual, target_is_directory=True)
    return alias


def json_file(path, value):
    with Path(path).open('x') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')


def command(argv, log, env=None, cwd=None, timeout=900):
    print('RUN:', ' '.join(map(str, argv)), flush=True)
    with Path(log).open('xb') as stream:
        result = subprocess.run(list(map(str, argv)), env=env, cwd=cwd, stdout=stream, stderr=subprocess.STDOUT, timeout=timeout)
    print(Path(log).read_text(errors='replace'), end='', flush=True)
    if result.returncode:
        raise RuntimeError(f'Publication command exit {result.returncode}; preserved {log}')
    return result


def wait_for(predicate, message, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(.1)
    raise RuntimeError(message)
