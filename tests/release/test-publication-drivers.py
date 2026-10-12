#!/usr/bin/env python3
"""Meaningful identity/path/archive rejection contracts; never package acceptance."""
import importlib.util
import io
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
import copy

import publication_vm as vm

HERE = Path(__file__).resolve().parent
ROOT = Path('/home/tester/kosmozoo-aur-release')
UUID = '0053e86d-8233-49eb-97e0-4055e5428be7'


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), HERE / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class DriverContracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        vm.require_vm(UUID)
        cls.root = Path(tempfile.mkdtemp(prefix='publication-driver-contract-', dir=ROOT / 'tmp'))

    def test_assigned_native_identity_observed(self):
        vm.require_vm(UUID)

    def test_unknown_and_other_assigned_uuid_rejected(self):
        for value in ['00000000-0000-0000-0000-000000000000', '838fd0e0-e75a-4b21-9ada-8dad6562b151']:
            with self.assertRaises(RuntimeError):
                vm.require_vm(value)

    def test_original_runtime_cli_guard_stays_primary_only(self):
        with self.assertRaisesRegex(RuntimeError, 'Wrong execution guest'):
            load('verify-runtime').require_vm()

    def test_native_cli_wrong_uuid_cannot_create_evidence_or_invoke_installer(self):
        for name, options in [
            ('verify-native-publication', ['--binary', '/missing', '--previous-binary', '/missing', '--older-firefox', '/missing']),
            ('verify-aur-installed', ['--package-file', '/missing', '--package-name', 'kosmozoo-bin']),
        ]:
            evidence = self.root / name
            result = subprocess.run(['/usr/bin/python3', '-B', HERE / (name + '.py'), *options,
                '--workspace', ROOT, '--evidence', evidence, '--expected-vm-uuid', '00000000-0000-0000-0000-000000000000'],
                capture_output=True, timeout=20)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(b'not an assigned publication VM', result.stderr)
            self.assertFalse(evidence.exists())

    def test_short_temp_capability_preserves_data_and_refuses_conflict(self):
        target = self.root / 'retained deeply nested browser temporary data'
        target.mkdir(mode=0o700)
        witness = target / 'retained'; witness.write_bytes(b'not discarded')
        alias = vm.short_temporary(target, ROOT)
        self.assertEqual(alias.resolve(), target)
        self.assertLessEqual(len(os.fsencode(str(alias))), 60)
        self.assertEqual(vm.short_temporary(target, ROOT), alias)
        self.assertEqual(witness.read_bytes(), b'not discarded')
        alias.unlink(); alias.write_bytes(b'owned conflicting capability fixture')
        with self.assertRaises(RuntimeError):
            vm.short_temporary(target, ROOT)
        self.assertEqual(alias.read_bytes(), b'owned conflicting capability fixture')

    def test_checksum_archive_boundary_rejects_escape_duplicate_and_link(self):
        checker = load('verify-publication-checksums')
        for index, names in enumerate([['../escape'], ['same', 'same'], ['/absolute'], ['symlink']]):
            path = self.root / ('malformed-' + str(index) + '.tar.gz')
            with tarfile.open(path, 'w:gz') as archive:
                for name in names:
                    member = tarfile.TarInfo(name)
                    if name == 'symlink':
                        member.type = tarfile.SYMTYPE; member.linkname = '/outside'
                        archive.addfile(member)
                    else:
                        member.size = 7; archive.addfile(member, io.BytesIO(b'fixture'))
            with self.assertRaises(ValueError):
                checker.archive_files(path)

    def test_initial_idle_counter_cannot_admit_unknown_fixture_dimensions(self):
        ready = load('native-five-suites').fixture_dimensions_ready
        unknown = [{'name': f'bulk-{index:05d}.png', 'width': None, 'height': None} for index in range(3000)]
        self.assertFalse(ready([], {'dimsPending': 0}))
        self.assertFalse(ready(unknown, {'dimsPending': 0}))
        complete = [{**entry, 'width': 640, 'height': 360} for entry in unknown]
        self.assertFalse(ready(complete, {'dimsPending': 1}))
        self.assertTrue(ready(complete, {'dimsPending': 0}))

    def test_real_pacman_archive_identity_refuses_foreign_package(self):
        driver = load('verify-aur-installed')
        path = ROOT / 'inputs/pacman-cache-M01-20261012T035801Z-03/nodejs-26.10.0-2-x86_64.pkg.tar.zst'
        with self.assertRaisesRegex(RuntimeError, 'name selection differs'):
            driver.package(path, 'kosmozoo-bin')
        raw = subprocess.check_output(['bsdtar', '-xOf', str(path), '.PKGINFO'], text=True, timeout=30)
        fields = driver.pkginfo_fields(raw)
        self.assertEqual(fields['pkgname'], ['nodejs'])
        self.assertEqual(fields['arch'], ['x86_64'])
        self.assertIn('openssl', fields['depend'])

    def test_native_package_metadata_contract_rejects_policy_and_resource_drift(self):
        driver = load('verify-aur-installed')
        with (ROOT / 'artifacts/retained-f0f1cf3').open('rb') as stream:
            elf_header = stream.read(20)
        for name in sorted(driver.VARIANTS):
            fields = {'arch': ['x86_64'], 'depend': ['glibc', 'libgcc', 'coreutils', 'systemd', 'xdg-utils'],
                      'conflict': sorted(driver.VARIANTS - {name}), 'provides': ['kosmozoo']}
            driver.validate_package_contract(name, '0.2.0-1', fields, driver.FILES, elf_header)
            for key, value in [('arch', ['any']), ('depend', ['deno']), ('conflict', []), ('provides', [])]:
                if key == 'provides' and name == 'kosmozoo': continue
                changed = copy.deepcopy(fields); changed[key] = value
                with self.assertRaises(RuntimeError):
                    driver.validate_package_contract(name, '0.2.0-1', changed, driver.FILES, elf_header)
            for inventory, header in [(driver.FILES + ['.INSTALL'], elf_header), (driver.FILES[1:], elf_header), (driver.FILES, b'#!/bin/python')]:
                with self.assertRaises(RuntimeError):
                    driver.validate_package_contract(name, '0.2.0-1', fields, inventory, header)


if __name__ == '__main__':
    unittest.main()
