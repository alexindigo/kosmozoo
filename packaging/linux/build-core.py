#!/usr/bin/env python3
"""Shared authenticated source/payload/resource core with explicit public inputs."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import re

from importlib.util import module_from_spec, spec_from_file_location

HERE = Path(__file__).resolve().parent
SOURCE = HERE.parent.parent
spec = spec_from_file_location('source_input', HERE / 'source-input.py')
inventory = module_from_spec(spec)
spec.loader.exec_module(inventory)

PAYLOAD = [
    'VERSION', 'client-solid-dist', 'client', 'src/extractor.mjs', 'src/entry-path.mjs',
    'src/version.mjs', 'LICENSE', 'LICENSE.GPL', 'docs/executable.md',
    'packaging/linux/PUBLICATION.md', 'packaging/linux/LICENSING.md',
    'src/source-origin.mjs', 'src/features/variations/shared.mjs',
    'plugins/hello/plugin.mjs', 'plugins/difference/plugin.mjs',
    'plugins/detector/plugin.mjs', 'plugins/critic/plugin.mjs',
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
        process = subprocess.run(list(map(str, argv)), cwd=cwd, env=env, stdout=output, stderr=subprocess.STDOUT, timeout=900)
    print(log.read_text(errors='replace'), end='', flush=True)
    if process.returncode:
        raise RuntimeError(f'Command failed ({process.returncode}); preserved log {log}')


def authenticate(source_manifest, input_root, materials_root):
    manifest = json.loads(source_manifest.read_text())
    rows = manifest['files']
    if [r['path'] for r in rows] != sorted(set(r['path'] for r in rows)):
        raise ValueError('Manifest paths are not unique and sorted')
    actual = [inventory.source_row(SOURCE, row['path']) for row in rows]
    if actual != rows or inventory.fingerprint(rows) != manifest['workingInputSha256']:
        raise ValueError('Current source does not match the complete supplied source selection')
    selected = {row['path'] for row in rows}
    if not {'packaging/linux/inputs.json', 'packaging/linux/source-materials.json'} <= selected:
        raise ValueError('Source selection omits build input/source-material authority')
    if manifest['commit'] is not None:
        if not re.fullmatch(r'[0-9a-f]{40}', manifest['commit']) or not re.fullmatch(r'[0-9a-f]{40}', manifest['tree'] or ''):
            raise ValueError('Invalid committed source identity')
    pins = json.loads((SOURCE / 'packaging/linux/inputs.json').read_text())
    source_materials = json.loads((SOURCE / 'packaging/linux/source-materials.json').read_text())
    for name, expected in source_materials['noticeFiles'].items():
        if name not in selected:
            raise ValueError('Source selection omits reviewed notice source')
        if sha(SOURCE / name) != expected:
            raise ValueError(f'Notice source differs from reviewed input: {name}')
    for material in source_materials['materials']:
        path = materials_root / material['path']
        if path.is_symlink() or not path.is_file() or sha(path) != material['sha256']:
            raise ValueError(f'Corresponding-source material differs: {path}')
    inputs = {}
    for name, pin in pins['inputs'].items():
        path = input_root / pin['relativePath']
        if path.is_symlink() or not path.is_file() or sha(path) != pin['sha256']:
            raise ValueError(f'Unauthenticated input {name}: {path}')
        inputs[name] = {**pin, 'path': str(path)}
    return manifest, pins, source_materials, inputs


def build(source_manifest, input_root, materials_root, cache, output, evidence, version=None, validate_only=False):
    if version is not None and not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', version):
        raise ValueError('Publication version must be a numeric release version')
    output.parent.resolve(strict=True)
    if output.exists() or output.is_symlink():
        raise ValueError('Output must be new; previous artifacts are preserved')
    for path in [evidence, cache, output.parent]:
        path.resolve(strict=True)
        if subprocess.check_output(['findmnt', '-rn', '-o', 'FSTYPE', '-T', str(path)], timeout=15).strip() in [b'tmpfs', b'ramfs']:
            raise ValueError('Build workspace/cache/output must be disk-backed')
        if path.resolve().is_relative_to(SOURCE.resolve()):
            raise ValueError('Build workspace/cache/output must be outside application source')
    manifest, pins, source_materials, inputs = authenticate(source_manifest, input_root, materials_root)
    if validate_only:
        print('AUTHENTICATED PUBLICATION INPUTS PASS; no compilation or artifact created')
        return
    output.mkdir(mode=0o700)
    rows = manifest['files']
    json_file(output / 'build-inputs.json', {'version': 1, 'pins': pins})
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
    if version is not None and version != (stage / 'VERSION').read_text().strip():
        raise ValueError('Publication --version must equal staged VERSION')
    native = stage / 'native/linux-x86_64/libsqlite3.so'
    native.parent.mkdir(parents=True)
    shutil.copyfile(inputs['sqlite']['path'], native)
    resources = stage / 'packaging/linux/resources'
    provenance = {'version': 1, 'kind': 'compiled-release' if manifest['commit'] else 'compiled-development',
                  'commit': manifest['commit'], 'tree': manifest['tree'],
                  'sourceInputSha256': manifest['workingInputSha256'], 'compiler': pins['compilerVersion'],
                   'target': pins['target'], 'engine': pins['engine'], 'sqliteSha256': inputs['sqlite']['sha256']}
    if version is not None:
        provenance['releaseVersion'] = version
    (resources / 'provenance.json').write_text(json.dumps(provenance, indent=2) + '\n')
    json_file(output / 'provenance.json', provenance)
    shutil.copy2(SOURCE / 'packaging/linux/resources/THIRD_PARTY_NOTICES.txt', output / 'THIRD_PARTY_NOTICES.txt')
    shutil.copy2(SOURCE / 'packaging/linux/resources/NOTICE-SOURCES.json', output / 'NOTICE-SOURCES.json')
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
    # Do not package an ambient source edit made during compilation under the
    # earlier source fingerprint. A mismatch retains the incomplete attempt.
    authenticate(source_manifest, input_root, materials_root)
    source_name = f'kosmozoo-{version}-source.tar.gz' if version else 'corresponding-working-source.tar.gz'
    material_name = f'kosmozoo-{version}-dependency-material.tar.gz' if version else 'corresponding-dependency-material.tar.gz'
    with tarfile.open(output / source_name, 'w:gz') as archive:
        for row in rows:
            archive.add(SOURCE / row['path'], arcname='kosmozoo/' + row['path'], recursive=False)
        archive.add(source_manifest, arcname='source-input.json')
    with tarfile.open(output / material_name, 'w:gz') as archive:
        for material in source_materials['materials']:
            archive.add(materials_root / material['path'], arcname=material['path'], recursive=False)
        archive.add(SOURCE / 'packaging/linux/source-materials.json', arcname='source-materials.json', recursive=False)
    if version:
        with tarfile.open(output / f'kosmozoo-{version}-build-inputs.tar.gz', 'w:gz') as archive:
            for pin in pins['inputs'].values():
                archive.add(input_root / pin['relativePath'], arcname=pin['relativePath'], recursive=False)
            archive.add(SOURCE / 'packaging/linux/inputs.json', arcname='inputs.json', recursive=False)
        global_resources = stage / 'global-resources'
        run([*offline, deno, 'run', '--frozen', '--cached-only', '--allow-read', '--allow-write', 'packaging/linux/render-resources.mjs', global_resources], stage, env, output / 'resources.log')
        resource_rows = [{'path': str(path.relative_to(global_resources)), 'sha256': sha(path), 'size': path.stat().st_size}
                         for path in sorted(global_resources.rglob('*')) if path.is_file()]
        resource_manifest = {'version': 1, 'releaseVersion': version, 'source': provenance, 'files': resource_rows}
        json_file(output / 'resources.json', resource_manifest)
        json_file(global_resources / 'resources.json', resource_manifest)
        with tarfile.open(output / f'kosmozoo-{version}-resources.tar.gz', 'w:gz') as archive:
            for path in sorted(global_resources.rglob('*')):
                if path.is_file(): archive.add(path, arcname=str(path.relative_to(global_resources)), recursive=False)
    sums = ''.join(f'{sha(path)}  {path.name}\n' for path in sorted(output.iterdir()) if path.is_file())
    (output / 'SHA256SUMS').write_text(sums)
    print(f'PRIVATE CANDIDATE COMPILE PASS: {binary}; distribution acceptance remains required')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['source-manifest', 'inputs', 'materials', 'cache', 'output']:
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--validate-inputs', action='store_true', help='Authenticate all source/native/material inputs without compiling or creating output')
    args = parser.parse_args()
    build(args.source_manifest.resolve(strict=True), args.inputs.resolve(strict=True), args.materials.resolve(strict=True),
          args.cache.resolve(strict=True), args.output.absolute(), args.output.parent.resolve(strict=True), args.version, args.validate_inputs)


if __name__ == '__main__':
    main()
