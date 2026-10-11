#!/usr/bin/env python3
"""Check a sealed stopped state/cache pair inside the assigned release VM."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import sqlite3
from importlib.util import module_from_spec,spec_from_file_location

spec=spec_from_file_location('runtime_probe',Path(__file__).with_name('verify-runtime.py'))
probe=module_from_spec(spec);spec.loader.exec_module(probe)


def snapshot_rows(root):
    rows=[]
    for directory in ['state','cache']:
        base=root/directory
        assert base.is_dir() and not base.is_symlink(),directory
        for parent,dirs,files in os.walk(base,followlinks=False):
            assert all(not (Path(parent)/name).is_symlink() for name in dirs),'Snapshot directory symlink'
            for name in files:
                path=Path(parent)/name;info=path.lstat()
                assert path.is_file() and not path.is_symlink(),'Snapshot must contain ordinary owned data files'
                rows.append({'path':str(path.relative_to(root)),'sha256':probe.sha(path),'mode':oct(info.st_mode&0o777),'uid':info.st_uid,'gid':info.st_gid})
    return sorted(rows,key=lambda row:row['path'])


def canonical_state(root):
    db=sqlite3.connect((root/'state/metadata.db').as_uri()+'?mode=ro',uri=True)
    try:
        assert db.execute('PRAGMA user_version').fetchone()[0]==9
        assert db.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
        assert db.execute('PRAGMA foreign_key_check').fetchall()==[]
        tables={}
        for table in ['collection','entry','content','kv','node_registry']:
            rows=db.execute('SELECT * FROM '+table).fetchall()
            tables[table]=sorted(rows,key=lambda row:json.dumps(row,sort_keys=True))
        settings=json.loads((root/'state/settings.json').read_text())
        digest=hashlib.sha256(json.dumps({'tables':tables,'settings':settings},sort_keys=True,separators=(',',':')).encode()).hexdigest()
        return {'canonicalStateSha256':digest,'collections':len(tables['collection']),'entries':len(tables['entry'])}
    finally:db.close()


def main():
    probe.require_vm()
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence',type=Path,required=True)
    args=parser.parse_args();root=args.evidence.resolve(strict=True)
    assert str(root).startswith('/home/tester/kosmozoo-linux-release-evidence/')
    value=json.loads((root/'snapshot-input.json').read_text())
    assert value['version']==1 and value['writerStopped'] is True
    for row in value['files']:
        path=PurePosixPath(row['path'])
        assert not path.is_absolute() and '..' not in path.parts and path.parts[0] in ['state','cache']
    actual=snapshot_rows(root);assert actual==value['files'],'Stopped snapshot paths/bytes/modes/ownership differ from sealed input'
    for row in actual:
        path=PurePosixPath(row['path'])
        if path.parts[0]=='cache':
            assert len(path.parts)==3 and re.fullmatch('[0-9a-f]{64}',path.name)
            assert path.parts[1]==path.name[:2] and row['sha256']==path.name,'Incomplete/corrupt content-addressed cache'
    state=canonical_state(root);assert state['canonicalStateSha256']==value['canonicalStateSha256'],'Canonical user state differs'
    with (root/'snapshot-check.json').open('x') as output:json.dump({'version':1,**state,'schema':9,'integrity':'ok','foreignKeyViolations':0,'completeFiles':len(actual)},output,indent=2);output.write('\n')
    print('CUTOVER SNAPSHOT CHECK PASS:',state)


if __name__=='__main__':main()
