#!/usr/bin/env python3
"""Private VM wrapper; public and private builds share one authenticated core."""
import argparse
import importlib.util
import os
from pathlib import Path
import subprocess

HERE = Path(__file__).resolve().parent


def main():
    subprocess.run(['systemd-detect-virt', '--vm'], check=True, stdout=subprocess.DEVNULL, timeout=15)
    uuid = subprocess.check_output(['sudo', '-n', '/usr/bin/cat', '/sys/class/dmi/id/product_uuid'], timeout=15).decode().strip().lower()
    if uuid != '838fd0e0-e75a-4b21-9ada-8dad6562b151':
        raise SystemExit('Wrong execution VM')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-manifest', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    evidence = Path(os.environ['EVIDENCE']).resolve(strict=True)
    if subprocess.check_output(['findmnt', '-rn', '-o', 'FSTYPE', '-T', str(evidence)], timeout=15).strip() == b'tmpfs':
        raise SystemExit('Evidence must be disk-backed')
    spec = importlib.util.spec_from_file_location('build_core', HERE / 'build-core.py')
    core = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(core)
    core.build(args.source_manifest.resolve(strict=True),
        Path(os.environ.get('KOSMOZOO_RELEASE_INPUTS', '/home/tester/kosmozoo-linux-release-evidence/release-continuation/release-inputs')).resolve(strict=True),
        Path(os.environ.get('KOSMOZOO_SOURCE_MATERIALS', '/home/tester/kosmozoo-linux-release-evidence/release-continuation/desktop-startup-audit/license-research')).resolve(strict=True),
        Path(os.environ.get('KOSMOZOO_BUILD_CACHE', '/home/tester/kosmozoo-linux-release-evidence/release-continuation/file-readiness-correction/consolidation/deno-cache')).resolve(strict=True),
        args.output.absolute(), evidence)


if __name__ == '__main__':
    main()
