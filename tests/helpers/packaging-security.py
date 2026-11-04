"""Exercise publication trust boundaries without executing selected project code."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'packaging/linux' / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


inventory = load('inventory', 'source-input.py')
core = load('core', 'build-core.py')


class PackagingSecurity(unittest.TestCase):
    def test_git_inventory_never_runs_repository_or_ambient_helpers(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = root / 'repo'
            repo.mkdir()
            env = {**os.environ, 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null'}
            subprocess.run(['git', 'init', '-q', str(repo)], env=env, check=True)
            (repo / 'file').write_text('tracked input')
            subprocess.run(['git', '-C', str(repo), 'add', 'file'], env=env, check=True)
            marker = root / 'executed'
            hook = root / 'fsmonitor'
            hook.write_text(f'#!/bin/sh\ntouch "{marker}"\nprintf "token\\0"\n')
            hook.chmod(0o755)
            subprocess.run(['git', '-C', str(repo), 'config', 'core.fsmonitor', str(hook)], env=env, check=True)
            inventory.git(repo, 'status', '--porcelain=v1', '-z')
            self.assertFalse(marker.exists(), 'repository fsmonitor executed during inventory')
            subprocess.run(['git', '-C', str(repo), 'config', '--unset', 'core.fsmonitor'], env=env, check=True)
            config = root / 'global-config'
            config.write_text(f'[core]\n fsmonitor = {hook}\n')
            previous = os.environ.get('GIT_CONFIG_GLOBAL')
            os.environ['GIT_CONFIG_GLOBAL'] = str(config)
            try:
                inventory.git(repo, 'status', '--porcelain=v1', '-z')
                self.assertFalse(marker.exists(), 'ambient fsmonitor executed during inventory')
            finally:
                if previous is None:
                    del os.environ['GIT_CONFIG_GLOBAL']
                else:
                    os.environ['GIT_CONFIG_GLOBAL'] = previous

    def selection(self, root):
        policy = root / 'packaging/linux'
        policy.mkdir(parents=True)
        (policy / 'inputs.json').write_text(json.dumps({'inputs': {}}))
        (policy / 'source-materials.json').write_text(json.dumps({'noticeFiles': {}, 'materials': []}))
        (root / 'build.mjs').write_text('// authenticated regular source')

    def test_git_inventory_never_runs_content_filters(self):
        for operation in ['clean', 'process']:
            with self.subTest(operation=operation), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                env = {**os.environ, 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null'}
                subprocess.run(['git', 'init', '-q', str(root)], env=env, check=True)
                (root / 'file').write_text('tracked input')
                (root / '.gitattributes').write_text('file filter=attacker\n')
                subprocess.run(['git', '-C', str(root), 'add', 'file', '.gitattributes'], env=env, check=True)
                marker = root / 'executed'
                hook = root / 'filter'
                hook.write_text(f'#!/bin/sh\ntouch "{marker}"\n' + ('cat\n' if operation == 'clean' else 'exit 1\n'))
                hook.chmod(0o755)
                subprocess.run(['git', '-C', str(root), 'config', f'filter.attacker.{operation}', str(hook)], env=env, check=True)
                subprocess.run(['git', '-C', str(root), 'config', 'filter.attacker.required', 'true'], env=env, check=True)
                info = (root / 'file').stat()
                os.utime(root / 'file', ns=(info.st_atime_ns, info.st_mtime_ns + 2_000_000_000))
                inventory.git(root, 'status', '--porcelain=v1', '-z')
                self.assertFalse(marker.exists(), f'content {operation} filter executed during inventory')

    def authenticate(self, root, names):
        rows = [inventory.source_row(root, name) for name in sorted(names)]
        manifest = root / 'selection.json'
        manifest.write_text(json.dumps({'files': rows, 'workingInputSha256': inventory.fingerprint(rows), 'commit': None}))
        old = core.SOURCE
        core.SOURCE = root
        try:
            return core.authenticate(manifest, root, root)
        finally:
            core.SOURCE = old

    def test_authentication_rejects_file_policy_and_parent_symlinks(self):
        for target in ['build.mjs', 'packaging/linux/inputs.json', 'parent']:
            with self.subTest(target=target), tempfile.TemporaryDirectory() as directory:
                root = Path(directory) / 'source'
                root.mkdir()
                self.selection(root)
                names = ['build.mjs', 'packaging/linux/inputs.json', 'packaging/linux/source-materials.json']
                if target == 'parent':
                    outside = Path(directory) / 'outside'
                    outside.mkdir()
                    (outside / 'module.mjs').write_text('// unauthenticated target')
                    (root / 'src').symlink_to(outside, target_is_directory=True)
                    names.append('src/module.mjs')
                else:
                    outside = Path(directory) / 'outside'
                    (root / target).rename(outside)
                    (root / target).symlink_to(outside)
                with self.assertRaisesRegex(ValueError, 'symlink|regular'):
                    self.authenticate(root, names)

    def test_authentication_accepts_complete_regular_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.selection(root)
            result = self.authenticate(root, ['build.mjs', 'packaging/linux/inputs.json', 'packaging/linux/source-materials.json'])
            self.assertEqual(result[3], {})


if __name__ == '__main__':
    unittest.main()
