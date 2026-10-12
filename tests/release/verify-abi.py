#!/usr/bin/env python3
"""Measured ELF/dependency/GNU-ABI evidence; does not invent a CPU minimum."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
from importlib.util import module_from_spec, spec_from_file_location

spec=spec_from_file_location('runtime_probe',Path(__file__).with_name('verify-runtime.py'))
probe=module_from_spec(spec);spec.loader.exec_module(probe)


def main(publication_uuid=None):
    if publication_uuid is None:
        probe.require_vm()
    else:
        from publication_vm import require_vm as require_publication_vm
        require_publication_vm(publication_uuid)
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary',type=Path,required=True)
    parser.add_argument('--evidence',type=Path,required=True)
    parser.add_argument('--inputs',type=Path)
    args=parser.parse_args()
    run=args.evidence.resolve();run.parent.resolve(strict=True);run.mkdir(mode=0o700)
    inputs=args.inputs or Path('/home/tester/kosmozoo-linux-release-evidence/release-continuation/release-inputs')
    files={'denort':inputs/'denort/denort','sqlite':inputs/'libsqlite3.so.0.8.6','binary':args.binary.resolve(strict=True)}
    rows={}
    for name,path in files.items():
        data={}
        for section,options in [('header',['-h']),('programs',['-l']),('dynamic',['-d']),('versions',['-V']),('notes',['-n'])]:
            output=subprocess.check_output(['readelf',*options,str(path)],text=True)
            (run/(name+'-'+section+'.log')).write_text(output);data[section]=output
        assert 'ELF64' in data['header'] and 'Advanced Micro Devices X86-64' in data['header']
        versions=sorted(set(re.findall(r'GLIBC_(\d+\.\d+(?:\.\d+)?)',data['versions'])),key=lambda version:tuple(map(int,version.split('.'))))
        needed=re.findall(r'\(NEEDED\).*?\[([^\]]+)\]',data['dynamic'])
        interpreter=re.findall(r'Requesting program interpreter: ([^\]]+)',data['programs'])
        closure=subprocess.check_output(['ldd',str(path)],text=True);(run/(name+'-closure.log')).write_text(closure)
        assert 'not found' not in closure
        rows[name]={'sha256':probe.sha(path),'needed':needed,'requiredGlibcVersions':versions,'interpreter':interpreter,'archClosure':closure,
            'cpuAssumption':'GNU x86_64 measured on recorded guest CPU; no lower universal ISA promise'}
    cpu=json.loads(subprocess.check_output(['lscpu','--json'],text=True))
    libc=subprocess.check_output(['getconf','GNU_LIBC_VERSION'],text=True).strip()
    (run/'abi.json').write_text(json.dumps({'version':1,'target':'x86_64-unknown-linux-gnu','archGuestLibc':libc,'guestCPU':cpu,
        'files':rows,'portabilityConsumerEvidence':'separate fresh Bookworm cold/no-system-SQLite/no-Deno/outbound-isolated gate required'},indent=2)+'\n')
    assert rows['binary']['interpreter']==['/lib64/ld-linux-x86-64.so.2']
    assert rows['denort']['needed']==rows['binary']['needed']
    print('MEASURED GNU ELF/ARCH DEPENDENCY CLOSURE PASS:',libc,rows['sqlite']['requiredGlibcVersions'][-1])


if __name__=='__main__':main()
