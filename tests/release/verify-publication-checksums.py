#!/usr/bin/env python3
"""Read-only frozen publication byte/source/changelog correspondence; no rebuild."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import tarfile


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def archive_files(path):
    result = {}
    with tarfile.open(path, 'r:gz') as archive:
        for member in archive:
            name = PurePosixPath(member.name)
            require(not name.is_absolute() and '..' not in name.parts and str(name) == member.name,
                    f'Unsafe/noncanonical archive member: {member.name}')
            require(member.isfile() and member.name not in result, f'Non-file/duplicate archive member: {member.name}')
            result[member.name] = (member.mode, archive.extractfile(member).read())
    return result


def verify(release, changelog, version, commit):
    require(re.fullmatch(r'\d+\.\d+\.\d+', version), 'Invalid release version')
    require(re.fullmatch(r'[0-9a-f]{40}', commit), 'Invalid tag commit')
    names = {'kosmozoo-linux-x86_64', 'artifact.json', 'provenance.json', 'source-input.json',
             'build-inputs.json', 'source-materials.json', 'resources.json', 'included-resources.json',
             'THIRD_PARTY_NOTICES.txt', 'NOTICE-SOURCES.json'}
    names |= {f'kosmozoo-{version}-{kind}.tar.gz' for kind in ['source', 'dependency-material', 'build-inputs', 'resources']}
    records = {}
    for line in (release / 'SHA256SUMS').read_text().splitlines():
        match = re.fullmatch(r'([0-9a-f]{64})  ([^/\x00-\x1f]+)', line)
        require(match is not None, 'Malformed SHA256SUMS record')
        digest, name = match.groups()
        require(name not in records and name not in ['.', '..', 'SHA256SUMS'], 'Duplicate/unsafe checksum name')
        path = release / name
        require(path.is_file() and not path.is_symlink() and sha(path) == digest, f'Asset checksum mismatch: {name}')
        records[name] = digest
    require(names <= records.keys(), 'Mandatory frozen publication assets absent from checksums')
    require({path.name for path in release.iterdir() if path.is_file() and path.name != 'SHA256SUMS'} == records.keys(),
            'Frozen release contains unrecorded assets')
    binary = release / 'kosmozoo-linux-x86_64'
    with binary.open('rb') as stream:
        header = stream.read(20)
    require(header[:6] == b'\x7fELF\x02\x01' and header[18:20] == b'\x3e\x00', 'Official executable is not GNU x86_64 ELF64')
    artifact = json.loads((release / 'artifact.json').read_text())
    provenance = json.loads((release / 'provenance.json').read_text())
    source = json.loads((release / 'source-input.json').read_text())
    resources = json.loads((release / 'resources.json').read_text())
    for value in [artifact, provenance, resources['source']]:
        require(value['commit'] == commit and value['tree'] == source['tree'] and
                value['sourceInputSha256'] == source['workingInputSha256'] and value['releaseVersion'] == version,
                'Frozen source/tag/version identity mismatch')
    require(source['commit'] == commit and source['status'] == 'clean-committed-input', 'Official source is not the clean tagged source')
    require(artifact['binarySha256'] == records[binary.name] and artifact['binarySize'] == binary.stat().st_size,
            'Official artifact byte identity mismatch')
    rows = source['files']
    require([row['path'] for row in rows] == sorted({row['path'] for row in rows}), 'Source inventory is not unique/sorted')
    fingerprint = hashlib.sha256(''.join(f"{row['path']}\0{row['mode']}\0{row['sha256']}\n" for row in rows).encode()).hexdigest()
    require(fingerprint == source['workingInputSha256'], 'Source inventory fingerprint mismatch')
    preferred = archive_files(release / f'kosmozoo-{version}-source.tar.gz')
    require(set(preferred) == {'source-input.json'} | {'kosmozoo/' + row['path'] for row in rows}, 'Preferred source archive selection mismatch')
    require(json.loads(preferred['source-input.json'][1]) == source, 'Preferred source manifest mismatch')
    for row in rows:
        mode, data = preferred['kosmozoo/' + row['path']]
        require(row['mode'] in ['100644', '100755'] and hashlib.sha256(data).hexdigest() == row['sha256'] and
                bool(mode & 0o111) == (row['mode'] == '100755'), f'Preferred source bytes/mode mismatch: {row["path"]}')
    pins = json.loads(preferred['kosmozoo/packaging/linux/inputs.json'][1])
    materials = json.loads(preferred['kosmozoo/packaging/linux/source-materials.json'][1])
    require(json.loads((release / 'build-inputs.json').read_text())['pins'] == pins, 'Build input authority mismatch')
    require(json.loads((release / 'source-materials.json').read_text()) == materials, 'Material authority mismatch')
    for kind, manifest_name, manifest, entries in [
        ('build-inputs', 'inputs.json', pins, [{'path': pin['relativePath'], 'sha256': pin['sha256']} for pin in pins['inputs'].values()]),
        ('dependency-material', 'source-materials.json', materials, materials['materials']),
        ('resources', 'resources.json', resources, resources['files']),
    ]:
        content = archive_files(release / f'kosmozoo-{version}-{kind}.tar.gz')
        require(set(content) == {manifest_name} | {entry['path'] for entry in entries}, f'{kind} archive selection mismatch')
        require(json.loads(content[manifest_name][1]) == manifest, f'{kind} manifest mismatch')
        for entry in entries:
            require(hashlib.sha256(content[entry['path']][1]).hexdigest() == entry['sha256'], f'{kind} payload mismatch: {entry["path"]}')
    for name in ['THIRD_PARTY_NOTICES.txt', 'NOTICE-SOURCES.json']:
        require(records[name] == materials['noticeFiles']['packaging/linux/resources/' + name], 'Reviewed notice authority mismatch')
    section = re.search(r'^## ' + re.escape(version) + r'(?:[^\n]*)\n(.*?)(?=^## |\Z)', changelog.read_text(), re.M | re.S)
    require(section is not None, 'Versioned changelog section absent')
    for value in [binary.name, records[binary.name], 'v' + version, commit]:
        require(value in section.group(1), f'Exact official ELF/source record absent from changelog: {value}')
    return {'version': version, 'tagCommit': commit, 'binarySha256': records[binary.name], 'assets': records}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release-dir', type=Path, required=True)
    parser.add_argument('--changelog', type=Path, required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--tag-commit', required=True)
    args = parser.parse_args()
    result = verify(args.release_dir.resolve(strict=True), args.changelog.resolve(strict=True), args.version, args.tag_commit)
    print(json.dumps(result, indent=2))
    print('PUBLICATION CHECKSUM RECORD PASS')


if __name__ == '__main__':
    main()
