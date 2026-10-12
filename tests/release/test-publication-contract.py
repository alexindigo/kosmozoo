#!/usr/bin/env python3
"""VM-only authentication boundary tests; never compiles a release artifact."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ROOT = Path(__file__).resolve().parents[2]
core = load('publication_build_core', ROOT / 'packaging/linux/build-core.py')
probe = load('publication_runtime_probe', Path(__file__).with_name('verify-runtime.py'))


class AuthenticationContract(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir=os.environ['TMPDIR'])
        self.root = Path(self.temporary.name)
        self.source = self.root / 'source'
        self.source.mkdir()
        self.inputs = self.root / 'inputs'
        self.inputs.mkdir()
        self.materials = self.root / 'materials'
        self.materials.mkdir()
        self.original_source = core.SOURCE
        core.SOURCE = self.source
        packaging = self.source / 'packaging/linux'
        packaging.mkdir(parents=True)
        native = self.inputs / 'native.so'
        native.write_bytes(b'authenticated native fixture, not an ELF')
        material = self.materials / 'source.tar'
        material.write_bytes(b'authenticated corresponding-source fixture')
        notice = packaging / 'notice.txt'
        notice.write_text('source-traceable notice fixture\n')
        (packaging / 'inputs.json').write_text(json.dumps({'inputs': {'sqlite': {'relativePath': 'native.so', 'sha256': core.sha(native)}}}))
        (packaging / 'source-materials.json').write_text(json.dumps({'noticeFiles': {'packaging/linux/notice.txt': core.sha(notice)},
            'materials': [{'path': 'source.tar', 'sha256': core.sha(material)}]}))
        rows = [core.inventory.source_row(self.source, str(path.relative_to(self.source))) for path in sorted(self.source.rglob('*')) if path.is_file()]
        self.value = {'version': 1, 'commit': 'a' * 40, 'tree': 'b' * 40, 'workingInputSha256': core.inventory.fingerprint(rows), 'files': rows}
        self.manifest = self.root / 'source-input.json'
        self.manifest.write_text(json.dumps(self.value))

    def tearDown(self):
        core.SOURCE = self.original_source
        self.temporary.cleanup()

    def authenticate(self):
        return core.authenticate(self.manifest, self.inputs, self.materials)

    def test_exact_input_and_source_materials_accepted(self):
        manifest, _, _, inputs = self.authenticate()
        self.assertEqual(manifest, self.value)
        self.assertEqual(core.sha(Path(inputs['sqlite']['path'])), inputs['sqlite']['sha256'])

    def test_source_bytes_drift_rejected(self):
        (self.source / 'packaging/linux/notice.txt').write_text('changed source')
        with self.assertRaisesRegex(ValueError, 'source does not match'):
            self.authenticate()

    def test_source_mode_drift_rejected(self):
        (self.source / 'packaging/linux/notice.txt').chmod(0o755)
        with self.assertRaisesRegex(ValueError, 'source does not match'):
            self.authenticate()

    def test_source_fingerprint_and_duplicates_rejected(self):
        for value in [dict(self.value, workingInputSha256='0' * 64), dict(self.value, files=self.value['files'] * 2)]:
            self.manifest.write_text(json.dumps(value))
            with self.assertRaises(ValueError):
                self.authenticate()

    def test_source_cannot_omit_input_or_notice_authority(self):
        for missing in ['packaging/linux/inputs.json', 'packaging/linux/source-materials.json', 'packaging/linux/notice.txt']:
            rows = [row for row in self.value['files'] if row['path'] != missing]
            self.manifest.write_text(json.dumps(dict(self.value, files=rows, workingInputSha256=core.inventory.fingerprint(rows))))
            with self.assertRaisesRegex(ValueError, 'Source selection omits'):
                self.authenticate()

    def test_input_bytes_and_symlink_rejected(self):
        native = self.inputs / 'native.so'
        native.write_bytes(b'changed native bytes')
        with self.assertRaisesRegex(ValueError, 'Unauthenticated input'):
            self.authenticate()
        native.rename(self.inputs / 'retained-native')
        native.symlink_to('retained-native')
        with self.assertRaisesRegex(ValueError, 'Unauthenticated input'):
            self.authenticate()

    def test_corresponding_source_drift_rejected(self):
        (self.materials / 'source.tar').write_bytes(b'changed material')
        with self.assertRaisesRegex(ValueError, 'Corresponding-source material differs'):
            self.authenticate()

    def test_existing_output_is_preserved(self):
        output = self.root / 'output'
        output.mkdir()
        witness = output / 'retained'
        witness.write_bytes(b'prior evidence')
        with self.assertRaisesRegex(ValueError, 'Output must be new'):
            core.build(self.manifest, self.inputs, self.materials, self.root, output, self.root, '0.2.0')
        self.assertEqual(witness.read_bytes(), b'prior evidence')

    def test_validation_creates_no_artifacts(self):
        output = self.root / 'output'
        core.build(self.manifest, self.inputs, self.materials, self.root, output, self.root, '0.2.0', True)
        self.assertFalse(output.exists())

    def test_invalid_version_rejected_before_effects(self):
        with self.assertRaisesRegex(ValueError, 'numeric release version'):
            core.build(self.manifest, self.inputs, self.materials, self.root, self.root / 'output', self.root, '../0.2.0')


if __name__ == '__main__':
    probe.require_vm()
    unittest.main()
