#!/usr/bin/env python3
"""Git/source metadata only; usable on the editing host. No project execution."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import subprocess


def digest(data):
    return hashlib.sha256(data).hexdigest()


def fingerprint(rows):
    return digest(''.join(f"{row['path']}\0{row['mode']}\0{row['sha256']}\n" for row in rows).encode())


def source_row(root, name):
    relative = PurePosixPath(name)
    if relative.is_absolute() or '..' in relative.parts or not name:
        raise ValueError(f'Unsafe source path: {name}')
    path = root / name
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode):
        mode, data = '120000', os.readlink(path).encode()
    elif stat.S_ISREG(info.st_mode):
        mode, data = ('100755' if info.st_mode & 0o111 else '100644'), path.read_bytes()
    else:
        raise ValueError(f'Non-file source input: {name}')
    return {'path': name, 'mode': mode, 'sha256': digest(data)}


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path.cwd())
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--development', action='store_true')
    args = parser.parse_args()
    root = args.root.resolve()
    status = git(root, 'status', '--porcelain=v1', '-z')
    if status and not args.development:
        raise SystemExit('Final source requires a clean committed tree')
    names = git(root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard').decode().split('\0')
    names = sorted(set(name for name in names if name and not name.endswith('.bak')))
    rows = [source_row(root, name) for name in names]
    value = {'version': 1, 'status': 'development-working-input' if status else 'clean-committed-input',
             'baseCommit': git(root, 'rev-parse', 'HEAD').decode().strip(),
             'commit': None if status else git(root, 'rev-parse', 'HEAD').decode().strip(),
             'tree': None if status else git(root, 'rev-parse', 'HEAD^{tree}').decode().strip(),
             'workingInputSha256': fingerprint(rows), 'files': rows}
    with args.output.open('x') as file:
        json.dump(value, file, indent=2)
        file.write('\n')
    print(f"{value['status']}: {len(rows)} files; {value['workingInputSha256']}")


if __name__ == '__main__':
    main()
