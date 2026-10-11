#!/usr/bin/env python3
"""Authenticated private staging and ordinary offline Deno compile. VM only."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile

from importlib.util import module_from_spec, spec_from_file_location

HERE = Path(__file__).resolve().parent
SOURCE = HERE.parent.parent
spec = spec_from_file_location('source_input', HERE / 'source-input.py')
inventory = module_from_spec(spec)
spec.loader.exec_module(inventory)

PAYLOAD = [
    'client-solid-dist', 'client', 'src/extractor.mjs', 'src/entry-path.mjs',
    'src/source-origin.mjs', 'src/features/variations/shared.mjs',
    'plugins/hello/plugin.mjs', 'plugins/difference/plugin.mjs',
    'plugins/difference/client.js', 'plugins/detector/plugin.mjs',
    'plugins/detector/client.js', 'plugins/critic/plugin.mjs',
    'native/linux-x86_64/libsqlite3.so', 'packaging/linux/resources',
]


def sha(path):
    with path.open('rb') as file:
        return hashlib.file_digest(file, 'sha256').hexdigest()


def json_file(path, value):
    with path.open('x') as file:
        json.dump(value, file, indent=2)
        file.write('\n')


def run(argv, cwd, env, log):
    print('RUN:', ' '.join(map(str, argv)), flush=True)
    with log.open('xb') as output:
        process = subprocess.Popen(list(map(str, argv)), cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        for chunk in iter(lambda: process.stdout.read(8192), b''):
            output.write(chunk)
            sys.stdout.buffer.write(chunk)
            sys.stdout.buffer.flush()
        if process.wait():
            raise RuntimeError(f'Command failed ({process.returncode}); preserved log {log}')


def main():
    subprocess.run(['systemd-detect-virt', '--vm'], check=True, stdout=subprocess.DEVNULL)
    uuid = subprocess.check_output(['sudo', '-n', '/usr/bin/cat', '/sys/class/dmi/id/product_uuid']).decode().strip().lower()
    if uuid != '838fd0e0-e75a-4b21-9ada-8dad6562b151':
        raise SystemExit('Wrong execution VM')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-manifest', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    evidence = Path(os.environ['EVIDENCE']).resolve(strict=True)
    if subprocess.check_output(['findmnt', '-rn', '-o', 'FSTYPE', '-T', str(evidence)]).strip() == b'tmpfs':
        raise SystemExit('Evidence must be disk-backed')
    args.output.parent.resolve(strict=True)
    args.output.mkdir(mode=0o700)  # Never overwrite a previous artifact attempt.
    output = args.output.resolve()
    manifest = json.loads(args.source_manifest.read_text())
    rows = manifest['files']
    if [r['path'] for r in rows] != sorted(set(r['path'] for r in rows)):
        raise ValueError('Manifest paths are not unique and sorted')
    actual = [inventory.source_row(SOURCE, row['path']) for row in rows]
    if actual != rows or inventory.fingerprint(rows) != manifest['workingInputSha256']:
        raise ValueError('Current source does not match the complete supplied source selection')
    pins = json.loads((SOURCE / 'packaging/linux/inputs.json').read_text())
    source_materials = json.loads((SOURCE / 'packaging/linux/source-materials.json').read_text())
    for name, expected in source_materials['noticeFiles'].items():
        if sha(SOURCE / name) != expected:
            raise ValueError(f'Notice source differs from reviewed input: {name}')
    materials_root = Path(os.environ.get('KOSMOZOO_SOURCE_MATERIALS', '/home/tester/kosmozoo-linux-release-evidence/release-continuation/desktop-startup-audit/license-research')).resolve(strict=True)
    for material in source_materials['materials']:
        path = materials_root / material['path']
        if path.is_symlink() or not path.is_file() or sha(path) != material['sha256']:
            raise ValueError(f'Corresponding-source material differs: {path}')
    input_root = Path(os.environ.get('KOSMOZOO_RELEASE_INPUTS', '/home/tester/kosmozoo-linux-release-evidence/release-continuation/release-inputs')).resolve(strict=True)
    inputs = {}
    for name, pin in pins['inputs'].items():
        path = input_root / pin['relativePath']
        if path.is_symlink() or not path.is_file() or sha(path) != pin['sha256']:
            raise ValueError(f'Unauthenticated input {name}: {path}')
        inputs[name] = {**pin, 'path': str(path)}
    json_file(output / 'build-inputs.json', {'version': 1, 'pins': pins, 'inputs': inputs})
    json_file(output / 'source-input.json', manifest)
    json_file(output / 'source-materials.json', source_materials)
    stage = evidence / ('build-' + output.name)
    stage.mkdir(mode=0o700)
    for row in rows:
        path = stage / row['path']
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(SOURCE / row['path'], path, follow_symlinks=False)
    if [inventory.source_row(stage, row['path']) for row in rows] != rows:
        raise ValueError('Staging does not match source manifest')
    native = stage / 'native/linux-x86_64/libsqlite3.so'
    native.parent.mkdir(parents=True)
    shutil.copyfile(inputs['sqlite']['path'], native)
    resources = stage / 'packaging/linux/resources'
    provenance = {'version': 1, 'kind': 'compiled-release' if manifest['commit'] else 'compiled-development',
                  'commit': manifest['commit'], 'tree': manifest['tree'],
                  'sourceInputSha256': manifest['workingInputSha256'], 'compiler': pins['compilerVersion'],
                  'target': pins['target'], 'engine': pins['engine'], 'sqliteSha256': inputs['sqlite']['sha256']}
    (resources / 'provenance.json').write_text(json.dumps(provenance, indent=2) + '\n')
    json_file(output / 'provenance.json', provenance)
    shutil.copy2(SOURCE / 'packaging/linux/resources/THIRD_PARTY_NOTICES.txt', output / 'THIRD_PARTY_NOTICES.txt')
    shutil.copy2(SOURCE / 'packaging/linux/resources/NOTICE-SOURCES.json', output / 'NOTICE-SOURCES.json')
    cache = Path(os.environ.get('KOSMOZOO_BUILD_CACHE', '/home/tester/kosmozoo-linux-release-evidence/release-continuation/file-readiness-correction/consolidation/deno-cache')).resolve(strict=True)
    temporary = stage / 'tmp'
    temporary.mkdir(mode=0o700)
    env = {**os.environ, 'DENO_DIR': str(cache), 'DENORT_BIN': inputs['runtime']['path'],
           'DENO_NO_UPDATE_CHECK': '1', 'TMPDIR': str(temporary), 'DENO_SQLITE_PATH': inputs['sqlite']['path']}
    deno = inputs['compiler']['path']
    run([deno, '--version'], stage, env, output / 'compiler.log')
    # Separate deliberate dependency warming from the network-disabled build.
    run([deno, 'cache', '--frozen', 'build.mjs', 'src/cli.mjs', 'src/main.mjs'], stage, env, output / 'warm.log')
    offline = ['unshare', '--user', '--map-root-user', '--net', '--']
    run([*offline, deno, 'run', '--frozen', '--cached-only', '--allow-all', 'build.mjs'], stage, env, output / 'client-build.log')
    payload_rows = []
    for name in PAYLOAD:
        path = stage / name
        paths = sorted(path.rglob('*')) if path.is_dir() else [path]
        for entry in paths:
            if entry.is_file():
                payload_rows.append({'path': str(entry.relative_to(stage)), 'sha256': sha(entry), 'size': entry.stat().st_size})
    json_file(output / 'included-resources.json', payload_rows)
    binary = output / 'kosmozoo-linux-x86_64'
    include = [item for name in PAYLOAD for item in ['--include', str(stage / name)]]
    run([*offline, deno, 'compile', '--target=' + pins['target'], '--engine=v8',
         '--config=' + str(stage / 'deno.json'), '--lock=' + str(stage / 'deno.lock'),
         '--frozen-lockfile=true', '--cached-only', '--allow-all', '--no-prompt',
         *include, '--output=' + str(binary), str(stage / 'src/cli.mjs')], stage, env, output / 'compile.log')
    json_file(output / 'artifact.json', {'version': 1, **provenance, 'binarySha256': sha(binary), 'binarySize': binary.stat().st_size,
                                      'distributionReadiness': 'pending-license-ABI-and-consumer-gates'})
    with tarfile.open(output / 'corresponding-working-source.tar.gz', 'w:gz') as archive:
        for row in rows:
            archive.add(SOURCE / row['path'], arcname='kosmozoo/' + row['path'], recursive=False)
        archive.add(args.source_manifest, arcname='source-input.json')
    with tarfile.open(output / 'corresponding-dependency-material.tar.gz', 'w:gz') as archive:
        for material in source_materials['materials']:
            archive.add(materials_root / material['path'], arcname=material['path'], recursive=False)
        archive.add(SOURCE / 'packaging/linux/source-materials.json', arcname='source-materials.json', recursive=False)
    sums = ''.join(f'{sha(path)}  {path.name}\n' for path in sorted(output.iterdir()) if path.is_file())
    (output / 'SHA256SUMS').write_text(sums)
    print(f'PRIVATE CANDIDATE COMPILE PASS: {binary}; distribution acceptance remains required')


if __name__ == '__main__':
    main()
