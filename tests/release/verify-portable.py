#!/usr/bin/env python3
"""Fresh Bookworm binary-only offline payload, persistence and native failures."""
import argparse
import base64
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import time
from importlib.util import module_from_spec, spec_from_file_location

spec = spec_from_file_location('runtime_probe', Path(__file__).with_name('verify-runtime.py'))
probe = module_from_spec(spec); spec.loader.exec_module(probe)
PW='sha256:70e367e0cbf60340a5b5fd562f6247a34eb3196efab9f88a3dd56482d9fe09d2'


def main():
    probe.require_vm()
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary',type=Path,required=True)
    parser.add_argument('--image-input',type=Path,required=True)
    parser.add_argument('--evidence',type=Path,required=True)
    args=parser.parse_args()
    image=json.loads(args.image_input.read_text())[0]
    assert 'debian:bookworm-slim' in image['RepoTags']
    assert 'debian@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587' in image['RepoDigests']
    image_id=image['Id']
    run=args.evidence.resolve();run.parent.resolve(strict=True);run.mkdir(mode=0o700)
    for name in ['home','state','cache','tmp','fixtures','browser-tmp','readonly-tmp','noexec-tmp']:
        (run/name).mkdir(mode=0o700)
    (run/'browser-tmp').chmod(0o1777)
    binary=run/'kosmozoo space % café';shutil.copy2(args.binary.resolve(strict=True),binary)
    source=Path(__file__).resolve().parents[2]
    shutil.copy2(source/'tests/fixtures/flux-basic.png',run/'fixtures/flux-basic.png')
    fixture=(run/'fixtures/flux-basic.png').read_bytes()
    name='kz-portable-'+run.name;browser_name=name+'-browser'
    occupied=subprocess.check_output(['docker','ps','-a','--format','{{.Names}}'],text=True).splitlines()
    assert name not in occupied and browser_name not in occupied
    results=[];created=False;noexec_mounted=False
    def record(case,**fields):
        results.append({'case':case,'result':'pass',**fields})
        (run/'results.json').write_text(json.dumps({'binarySha256':probe.sha(binary),'imageId':image_id,'cases':results},indent=2)+'\n')
        print('PASS:',case,flush=True)
    def command(argv,expected=0,log=None):
        result=subprocess.run(argv,capture_output=True,timeout=45)
        if log:(run/log).write_bytes(result.stdout+result.stderr)
        assert result.returncode==expected,(argv,result.returncode,result.stdout,result.stderr)
        return result.stdout
    def inspect():return json.loads(subprocess.check_output(['docker','inspect',name]))[0]
    def query(path,value=None,method=None,binary_response=False):
        pid=inspect()['State']['Pid'];assert pid>0
        code='import urllib.request,json,base64; req=urllib.request.Request("http://127.0.0.1:2084"+'+repr(path)+',data='+repr(None if value is None else json.dumps(value).encode())+',method='+repr(method)+',headers='+repr({} if value is None else {'Content-Type':'application/json'})+'); response=urllib.request.urlopen(req,timeout=10); body=response.read(); print(base64.b64encode(body).decode() if '+repr(binary_response)+' else body.decode())'
        # Namespace entry happens inside the verified VM, never the physical
        # host. Consumer code stays on the guest filesystem; engine gets only
        # binary/data binds and outbound networking remains unavailable.
        raw=subprocess.check_output(['sudo','-n','nsenter','--target',str(pid),'--net','--','python3','-B','-c',code],timeout=15)
        return base64.b64decode(raw) if binary_response else json.loads(raw)
    def start():
        nonlocal created
        options=['docker','create','--pull=never','--name',name,'--network','none','--user','1000:1000','--workdir','/data/home','--entrypoint','/artifact/kosmozoo']
        for original,destination,readonly in [(binary,'/artifact/kosmozoo',True),(run/'state','/data/state',False),(run/'cache','/data/cache',False),
            (run/'tmp','/data/tmp',False),(run/'home','/data/home',False),(run/'fixtures','/fixtures',True)]:
            options+=['--mount',f'type=bind,src={original},dst={destination}'+(',readonly' if readonly else '')]
        for key,value in {'HOME':'/data/home','TMPDIR':'/data/tmp','KOZMOZOO_STATE':'/data/state','KOZMOZOO_CACHE':'/data/cache','KOZMOZOO_HOSTS':''}.items():options+=['-e',key+'='+value]
        command([*options,image_id,'serve']);created=True
        command(['docker','start',name])
        deadline=time.monotonic()+20
        while time.monotonic()<deadline:
            try:
                runtime=query('/api/runtime')
                if runtime['status']=='ready':return runtime
            except (subprocess.CalledProcessError,OSError):pass
            time.sleep(.1)
        raise AssertionError('Cold Bookworm readiness absent')
    def stop(label,remove=True):
        nonlocal created
        command(['docker','logs',name],log=label+'-engine.log')
        command(['docker','stop','--timeout','30',name])
        state=inspect();(run/(label+'-final.json')).write_text(json.dumps(state,indent=2)+'\n')
        assert state['State']['ExitCode']==0 and not state['State']['OOMKilled']
        if remove:command(['docker','rm',name]);created=False
    try:
        first=start();initial=inspect();(run/'engine-start.json').write_text(json.dumps(initial,indent=2)+'\n')
        assert initial['Image']==image_id and initial['HostConfig']['NetworkMode']=='none' and len(initial['Mounts'])==6
        assert initial['Config']['User']=='1000:1000' and initial['Config']['Entrypoint']==['/artifact/kosmozoo']
        assert first['binding']=={'hostname':'0.0.0.0','port':2084}
        command(['docker','exec',name,'/bin/sh','-c','! command -v deno && ! command -v docker && ! dpkg-query -W libsqlite3-0 2>/dev/null'],log='absence.log')
        record('fresh outbound-isolated Bookworm boots artifact/data only with no installed Deno/Docker/system SQLite',runtime=first)
        pid=initial['State']['Pid']
        maps=command(['sudo','-n','/usr/bin/cat',f'/proc/{pid}/maps']).decode();(run/'maps.log').write_text(maps)
        paths={line.split(None,5)[5] for line in maps.splitlines() if 'deno-native-addons' in line}
        selected=[path for path in paths if path.startswith('/data/tmp/') and probe.sha(run/'tmp'/Path(path).relative_to('/data/tmp'))=='2e6eef9a727f081f0d453b4e5e6cbd8b9ef8b6f86cbf7681cbad444d3b0b55c8']
        assert len(selected)==1,paths
        record('fresh Bookworm actually maps the pinned embedded native bytes',mappedPath=selected[0])
        for path in ['/','/shared/extractor.mjs','/shared/entry-path.mjs','/shared/source-origin.mjs','/shared/features/variations/shared.mjs','/plugins/detector/client.js']:
            assert len(query(path,binary_response=True))>50
        query('/api/collections',{'name':'fixtures','address':'folder:/fixtures'})
        assert query('/api/collections/fixtures/entries/flux-basic.png/bytes',binary_response=True)==fixture
        query('/api/collections/fixtures/entries/flux-basic.png/judgment',{'bookmark':True,'notes':{'pos':'cold Bookworm retained'}},'PATCH')
        query('/api/collections/fixtures',{'pinned':True,'autoRefresh':False},'PATCH')
        query('/api/settings/core.portable',{'retained':'cold-offline'},'PATCH')
        record('native Bookworm writes reach actual bytes/judgment/settings/source-flag consumers')
        command(['docker','run','--rm','--pull=never','--name',browser_name,'--network','container:'+name,
            '-v',str(source)+':/work:ro','-v',str(run)+':/evidence','-v',str(run/'browser-tmp')+':/tmp',
            '-e','TMPDIR=/tmp','-e','E2E_ENGINE=http://127.0.0.1:2084','--entrypoint','node',PW,'/work/tests/release/cold-ui.cjs'],log='cold-ui.log')
        record('actual cold SPA modules render decoded native bytes and persisted judgments with outbound network unavailable')
        stop('first')
        db=sqlite3.connect(run/'state/metadata.db')
        try:
            assert db.execute('PRAGMA user_version').fetchone()[0]==9
            assert db.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
            assert db.execute('PRAGMA foreign_key_check').fetchall()==[]
        finally:db.close()
        record('stopped native storage is schema9/integrity ok/zero foreign-key violations')
        shutil.move(run/'fixtures/flux-basic.png',run/'retained-fixture.png')
        second=start()
        assert second['instance']!=first['instance']
        entry=query('/api/collections/fixtures/entries/flux-basic.png')
        assert entry['judgment']['bookmark'] and entry['judgment']['notes']['pos']=='cold Bookworm retained'
        assert query('/api/settings/core.portable')['retained']=='cold-offline'
        collections=query('/api/collections');saved=collections['fixtures']
        assert saved['pinned'] is True and saved['autoRefresh'] is False
        assert query('/api/collections/fixtures/entries/flux-basic.png/bytes',binary_response=True)==fixture
        record('cold recreation retains SQLite/settings/flags and cached bytes after source removal')
        stop('second')
        database_before=probe.sha(run/'state/metadata.db');settings_before=(run/'state/settings.json').read_bytes()
        (run/'readonly-tmp').chmod(0o500)
        command(['sudo','-n','mount','--bind',str(run/'noexec-tmp'),str(run/'noexec-tmp')]);noexec_mounted=True
        command(['sudo','-n','mount','-o','remount,bind,noexec',str(run/'noexec-tmp')])
        for case,tmp,extra,needle in [('invalid-override',run/'tmp',{'DENO_SQLITE_PATH':'/missing.so'},'DENO_SQLITE_PATH'),
            ('local-download-refused',run/'tmp',{'DENO_SQLITE_LOCAL':'1'},'DENO_SQLITE_LOCAL'),
            ('readonly-cache',run/'readonly-tmp',{},'Permission denied'),('noexec-cache',run/'noexec-tmp',{},'failed to map')]:
            options=['docker','run','--rm','--pull=never','--network','none','--user','1000:1000','--entrypoint','/artifact/kosmozoo',
                '-v',str(binary)+':/artifact/kosmozoo:ro','-v',str(run/'state')+':/data/state','-v',str(tmp)+':/data/tmp',
                '-e','HOME=/data/home','-e','TMPDIR=/data/tmp','-e','KOZMOZOO_STATE=/data/state','-e','KOZMOZOO_HOSTS=']
            for key,value in extra.items():options+=['-e',key+'='+value]
            output=subprocess.run([*options,image_id,'serve'],capture_output=True,timeout=30)
            text=(output.stdout+output.stderr).decode();(run/(case+'.log')).write_text(text)
            assert output.returncode==1 and needle.lower() in text.lower(),(case,output.returncode,text)
            assert probe.sha(run/'state/metadata.db')==database_before and (run/'state/settings.json').read_bytes()==settings_before
            assert not (run/'state/engine-instance.json').exists()
            record('native failure '+case+' reports failure without downloading/reseeding retained state',output=text)
        print('BOOKWORM COLD PORTABILITY AND NATIVE FAILURE OUTCOMES PASS')
    finally:
        if created:stop('cleanup',remove=False)
        if noexec_mounted:command(['sudo','-n','umount',str(run/'noexec-tmp')])


if __name__=='__main__':main()
