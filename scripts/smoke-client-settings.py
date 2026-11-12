#!/usr/bin/env python3
"""Build-output smoke in a temporary full desktop copy; never edits the live application.

Uses real Electron input/IPC and native Wayland supervisor restarts with an empty
DSH_HOME. Only explicitly allowlisted source/built paths are copied into this
short-lived tree. No credentials or profile are copied from the user's home.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--source', type=Path, default=Path('/opt/deepseek-harness-desktop'))
p.add_argument('--output', type=Path, default=ROOT/'dist/client-settings-smoke')
p.add_argument('--display', default=os.environ.get('WAYLAND_DISPLAY', 'wayland-0'))
args = p.parse_args()
source=args.source.resolve(strict=True)
built=ROOT/'upstream/apps/desktop/lib'
proxy=ROOT/'upstream/apps/desktop/resources/wayland_blur_proxy.py'
if not (source/'resources/app/lib/main.js').is_file() or not (built/'main.js').is_file():
    raise SystemExit('Build desktop artifacts first; --source must be an installed unpacked desktop runtime')
args.output.mkdir(parents=True, exist_ok=True)
output=args.output.resolve()
# stage is our own retained smoke state; explicitly verify it before removing.
stage=output/'stage.json'
assert stage.parent==output and stage.name=='stage.json'
stage.unlink(missing_ok=True)
with tempfile.TemporaryDirectory(prefix='dsh-client-settings-smoke-') as temporary:
    runtime=Path(temporary)/'runtime'
    subprocess.run(['cp','-a','--reflink=auto','--no-preserve=ownership',str(source),str(runtime)],check=True)
    lib=runtime/'resources/app/lib'
    shutil.copytree(built,lib,dirs_exist_ok=True)
    shutil.copy2(proxy,runtime/'resources/wayland_blur_proxy.py')
    main=lib/'main.js'
    text=main.read_text()
    anchor='if (!enteredWorkspace && needsWelcome({'
    if text.count(anchor)!=1: raise RuntimeError('Unknown built welcome entry')
    text=text.replace(anchor,'if (!enteredWorkspace && false && needsWelcome({',1)
    # All instrumentation lives in the disposable copy, never in build output.
    main.write_text((ROOT/'scripts/client-settings-smoke.mjs').read_text()+'\n'+text)
    env=os.environ.copy()
    for key in ['ELECTRON_RUN_AS_NODE','LD_PRELOAD','DSH_WAYLAND_PROXY_ACTIVE','DSH_WAYLAND_PROXY_RESTART_FILE','WAYLAND_SOCKET']:
        env.pop(key,None)
    env['DSH_HOME']=str(Path(temporary)/'empty-home')
    env['DSH_CLIENT_SMOKE_OUTPUT']=str(output)
    env['WAYLAND_DISPLAY']=args.display
    for key in ['DSH_DESKTOP_GLASS','DSH_DESKTOP_FRAMELESS','DSH_DESKTOP_GLASS_TINT']:
        env.pop(key,None)
    env['DSH_DESKTOP_LANGUAGE']='zh-CN'
    profile=Path(temporary)/'electron-profile'
    profile.mkdir()
    (profile/'locale.json').write_text(json.dumps({'language':'zh-CN'}))
    command=['python3',str(proxy),'--verbose','--surface-title','DeepSeek Harness — Workspace','--shadow','--corner-radius','12','--upstream',args.display,'--',
             str(runtime/'deepseek-harness'),'--ozone-platform=wayland','--user-data-dir='+str(profile)]
    log_path=output/'private-runtime.log'
    with log_path.open('w') as log:
        os.chmod(log_path,0o600)
        process=subprocess.Popen(command,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
        try: code=process.wait(timeout=130)
        except subprocess.TimeoutExpired: code=124
        finally:
            try: os.killpg(process.pid,signal.SIGTERM)
            except ProcessLookupError: pass
    for line in log_path.read_text(errors='replace').splitlines():
        if line.startswith('CLIENT_SMOKE'): print(line)
    print('Native desktop settings smoke exit:',code)
    result=output/'result.json'
    if code==0 and (not result.exists() or not json.loads(result.read_text()).get('ok')): code=1
    raise SystemExit(code)
