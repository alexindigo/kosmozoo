#!/usr/bin/env python3
"""Actual GUI fallback/profile preservation consumers in the release guest."""
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
    parser.add_argument('--session', type=Path, required=True)
    parser.add_argument('--older-firefox', type=Path, required=True)
    args = parser.parse_args()
    run = args.evidence.resolve(); run.parent.resolve(strict=True); run.mkdir(mode=0o700)
    config = json.loads(args.session.read_text()); env = config['env'].copy()
    origin = config['origin']; profile = Path(env['XDG_DATA_HOME'])/'kosmozoo/browser/firefox'
    registry = profile/'taskbartabs/taskbartabs.json'; registry_before = registry.read_bytes()
    user = profile/'user.js'; assert not user.exists()
    unit = 'kz-native-browser-fallbacks-' + run.name
    if publication_uuid is not None:
        from publication_owner import unit_state, retire_engine, verified_window
        unit = config['unit'] + '-browser-fallbacks'
        assert unit_state(unit)['LoadState'] == 'not-found', 'Existing fallback test unit must be preserved'
    windows = lambda: json.loads(subprocess.check_output(['niri','msg','--json','windows'],env=env,text=True))
    assert not windows()
    binary = args.binary.resolve(strict=True); results = []
    def record(name, **data):
        results.append({'case': name, 'result': 'pass', **data})
        (run/'results.json').write_text(json.dumps({'binarySha256':probe.sha(binary),'cases':results},indent=2)+'\n')
        print('PASS:',name,flush=True)
    def invoke(arguments, name, child_env=None):
        with (run/(name+'.log')).open('xb') as log:
            result = subprocess.run([str(binary),*arguments],env=child_env or env,cwd=run if publication_uuid is not None else None,stdout=log,stderr=subprocess.STDOUT,timeout=30)
        assert result.returncode == 0, (run/(name+'.log')).read_text()
        return (run/(name+'.log')).read_text()
    def close(window):
        if publication_uuid is not None and verified_window(config, window) is None:
            raise RuntimeError('Foreign native fallback window; preserve it')
        subprocess.run(['niri','msg','action','close-window','--id',str(window['id'])],env=env,check=True,timeout=15)

    def observe(name, reason):
        deadline=time.monotonic()+30
        while time.monotonic()<deadline:
            current=windows()
            if any('kosmozoo' in w['title'].lower() for w in current): break
            time.sleep(.1)
        else: raise AssertionError('Native regular-browser fallback absent: '+reason)
        time.sleep(1)
        subprocess.run(['grim',str(run/(name+'.png'))],env=env,check=True)
        (run/(name+'-windows.json')).write_text(json.dumps(windows(),indent=2)+'\n')
        for window in windows(): close(window)
        deadline=time.monotonic()+10
        while windows() and time.monotonic()<deadline: time.sleep(.1)
        assert not windows()
    command=['systemd-run','--user','--unit='+unit,'--working-directory='+str(run),
        '--property=StandardOutput=file:'+str(run/'engine.log'),'--property=StandardError=file:'+str(run/'engine.log')]
    command += ['--setenv='+key+'='+value for key,value in env.items()]
    if publication_uuid is not None:
        command += ['--property=RuntimeMaxSec=900', '--property=TimeoutStopSec=30', '--property=RemainAfterExit=yes']
    subprocess.run([*command,str(binary),'serve'],env=env,check=True)
    try:
        deadline=time.monotonic()+15
        while time.monotonic()<deadline:
            try:
                runtime=probe.request(origin,'/api/runtime')
                if runtime['status']=='ready': break
            except OSError: pass
            time.sleep(.1)
        else: raise AssertionError('Fallback engine readiness absent')
        text=invoke(['app','--browser='+str(args.older_firefox.resolve())],'unsupported-firefox')
        assert 'does not provide characterized Linux app-window support' in text
        observe('unsupported-firefox','firefox-unsupported')
        assert registry.read_bytes()==registry_before
        record('actual verified Firefox132 package uses visible ordinary-browser fallback without touching native registration')
        unknown=b'user_pref("browser.taskbarTabs.enabled", unknown_external_expression);\n'
        user.write_bytes(unknown)
        text=invoke(['app','--browser=/usr/bin/firefox'],'unknown-profile')
        assert 'could not be determined' in text
        observe('unknown-profile','firefox-unknown')
        assert user.read_bytes()==unknown and registry.read_bytes()==registry_before
        record('unknown dedicated-profile data produces visible fallback and preserves exact bytes')
        user.unlink()  # Explicit retirement of this exact owned fixture only.
        chrome=Path(env['XDG_DATA_HOME'])/'kosmozoo/browser/chromium'
        assert not chrome.exists(); chrome.mkdir(mode=0o755)
        marker=chrome/'retained-work.txt'; marker.write_bytes(b'profile ownership fixture\n')
        text=invoke(['app','--browser=/usr/bin/chromium'],'uncertain-profile')
        assert 'dedicated browser profile is busy or its ownership' in text
        observe('uncertain-profile','profile-busy')
        assert marker.read_bytes()==b'profile ownership fixture\n' and chrome.stat().st_mode&0o077
        record('uncertain profile privacy refuses app launch without clearing profile data or permissions')
        text=invoke(['app','--browser=/nonexistent/firefox'],'missing-explicit')
        assert 'Explicit/saved browser must be an installed absolute executable' in text
        observe('missing-explicit','browser-failed')
        record('absent explicitly selected executable produces visible URL fallback without an installation recommendation')
        # Exercise provider absence through an isolated discovery PATH. The
        # ordinary opener fixture delegates to the actual installed native
        # browser; it changes neither the OS default nor the app adapter argv.
        tools=run/'opener-only'; tools.mkdir(mode=0o700)
        opener=tools/'xdg-open'
        opener.write_text('#!/bin/sh\nexec /usr/bin/chromium --new-window --no-first-run --ozone-platform=wayland "$@"\n'); opener.chmod(0o755)
        absent={**env,'PATH':str(tools),'XDG_DATA_HOME':str(run/'provider-absence-data')}
        text=invoke(['app'],'absent-provider',absent)
        assert 'no supported installed browser was detected' in text
        observe('absent-provider','no-browser')
        record('provider discovery absence reaches a real native ordinary browser with a whitelisted chosen-port notice')
        assert probe.request(origin,'/api/runtime')['instance']==runtime['instance']
        print('NATIVE BROWSER FALLBACK OUTCOMES PASS')
    finally:
        if user.exists() and user.read_bytes()==b'user_pref("browser.taskbarTabs.enabled", unknown_external_expression);\n': user.unlink()
        if publication_uuid is not None:
            from publication_owner import close_owned_windows
            close_owned_windows(config, env)
            retire_engine(config, unit)
        else:
            for window in windows(): close(window)
            subprocess.run(['systemctl','--user','stop',unit],check=True,timeout=35)
        state=subprocess.check_output(['systemctl','--user','show',unit,'--property=ExecMainStatus,Result,MainPID'],text=True)
        (run/'engine-final.log').write_text(state)
        assert 'ExecMainStatus=0' in state and 'Result=success' in state


if __name__=='__main__': main()
