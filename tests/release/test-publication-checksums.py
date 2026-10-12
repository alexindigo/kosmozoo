#!/usr/bin/env python3
"""Byte/record correspondence fixtures, never an official release/source proof."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import tarfile
import tempfile
import unittest

import publication_vm as vm

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('publication_checksums', HERE / 'verify-publication-checksums.py')
checker = importlib.util.module_from_spec(spec); spec.loader.exec_module(checker)
ROOT = Path('/home/tester/kosmozoo-aur-release')


class ChecksumCorrespondence(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='checksum-record-fixture-', dir=ROOT / 'tmp'))
        self.release = self.root / 'fixture'
        self.release.mkdir()
        self.version, self.commit = '0.0.0', 'a' * 40  # Explicit metadata fixture, not a real tag.
        self.changelog = self.root / 'changelog.md'
        self.digest = lambda data: hashlib.sha256(data).hexdigest()
        def write(name, value):
            (self.release / name).write_text(json.dumps(value, indent=2) + '\n')
        self.write = write
        notice, trace, tool, material = b'fixture permission text\n', b'{"fixture":true}\n', b'authenticated tool fixture', b'preferred material fixture'
        pins = {'inputs': {'compiler': {'relativePath': 'deno/deno', 'sha256': self.digest(tool)}}}
        materials = {'noticeFiles': {'packaging/linux/resources/THIRD_PARTY_NOTICES.txt': self.digest(notice),
                                     'packaging/linux/resources/NOTICE-SOURCES.json': self.digest(trace)},
                     'materials': [{'path': 'source.tar', 'sha256': self.digest(material)}]}
        source_files = {'packaging/linux/inputs.json': json.dumps(pins).encode(),
                        'packaging/linux/source-materials.json': json.dumps(materials).encode(),
                        'packaging/linux/resources/THIRD_PARTY_NOTICES.txt': notice,
                        'packaging/linux/resources/NOTICE-SOURCES.json': trace}
        rows = [{'path': name, 'mode': '100644', 'sha256': self.digest(data)} for name, data in sorted(source_files.items())]
        fingerprint = self.digest(''.join(f"{r['path']}\0{r['mode']}\0{r['sha256']}\n" for r in rows).encode())
        source = {'commit': self.commit, 'tree': 'b' * 40, 'status': 'clean-committed-input', 'workingInputSha256': fingerprint, 'files': rows}
        provenance = {'commit': self.commit, 'tree': source['tree'], 'sourceInputSha256': fingerprint, 'releaseVersion': self.version}
        binary = ROOT / 'artifacts/retained-f0f1cf3'
        # Existing authenticated bytes copied as a metadata fixture only; no ELF
        # compilation or claim that the invented fixture source produced them.
        shutil.copy2(binary, self.release / 'kosmozoo-linux-x86_64')
        self.binary_sha = vm.sha(binary)
        artifact = {**provenance, 'binarySha256': self.binary_sha, 'binarySize': binary.stat().st_size}
        resource = {'path': 'usr/share/licenses/kosmozoo/NOTICE', 'sha256': self.digest(notice), 'size': len(notice)}
        resources = {'source': provenance, 'releaseVersion': self.version, 'files': [resource]}
        for name, value in [('artifact.json', artifact), ('provenance.json', provenance), ('source-input.json', source),
                            ('build-inputs.json', {'pins': pins}), ('source-materials.json', materials),
                            ('resources.json', resources), ('included-resources.json', [])]:
            write(name, value)
        (self.release / 'THIRD_PARTY_NOTICES.txt').write_bytes(notice)
        (self.release / 'NOTICE-SOURCES.json').write_bytes(trace)
        def archive(kind, values):
            with tarfile.open(self.release / f'kosmozoo-{self.version}-{kind}.tar.gz', 'w:gz') as tar:
                for name, data in values.items():
                    entry = tarfile.TarInfo(name); entry.size = len(data); entry.mode = 0o644
                    tar.addfile(entry, io.BytesIO(data))
        archive('source', {'source-input.json': json.dumps(source).encode(), **{'kosmozoo/' + name: data for name, data in source_files.items()}})
        archive('build-inputs', {'inputs.json': json.dumps(pins).encode(), 'deno/deno': tool})
        archive('dependency-material', {'source-materials.json': json.dumps(materials).encode(), 'source.tar': material})
        archive('resources', {'resources.json': json.dumps(resources).encode(), resource['path']: notice})
        self.seal()
        self.changelog.write_text(f'## {self.version} — metadata fixture\n\nkosmozoo-linux-x86_64 {self.binary_sha} v{self.version} {self.commit}\n')

    def seal(self):
        (self.release / 'SHA256SUMS').write_text(''.join(f'{vm.sha(path)}  {path.name}\n' for path in sorted(self.release.iterdir()) if path.name != 'SHA256SUMS'))

    def verify(self):
        return checker.verify(self.release, self.changelog, self.version, self.commit)

    def test_exact_consistent_byte_source_asset_and_changelog_records(self):
        self.assertEqual(self.verify()['binarySha256'], self.binary_sha)

    def test_frozen_asset_byte_drift_rejected(self):
        (self.release / 'THIRD_PARTY_NOTICES.txt').write_bytes(b'changed bytes')
        with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
            self.verify()

    def test_wrong_tag_identity_rejected_even_with_resealed_asset_hash(self):
        value = json.loads((self.release / 'artifact.json').read_text()); value['commit'] = 'c' * 40
        self.write('artifact.json', value); self.seal()
        with self.assertRaisesRegex(ValueError, 'identity mismatch'):
            self.verify()

    def test_wrong_official_elf_record_rejected_even_with_resealed_metadata(self):
        value = json.loads((self.release / 'artifact.json').read_text()); value['binarySha256'] = '0' * 64
        self.write('artifact.json', value); self.seal()
        with self.assertRaisesRegex(ValueError, 'byte identity mismatch'):
            self.verify()

    def test_wrong_changelog_digest_rejected(self):
        self.changelog.write_text(self.changelog.read_text().replace(self.binary_sha, '0' * 64))
        with self.assertRaisesRegex(ValueError, 'absent from changelog'):
            self.verify()


if __name__ == '__main__':
    vm.require_vm('0053e86d-8233-49eb-97e0-4055e5428be7')
    unittest.main()
