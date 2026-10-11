#!/usr/bin/env python3
"""Allow-listed cached/static/SSE consumer; never recursively lists a source."""
import argparse
import hashlib
import http.client
import json
from pathlib import Path
import re
import time
from urllib.parse import urlsplit
from importlib.util import module_from_spec,spec_from_file_location

spec=spec_from_file_location('runtime_probe',Path(__file__).with_name('verify-runtime.py'))
probe=module_from_spec(spec);spec.loader.exec_module(probe)
SHARED=['extractor.mjs','entry-path.mjs','source-origin.mjs','features/variations/shared.mjs']


def main():
    probe.require_vm()
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence',type=Path,required=True)
    parser.add_argument('--fixture-origin',help='Explicit disposable VM fixture only; production origin is fixed')
    args=parser.parse_args();root=args.evidence.resolve(strict=True)
    expected=json.loads((root/'readonly-input.json').read_text());assert expected['version']==1
    origin=args.fixture_origin or 'http://architect.home:2084'
    address=urlsplit(origin)
    assert address.scheme=='http' and address.path in ['','/'] and not address.query and not address.fragment and not address.username
    if args.fixture_origin:assert address.hostname=='127.0.0.1' and address.port and 1<=address.port<=65535
    else:assert origin=='http://architect.home:2084'
    requests=[];results=[]

    def read(path):
        assert path=='/api/runtime' or path.startswith('/shared/') or re.fullmatch(r'/api/content/[0-9a-f]{64}/bytes',path)
        connection=http.client.HTTPConnection(address.hostname,address.port,timeout=15)
        try:
            requests.append({'method':'GET','path':path})
            connection.request('GET',path);response=connection.getresponse();assert response.status==200,(path,response.status)
            return response.read()
        finally:connection.close()

    runtime=json.loads(read('/api/runtime'));assert runtime['status']=='ready'
    assert runtime['binding']['port']==address.port
    for name in SHARED:
        digest=hashlib.sha256(read('/shared/'+name)).hexdigest()
        assert digest==expected['sharedModules'][name],name
        results.append({'path':'/shared/'+name,'sha256':digest})
    for item in expected['cachedContent']:
        assert re.fullmatch('[0-9a-f]{64}',item['sha256'])
        body=read('/api/content/'+item['sha256']+'/bytes')
        assert hashlib.sha256(body).hexdigest()==item['sha256'] and len(body)==item['size']
        results.append({'cachedContent':item['sha256'],'bytes':len(body)})
    connection=http.client.HTTPConnection(address.hostname,address.port,timeout=45)
    native=[];started=time.monotonic();requests.append({'method':'GET','path':'/api/events'})
    try:
        connection.request('GET','/api/events');response=connection.getresponse()
        assert response.status==200 and response.getheader('Content-Type').startswith('text/event-stream')
        data=[]
        while time.monotonic()-started<120:
            line=response.readline();assert line,'Native stream terminated before120s'
            line=line.decode().rstrip('\r\n')
            if line.startswith('data:'):data.append(line[5:].lstrip())
            elif not line and data:
                frame=json.loads('\n'.join(data));data=[]
                assert frame['version']==1 and isinstance(frame['sources'],dict)
                assert {key:{field:value[field] for field in ['address','pinned','autoRefresh']} for key,value in frame['sources'].items()}==expected['sources']
                native.append({'epoch':frame['epoch'],'revision':frame['revision'],'sources':len(frame['sources'])})
        assert native and time.monotonic()-started>=120
    finally:connection.close()
    assert all(item['method']=='GET' and '/activity' not in item['path'] for item in requests)
    value={'version':1,'origin':origin,'fixture':bool(args.fixture_origin),'runtime':runtime,'results':results,'nativeFrames':native,'idleSeconds':time.monotonic()-started,'eventConnections':1,'activityGets':0,'requests':requests,'boundary':'cached content/shared module bytes and native SSE producer-to-client delivery; no full SPA or generation/deletion/settings mutation'}
    with (root/'readonly-result.json').open('x') as output:json.dump(value,output,indent=2);output.write('\n')
    print('READONLY DEPLOYED IMAGE PASS:',origin,'fixture' if args.fixture_origin else 'production',len(results),'cached/static consumers and120s native delivery')


if __name__=='__main__':main()
