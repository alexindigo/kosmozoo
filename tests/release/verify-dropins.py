#!/usr/bin/env python3
"""Compiled trusted-local-plugin import parity at actual route consumers."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time
from importlib.util import module_from_spec, spec_from_file_location

spec = spec_from_file_location('runtime_probe', Path(__file__).with_name('verify-runtime.py'))
probe = module_from_spec(spec); spec.loader.exec_module(probe)


def main(publication_uuid=None):
    if publication_uuid is None:
        probe.require_vm()
    else:
        from publication_vm import require_vm as require_publication_vm
        require_publication_vm(publication_uuid)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--evidence', type=Path, required=True)
    args = parser.parse_args()
    run = args.evidence.resolve(); run.parent.resolve(strict=True); run.mkdir(mode=0o700)
    for name in ['home', 'state', 'cache', 'tmp']:
        (run/name).mkdir(mode=0o700)
    root = run/'home/data/kosmozoo/plugins'
    for name in ['local-js', 'local-ts']:
        (root/name).mkdir(parents=True, mode=0o700)
    (root/'local-js/helper.mjs').write_text('export const result = "external-relative-module";\n')
    (root/'local-js/plugin.mjs').write_text('import { result } from "./helper.mjs"; export function register(kz) { kz.route("GET", "/proof", () => Response.json({result})); }\n')
    (root/'local-ts/plugin.ts').write_text('const result: string = "external-typescript"; export function register(kz: any) { kz.route("GET", "/proof", () => Response.json({result})); }\n')
    port = probe.available_port(); origin = f'http://127.0.0.1:{port}'
    env = {key:value for key,value in os.environ.items() if not key.startswith(('DENO_', 'KOZMOZOO_', 'XDG_'))}
    env.update({'HOME': str(run/'home'), 'XDG_DATA_HOME': str(run/'home/data'), 'TMPDIR': str(run/'tmp'),
        'KOZMOZOO_STATE': str(run/'state'), 'KOZMOZOO_CACHE': str(run/'cache'), 'KOZMOZOO_HOSTS': '',
        'KOZMOZOO_BIND': '127.0.0.1', 'KOZMOZOO_PORT': str(port)})
    results = {'binarySha256': probe.sha(args.binary), 'routes': []}
    with (run/'engine.log').open('xb') as log:
        process = subprocess.Popen([str(args.binary.resolve()), 'serve'], env=env, cwd=run, stdout=log, stderr=subprocess.STDOUT)
        try:
            deadline = time.monotonic()+15
            while time.monotonic()<deadline:
                try:
                    runtime = probe.request(origin, '/api/runtime')
                    if runtime['status']=='ready': break
                except OSError: pass
                if process.poll() is not None: raise AssertionError('Plugin engine startup failed; see retained log')
                time.sleep(.1)
            else: raise AssertionError('Plugin engine readiness absent')
            results['plugins'] = probe.request(origin, '/api/plugins')
            for name, expected in [('local-js', 'external-relative-module'), ('local-ts', 'external-typescript')]:
                actual = probe.request(origin, f'/api/plugins/{name}/proof')
                assert actual == {'result': expected}
                results['routes'].append({'plugin': name, 'actual': actual})
                (run/'results.json').write_text(json.dumps(results,indent=2)+'\n')
                print('PASS: actual compiled route consumed trusted local', name, flush=True)
            print('COMPILED LOCAL DROP-IN PARITY PASS')
        finally:
            process.terminate(); code = process.wait(timeout=30)
            results['engineExitCode'] = code
            (run/'results.json').write_text(json.dumps(results,indent=2)+'\n')
            assert code == 0


if __name__ == '__main__': main()
