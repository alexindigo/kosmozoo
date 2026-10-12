#!/usr/bin/env python3
"""Bounded aggregate worker adapter; standalone legacy CLI guards stay primary-only."""
import argparse
import importlib.util
from pathlib import Path
import sys

import publication_vm as vm

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--worker', choices=['runtime', 'chromium', 'dropins', 'abi', 'installer', 'firefox', 'browser-fallbacks'], required=True)
parser.add_argument('--expected-vm-uuid', required=True)
parser.add_argument('arguments', nargs=argparse.REMAINDER)
args = parser.parse_args()
vm.require_vm(args.expected_vm_uuid)
path = Path(__file__).with_name('verify-' + args.worker + '.py')
spec = importlib.util.spec_from_file_location('publication_' + args.worker.replace('-', '_'), path)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
sys.argv = [str(path), *(args.arguments[1:] if args.arguments[:1] == ['--'] else args.arguments)]
worker.main(publication_uuid=args.expected_vm_uuid)
