#!/usr/bin/env python3
"""Upgrade the existing isolated test stack; never bootstrap AD or replace data volumes."""
import argparse
import datetime
import json
import pathlib
import re
import shutil
import sqlite3
import subprocess
import time

ROOT = pathlib.Path('/data/assay-samba-test')


def run(*args, check=True):
    return subprocess.run(args, cwd=ROOT, check=check, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='Apply after preserving configuration, SQLite and image references')
    parser.add_argument('--image', default='assay-samba-agent:unified-test')
    parser.add_argument('--api-image', default='assay-api:unified-test')
    args = parser.parse_args()
    if not all(re.fullmatch(r'[A-Za-z0-9./_-]+:[A-Za-z0-9._-]+', image) for image in [args.image, args.api_image]):
        raise SystemExit('Invalid image reference')
    config = json.loads((ROOT / 'agent.json').read_text())
    if config['base_dn'].lower() != 'dc=assay,dc=test':
        raise SystemExit('This migration only supports the isolated ASSAY.TEST deployment')
    if not config.get('helper_socket'):
        raise SystemExit('Already using in-process local operations; update the agent image with Compose instead')
    files = json.loads((ROOT / 'files.json').read_text())
    files.pop('listen', None)
    config.pop('helper_socket')
    config['files'] = files
    compose = pathlib.Path(__file__).with_name('compose.yaml').read_bytes()
    run('docker', 'image', 'inspect', args.image, args.api_image)
    if not args.apply:
        print('Ready: back up existing configuration/state, replace three Rust containers with one, and point API files to agent:8080/files. No AD bootstrap or volume deletion.')
        return
    # Refuse a switch while any recent write is pending. Never replay an uncertain write.
    probe = "const{PrismaClient}=require('@prisma/client');const d=new PrismaClient();d.sambaOperation.count({where:{state:{in:['pending','queued','running']},createdAt:{gte:new Date(Date.now()-600000)}}}).then(n=>{if(n)process.exitCode=1}).finally(()=>d.$disconnect())"
    run('docker', 'exec', 'assay-samba-test-api-1', 'node', '-e', probe)
    state = ROOT / 'agent-state/operations.sqlite'
    with sqlite3.connect(f'file:{state}?mode=ro', uri=True) as db:
        if db.execute("SELECT count(*) FROM operations WHERE state IN ('queued','running')").fetchone()[0]:
            raise SystemExit('Agent writes are still running; retry after they finish')
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d%H%M%S')
    backup = ROOT / 'backups' / ('unified-agent-' + stamp)
    backup.mkdir(parents=True, mode=0o700)
    names = ['agent.json', 'files.json', 'compose.yaml', '.env', 'DEPLOYED_SOURCE.json']
    for name in names:
        shutil.copy2(ROOT / name, backup / name)
    with sqlite3.connect(f'file:{state}?mode=ro', uri=True) as db, sqlite3.connect(backup / 'operations.sqlite') as target:
        db.backup(target)
    images = {}
    for service in ['agent', 'helper', 'file-gateway', 'api']:
        images[service] = run('docker', 'inspect', '--format', '{{.Image}}', 'assay-samba-test-' + service + '-1').stdout.decode().strip()
        run('docker', 'tag', images[service], 'assay-' + service + ':before-unified-' + stamp)
    (backup / 'images.json').write_text(json.dumps(images, indent=2))
    for path in backup.iterdir():
        path.chmod(0o600)
    baseline = {}
    for name in ['assay-samba-test-ad-1', 'samba-ad-ad-1']:
        inspected = run('docker', 'inspect', name, check=False)
        if inspected.returncode == 0:
            container = json.loads(inspected.stdout)[0]
            baseline[name] = [container['Id'], container['State']['StartedAt']]
    (backup / 'unaffected-containers.json').write_text(json.dumps(baseline))
    (backup / 'unaffected-containers.json').chmod(0o600)
    try:
        run('docker', 'stop', 'assay-samba-test-agent-1', 'assay-samba-test-helper-1', 'assay-samba-test-file-gateway-1')
        (ROOT / 'agent.json').write_text(json.dumps(config, indent=2) + '\n')
        (ROOT / 'compose.yaml').write_bytes(compose)
        env = (ROOT / '.env').read_text()
        for key, image in [('SAMBA_AGENT_IMAGE', args.image), ('ASSAY_API_IMAGE', args.api_image)]:
            setting = key + '=' + image
            env = re.sub(r'^' + key + r'=.*$', setting, env, flags=re.M) if re.search(r'^' + key + '=', env, re.M) else env.rstrip() + '\n' + setting + '\n'
        (ROOT / '.env').write_text(env)
        run('docker', 'compose', 'up', '-d', '--no-deps', 'agent', 'api')
        # nginx resolves the API service at reload; its container IP may have changed.
        run('docker', 'exec', 'assay-samba-test-web-1', 'nginx', '-s', 'reload')
        health = "Promise.all(['http://agent:8080/health','http://agent:8080/files/health','http://127.0.0.1:3000/health'].map(async u=>{const r=await fetch(u,{signal:AbortSignal.timeout(3000)});if(!r.ok)throw Error()})).catch(()=>process.exit(1))"
        for _ in range(30):
            if run('docker', 'exec', 'assay-samba-test-api-1', 'node', '-e', health, check=False).returncode == 0:
                break
            time.sleep(1)
        else:
            raise RuntimeError('Unified agent/API health check failed')
        processes = run('docker', 'top', 'assay-samba-test-agent-1', '-eo', 'pid,comm').stdout.decode().splitlines()
        if len(processes) != 2 or 'assay-samba' not in processes[1]:
            raise RuntimeError('Expected exactly one Rust process')
        for name, before in baseline.items():
            container = json.loads(run('docker', 'inspect', name).stdout)[0]
            if before != [container['Id'], container['State']['StartedAt']]:
                raise RuntimeError('AD container was unexpectedly replaced or restarted')
        run('docker', 'rm', 'assay-samba-test-helper-1', 'assay-samba-test-file-gateway-1')
        print('PASS: one Rust container/process is healthy; API uses its /files routes. Previous configuration, operation DB and image references retained at ' + str(backup))
    except BaseException:
        run('docker', 'stop', 'assay-samba-test-agent-1', check=False)
        for name in names:
            shutil.copy2(backup / name, ROOT / name)
        # The old UID 10001 service must be able to reopen any new WAL files.
        for path in (ROOT / 'agent-state').rglob('*'):
            if path.is_file() and not path.is_symlink():
                shutil.chown(path, 10001, 10001)
        run('docker', 'compose', '--profile', 'files', 'up', '-d', '--no-deps', 'helper', 'agent', 'file-gateway', 'api')
        run('docker', 'exec', 'assay-samba-test-web-1', 'nginx', '-s', 'reload')
        raise SystemExit('Upgrade failed; previous deployment configuration restored. Inspect private Docker logs and retained backup; no data volumes were removed.')


if __name__ == '__main__':
    main()
