#!/usr/bin/env python3
"""Actual packaged image, offline migration and rootless retained-code recovery."""
import argparse
import base64
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import tarfile
import time
from importlib.util import module_from_spec, spec_from_file_location

spec=spec_from_file_location('runtime_probe',Path(__file__).with_name('verify-runtime.py'))
probe=module_from_spec(spec);spec.loader.exec_module(probe)
PW='sha256:70e367e0cbf60340a5b5fd562f6247a34eb3196efab9f88a3dd56482d9fe09d2'


def immutable_id(value):
    assert isinstance(value,str) and re.fullmatch(r'(?:sha256:)?[0-9a-f]{64}',value),'Not an immutable SHA256 identity'
    return 'sha256:'+value.removeprefix('sha256:')


def main():
    probe.require_vm()
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image',required=True)
    parser.add_argument('--evidence',type=Path,required=True)
    parser.add_argument('--rollback-source',type=Path,required=True)
    args=parser.parse_args()
    run=args.evidence.resolve();run.parent.resolve(strict=True);run.mkdir(mode=0o700)
    assert subprocess.check_output(['findmnt','-rn','-o','FSTYPE','-T',str(run)]).strip()!=b'tmpfs'
    source=Path(__file__).resolve().parents[2]
    rollback=args.rollback_source.resolve(strict=True)
    assert (rollback/'src/main.mjs').is_file() and (rollback/'client-solid-dist/index.html').is_file()
    for name in ['state','cache','fixtures','browser-tmp','migration-state','migration-cache','migration-fixtures']:
        (run/name).mkdir(mode=0o700)
    (run/'browser-tmp').chmod(0o1777)
    shutil.copy2(source/'tests/fixtures/flux-basic.png',run/'fixtures/flux-basic.png')
    fixture=(run/'fixtures/flux-basic.png').read_bytes()
    original=json.loads(subprocess.check_output(['docker','image','inspect',args.image]))[0]
    image=original['Id'];(run/'docker-image.json').write_text(json.dumps(original,indent=2)+'\n')
    assert original['Config']['User']=='kosmozoo' and original['Config']['WorkingDir']=='/app'
    assert original['Config']['Cmd']==['deno','run','--frozen','--cached-only','--allow-all','src/main.mjs']
    expected_env={'HOME':'/data','KOZMOZOO_STATE':'/data/state','KOZMOZOO_CACHE':'/data/cache','KOZMOZOO_BIND':'0.0.0.0','KOZMOZOO_PORT':'2084','KOZMOZOO_HOSTS':''}
    env=dict(value.split('=',1) for value in original['Config']['Env']);assert all(env[k]==v for k,v in expected_env.items())
    prefix='kz-release-image-'+run.name
    names={role:prefix+'-'+role for role in ['cold','recreated','browser','migration','old','replacement','restored']}
    for tool in ['docker','podman']:
        existing=subprocess.check_output([tool,'ps','-a','--format','{{.Names}}'],text=True).splitlines()
        assert not set(names.values())&set(existing),(tool,'occupied acceptance name')
    created=[];results=[]

    def record(case,**fields):
        results.append({'case':case,'result':'pass',**fields})
        (run/'results.json').write_text(json.dumps({'imageId':image,'cases':results},indent=2)+'\n')
        print('PASS:',case,flush=True)

    def command(argv,log=None,timeout=90):
        completed=subprocess.run(argv,capture_output=True,timeout=timeout)
        if log:(run/log).write_bytes(completed.stdout+completed.stderr)
        assert completed.returncode==0,(argv,completed.returncode,completed.stdout,completed.stderr)
        return completed.stdout

    def inspect(tool,name):return json.loads(command([tool,'inspect',name]))[0]

    def create(tool,name,selected=image,state='state',cache='cache',fixtures='fixtures',extra=None,cmd=None,network='none',port=None):
        options=[tool,'create','--pull=never','--name',name,'--network',network,'--user','1000:1000']
        if tool=='podman':options+=['--userns=keep-id']
        for directory,destination in [(state,'/data/state'),(cache,'/data/cache'),(fixtures,'/fixtures')]:
            options+=['--mount',f'type=bind,src={run/directory},dst={destination}'+(',readonly' if directory==fixtures else '')]
        if port is not None:options+=['-e','KOZMOZOO_PORT='+str(port)]
        options+=extra or []
        command([*options,selected,*(cmd or [])]);created.append((tool,name))
        before=inspect(tool,name)
        assert immutable_id(before['Image'])==immutable_id(selected) and before['Config']['User']=='1000:1000'
        assert len(before['Mounts'])==(4 if extra and '/work:ro' in ' '.join(extra) else 3)
        assert all(mount['Source'].startswith(str(run)+'/') or mount['Source']==str(rollback) for mount in before['Mounts'])
        (run/(name+'-start.json')).write_text(json.dumps(before,indent=2)+'\n')
        command([tool,'start',name])

    def query(tool,name,path,value=None,method=None,raw=False):
        pid=inspect(tool,name)['State']['Pid'];assert pid>0
        port=dict(value.split('=',1) for value in inspect(tool,name)['Config']['Env']).get('KOZMOZOO_PORT','2084')
        code='import urllib.request,base64; req=urllib.request.Request('+repr('http://127.0.0.1:'+port+path)+',data='+repr(None if value is None else json.dumps(value).encode())+',method='+repr(method)+',headers='+repr({} if value is None else {'Content-Type':'application/json'})+'); response=urllib.request.urlopen(req,timeout=12); print(base64.b64encode(response.read()).decode())'
        body=base64.b64decode(command(['sudo','-n','nsenter','--target',str(pid),'--net','--','python3','-B','-c',code],timeout=20))
        return body if raw else json.loads(body)

    def ready(tool,name,legacy=False):
        deadline=time.monotonic()+30
        while time.monotonic()<deadline:
            try:
                result=query(tool,name,'/api/settings/core.portable' if legacy else '/api/runtime')
                if legacy or result['status']=='ready':return result
            except (AssertionError,OSError):pass
            time.sleep(.1)
        raise AssertionError('Image consumer readiness absent: '+name)

    def stop(tool,name):
        command([tool,'stop','--time' if tool=='podman' else '--timeout','30',name],timeout=45)
        value=inspect(tool,name)
        label=name
        while (run/(label+'-final.json')).exists():label+='-next-stop'
        (run/(label+'-final.json')).write_text(json.dumps(value,indent=2)+'\n')
        (run/(label+'.log')).write_bytes(command([tool,'logs',name]))
        assert value['State']['ExitCode']==0 and not value['State']['OOMKilled']
        return value

    def storage(state='state'):
        db=sqlite3.connect((run/state/'metadata.db').as_uri()+'?mode=ro',uri=True)
        assert db.execute('PRAGMA user_version').fetchone()[0]==9
        assert db.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
        assert db.execute('PRAGMA foreign_key_check').fetchall()==[]
        db.close()

    def retained(tool,name,note):
        entry=query(tool,name,'/api/collections/fixtures/entries/flux-basic.png')
        assert entry['judgment']['bookmark'] and entry['judgment']['notes']['pos']==note
        assert query(tool,name,'/api/settings/core.portable')['retained']=='cold-offline'
        assert query(tool,name,'/api/collections/fixtures/entries/flux-basic.png/bytes',raw=True)==fixture

    try:
        create('docker',names['cold']);runtime=ready('docker',names['cold'])
        assert runtime['binding']=={'hostname':'0.0.0.0','port':2084}
        assert query('docker',names['cold'],'/api/collections')=={}
        command(['docker','exec',names['cold'],'id'],log='image-user.log')
        assert command(['docker','exec',names['cold'],'id','-u']).strip()==b'1000'
        assert command(['docker','exec',names['cold'],'deno','--version']).splitlines()[0]==b'deno 2.9.6 (stable, release, x86_64-unknown-linux-gnu)'
        command(['docker','exec',names['cold'],'dpkg-query','-W','libsqlite3-0'],log='sqlite-package.log')
        command(['docker','exec',names['cold'],'sha256sum','/usr/lib/x86_64-linux-gnu/libsqlite3.so.0.8.6'],log='sqlite-image.sha256')
        maps=command(['sudo','-n','/usr/bin/cat',f"/proc/{inspect('docker',names['cold'])['State']['Pid']}/maps"])
        (run/'image-native-maps.log').write_bytes(maps);assert b'libsqlite3.so.0.8.6' in maps
        for path in ['/','/shared/extractor.mjs','/shared/entry-path.mjs','/shared/source-origin.mjs','/shared/features/variations/shared.mjs','/plugins/detector/client.js']:
            assert len(query('docker',names['cold'],path,raw=True))>50
        plugins=query('docker',names['cold'],'/api/plugins');assert {row['name'] for row in plugins}=={'hello','difference','detector','critic'}
        for name in ['LICENSE','LICENSE.GPL','THIRD_PARTY_NOTICES.txt','NOTICE-SOURCES.json']:
            expected=source/name if name.startswith('LICENSE') else source/'packaging/linux/resources'/name
            observed=command(['docker','exec',names['cold'],'sha256sum','/usr/share/doc/kosmozoo/'+name]).decode().split()[0]
            assert observed==probe.sha(expected),name
        record('actual immutable image supplies offline UID1000 engine/defaults/native mappings/UI/raw modules/plugins/notices',runtime=runtime)
        query('docker',names['cold'],'/api/collections',{'name':'fixtures','address':'folder:/fixtures'})
        assert query('docker',names['cold'],'/api/collections/fixtures/entries/flux-basic.png/bytes',raw=True)==fixture
        query('docker',names['cold'],'/api/collections/fixtures/entries/flux-basic.png/judgment',{'bookmark':True,'notes':{'pos':'cold Bookworm retained'},'plugins.proof.retained':True},'PATCH')
        query('docker',names['cold'],'/api/collections/fixtures',{'pinned':True,'autoRefresh':False},'PATCH')
        query('docker',names['cold'],'/api/settings/core.portable',{'retained':'cold-offline'},'PATCH')
        command(['docker','run','--rm','--pull=never','--name',names['browser'],'--network','container:'+names['cold'],'-v',str(source)+':/work:ro','-v',str(run)+':/evidence','-v',str(run/'browser-tmp')+':/tmp','-e','TMPDIR=/tmp','-e','E2E_ENGINE=http://127.0.0.1:2084','--entrypoint','node',PW,'/work/tests/release/cold-ui.cjs'],log='cold-ui.log')
        pid=inspect('docker',names['cold'])['State']['Pid']
        stream_code='import http.client; c=http.client.HTTPConnection("127.0.0.1",2084,timeout=40); c.request("GET","/api/events"); r=c.getresponse(); assert r.status==200; assert r.read(1); print("OPEN SSE CONNECTED",flush=True); r.read(); print("OPEN SSE EOF",flush=True); c.close()'
        with (run/'open-stream.log').open('xb') as log:
            subscriber=subprocess.Popen(['sudo','-n','nsenter','--target',str(pid),'--net','--','python3','-B','-c',stream_code],stdout=log,stderr=subprocess.STDOUT)
            try:
                deadline=time.monotonic()+10
                while b'OPEN SSE CONNECTED' not in (run/'open-stream.log').read_bytes():
                    assert time.monotonic()<deadline and subscriber.poll() is None
                    time.sleep(.1)
                started=time.monotonic();stop('docker',names['cold']);assert time.monotonic()-started<30
                assert subscriber.wait(timeout=10)==0 and b'OPEN SSE EOF' in (run/'open-stream.log').read_bytes()
            finally:
                if subscriber.poll() is None:subscriber.terminate();subscriber.wait(timeout=5)
        storage()
        (run/'fixtures/flux-basic.png').rename(run/'retained-fixture.png')
        create('docker',names['recreated']);second=ready('docker',names['recreated']);assert second['instance']!=runtime['instance']
        retained('docker',names['recreated'],'cold Bookworm retained')
        flags=query('docker',names['recreated'],'/api/collections')['fixtures'];assert flags['pinned'] and not flags['autoRefresh']
        entry=query('docker',names['recreated'],'/api/collections/fixtures/entries/flux-basic.png');assert entry['judgment']['plugins']['proof']['retained']
        stop('docker',names['recreated']);storage()
        record('offline actual SPA decoded judgments, stopped schema9/integrity/FK and recreated cache/flags/plugin fields survive source removal')

        shutil.copytree(source/'tests/fixtures/state-v6',run/'migration-state',dirs_exist_ok=True)
        fixture_before={p.name:probe.sha(p) for p in (run/'migration-state').iterdir() if p.is_file()}
        (run/'migration-input.json').write_text(json.dumps(fixture_before,indent=2)+'\n')
        create('docker',names['migration'],state='migration-state',cache='migration-cache',fixtures='migration-fixtures',extra=['-e','KOZMOZOO_FEEDBACK=/data/state/feedback.json'])
        ready('docker',names['migration']);stop('docker',names['migration']);storage('migration-state')
        db=sqlite3.connect((run/'migration-state/metadata.db').as_uri()+'?mode=ro',uri=True)
        assert db.execute("SELECT vote FROM entry WHERE collection='a' AND name='shared.png'").fetchone()[0]=='up'
        assert db.execute("SELECT vote FROM entry WHERE collection='b' AND name='shared.png'").fetchone()[0]=='up'
        assert db.execute("SELECT hidden FROM entry WHERE collection='a' AND name='ghost.png'").fetchone()[0]==1
        assert db.execute("SELECT favorite,plugin_fields FROM entry WHERE collection='a' AND name='plugins-real.png'").fetchone()==(1,'{"det":{"faces":2}}')
        assert json.loads(db.execute("SELECT v FROM kv WHERE k='fold.feedback.v2.stats'").fetchone()[0])['dropped']==0
        db.close()
        assert probe.sha(run/'migration-state/feedback.json')==fixture_before['feedback.json']
        assert any(p.name.startswith('feedback.json.v1-backup-') for p in (run/'migration-state').iterdir())
        record('real v6 fixture migrates offline through schema9 preserving shared votes/hidden/plugin data and exact feedback import bytes')

        archive=run/'image.tar'
        with archive.open('xb') as output:subprocess.run(['docker','save',image],stdout=output,check=True,timeout=180)
        with tarfile.open(archive) as saved:
            manifest=json.load(saved.extractfile('manifest.json'));assert len(manifest)==1
            config_bytes=saved.extractfile(manifest[0]['Config']).read();config=json.loads(config_bytes)
            index=json.load(saved.extractfile('index.json'))
            descriptors=[entry for entry in index['manifests'] if entry['digest']==image]
            assert len(descriptors)==1,'Docker image must own one authenticated OCI manifest'
            descriptor=descriptors[0]
            manifest_bytes=saved.extractfile('blobs/sha256/'+image.removeprefix('sha256:')).read()
            assert 'sha256:'+hashlib.sha256(manifest_bytes).hexdigest()==image
            assert len(manifest_bytes)==descriptor['size']
            oci=json.loads(manifest_bytes)
            assert oci['config']['digest']=='sha256:'+hashlib.sha256(config_bytes).hexdigest()
            assert oci['config']['size']==len(config_bytes)
            assert manifest[0]['Config']=='blobs/sha256/'+oci['config']['digest'].removeprefix('sha256:')
            assert config['architecture']==original['Architecture'] and config['os']==original['Os']
            assert config['config']==original['Config']
            assert len(oci['layers'])==len(manifest[0]['Layers'])
            layers=[]
            for member,layer in zip(manifest[0]['Layers'],oci['layers']):
                assert member=='blobs/sha256/'+layer['digest'].removeprefix('sha256:')
                content=saved.extractfile(member)
                assert 'sha256:'+hashlib.file_digest(content,'sha256').hexdigest()==layer['digest']
                assert saved.getmember(member).size==layer['size']
                content.seek(0);head=content.read(2);content.seek(0)
                stream=gzip.GzipFile(fileobj=content) if head==b'\x1f\x8b' else content
                layers.append('sha256:'+hashlib.file_digest(stream,'sha256').hexdigest())
            assert layers==config['rootfs']['diff_ids']==original['RootFS']['Layers']
        archive_identity={'archiveSha256':probe.sha(archive),'configSha256':hashlib.sha256(config_bytes).hexdigest(),'diffIds':layers}
        (run/'archive-identity.json').write_text(json.dumps(archive_identity,indent=2)+'\n')
        info=json.loads(command(['podman','info','--format','json']));assert info['host']['security']['rootless'] and os.getuid()==1000
        command(['podman','load','--input',str(archive)],log='podman-load.log',timeout=240)
        candidates=[]
        for candidate in command(['podman','image','ls','--no-trunc','--format','{{.ID}}']).decode().splitlines():
            value=json.loads(command(['podman','image','inspect',candidate]))[0]
            if value['RootFS']['Layers']==layers and all(value['Config'][key]==original['Config'][key] for key in ['User','WorkingDir','Cmd','Env']):candidates.append(value)
        assert len(candidates)==1,'Imported image runtime/diff-layer identity is ambiguous or absent'
        imported=candidates[0]
        loaded=immutable_id(imported['Id'])
        assert imported['RootFS']['Layers']==layers
        for key in ['User','WorkingDir','Cmd','Env']:assert imported['Config'][key]==original['Config'][key],key
        (run/'podman-image.json').write_text(json.dumps(imported,indent=2)+'\n')
        record('Docker save config/uncompressed layer hashes and rootless Podman imported runtime contract verified',importedImageId=loaded,**archive_identity)

        port=probe.available_port()
        legacy_extra=['-v',str(rollback)+':/work:ro','-w','/work','-e','KOZMOZOO_PLUGINS=/work/plugins']
        # Preserve the real pre-executable source-bound engine as the rollback
        # code. It is deliberately the OLD leg only; replacements have data binds.
        create('podman',names['old'],selected=loaded,network='host',port=port,extra=legacy_extra,cmd=['deno','run','--frozen','--cached-only','--allow-all','src/main.mjs'])
        ready('podman',names['old'],legacy=True);retained('podman',names['old'],'cold Bookworm retained')
        query('podman',names['old'],'/api/collections/fixtures/entries/flux-basic.png/judgment',{'notes':{'pos':'rootless retained across cutover'}},'PATCH')
        stop('podman',names['old'])
        for name in ['state','cache']:shutil.copytree(run/name,run/('before-cutover-'+name))
        storage('before-cutover-state')
        create('podman',names['replacement'],selected=loaded,network='host',port=port)
        value=ready('podman',names['replacement']);retained('podman',names['replacement'],'rootless retained across cutover')
        assert len(inspect('podman',names['replacement'])['Mounts'])==3
        query('podman',names['replacement'],'/api/collections/fixtures/entries/flux-basic.png/judgment',{'notes':{'pos':'new image writes retained on code rollback'}},'PATCH')
        stop('podman',names['replacement']);storage()
        command(['podman','start',names['old']]);ready('podman',names['old'],legacy=True)
        retained('podman',names['old'],'new image writes retained on code rollback');stop('podman',names['old']);storage()
        for name in ['state','cache']:shutil.copytree(run/name,run/('after-rollback-'+name))
        record('rootless keep-id data ownership, retained actual old-source deployment, data-only image cutover and explicit code rollback preserve new writes',port=port,uid=1000)
        for name in ['state','cache']:shutil.copytree(run/('before-cutover-'+name),run/('recovered-'+name))
        storage('recovered-state')
        create('podman',names['restored'],selected=loaded,state='recovered-state',cache='recovered-cache',network='host',port=port,extra=legacy_extra,cmd=['deno','run','--frozen','--cached-only','--allow-all','src/main.mjs'])
        ready('podman',names['restored'],legacy=True);retained('podman',names['restored'],'rootless retained across cutover');stop('podman',names['restored']);storage('recovered-state')
        db=sqlite3.connect((run/'state/metadata.db').as_uri()+'?mode=ro',uri=True)
        assert json.loads(db.execute("SELECT notes FROM entry WHERE collection='fixtures' AND name='flux-basic.png'").fetchone()[0])['pos']=='new image writes retained on code rollback'
        db.close()
        record('explicit disposable full-pair snapshot recovery uses fresh siblings, restores old consumer baseline and preserves post-cutover data separately')
        print('RELEASE IMAGE ACCEPTANCE PASS')
    finally:
        for tool,name in reversed(created):
            if inspect(tool,name)['State']['Running']:stop(tool,name)
        # Retain stopped resources, save/archive, before/after state/cache and all
        # failure evidence. Never prune images, change data ownership or auto-reset.


if __name__=='__main__':main()
