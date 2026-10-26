"""Restore a protected production backup into disposable local services."""
import gzip
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tarfile
import urllib.request
import http.cookiejar
import re
import secrets

from db_fingerprint import capture, assert_preserved

ROOT = Path(__file__).resolve().parents[2]


def rehearse(ci):
    location = os.getenv('LOCAL_CI_UPGRADE_BACKUP_DIR')
    if not location:
        raise RuntimeError('Set LOCAL_CI_UPGRADE_BACKUP_DIR to a protected backup directory')
    backup = Path(location).resolve()
    if backup == ROOT or ROOT in backup.parents:
        raise RuntimeError('Keep production backup data outside the repository')
    source = json.loads((backup / 'source.json').read_text())
    for name, digest in source['fileSha256'].items():
        if name not in ('db.sql.gz', 'objects.tar.gz', 'objects-manifest.json'):
            raise RuntimeError('Unexpected backup checksum entry')
        if hashlib.sha256((backup / name).read_bytes()).hexdigest() != digest:
            raise RuntimeError('Production backup checksum mismatch')
    required = {'db.sql.gz', 'objects.tar.gz', 'objects-manifest.json'}
    if set(source['fileSha256']) != required or not source.get('adminEmail'):
        raise RuntimeError('Production backup source metadata is incomplete')
    proxy_names = source.get('trustedProxyContainers', [])
    if any(not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', name) for name in proxy_names):
        raise RuntimeError('Invalid source trusted proxy declaration')
    info = dict(line.split('=', 1) for line in (backup / 'backup-info.txt').read_text().splitlines() if '=' in line)
    image_info = ci.receipt('build-images')
    ci.local_docker()
    rollback = source.get('rollbackImages', {})
    for service in ('api', 'web'):
        reference = rollback.get(service)
        if not reference:
            raise RuntimeError('Supply both original runtime images for the rollback rehearsal')
        item = json.loads(subprocess.check_output(['docker', 'image', 'inspect', reference], text=True))[0]
        labels = item['Config'].get('Labels') or {}
        if item['Id'] != source[service + 'ImageId']:
            archive = backup / ('rollback-' + service + '.tar.gz')
            expected = source.get('rollbackArchiveSha256', {}).get(service)
            if (not expected or labels.get('assay.upgrade.source-image-id') != source[service + 'ImageId'] or
                    labels.get('assay.upgrade.archive-sha256') != expected or
                    hashlib.sha256(archive.read_bytes()).hexdigest() != expected):
                raise RuntimeError('Original runtime image provenance or archive checksum does not match')
    private = ci.state / 'upgrade-private'
    private.mkdir(mode=0o700, exist_ok=True)
    objects = backup / 'objects'
    if not objects.exists():
        objects.mkdir(mode=0o700)
        with tarfile.open(backup / 'objects.tar.gz') as archive:
            archive.extractall(objects, filter='data')
    with ci.sandbox('upgrade', image_info['images']) as (compose, env, _network):
        env['LOCAL_CI_UPGRADE_ADMIN_EMAIL'] = source['adminEmail']
        compose('--profile', 'smoke', 'up', '-d', '--wait', '--wait-timeout', '180', 'postgres', 'redis', 'rustfs')
        def query(statement):
            value = compose('exec', '-T', 'postgres', 'psql', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1',
                            '-U', 'ci', '-d', 'assay_ci', '-c', statement, capture=True)
            return json.loads(value)
        owner = info['postgres_user']
        if owner != 'ci':
            identifier = '"' + owner.replace('"', '""') + '"'
            compose('exec', '-T', 'postgres', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'ci', '-d', 'assay_ci', '-c', 'CREATE ROLE ' + identifier + ' NOLOGIN')
        # SQL data stays on stdin and any error output stays in a private file.
        sql = gzip.decompress((backup / 'db.sql.gz').read_bytes()).decode('utf8')
        try:
            compose('exec', '-T', 'postgres', 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', 'ci', '-d', 'assay_ci', data=sql, capture=True)
        except subprocess.CalledProcessError as error:
            log = private / 'restore-error.log'
            log.write_text(error.stderr or 'PostgreSQL restore failed')
            log.chmod(0o600)
            raise RuntimeError('Production copy restore failed; details retained only in the private upgrade log') from None
        before = capture(query)
        compose('run', '--rm', '--no-deps', 'api', './node_modules/.bin/prisma', 'migrate', 'deploy')
        migrated = capture(query, before)
        assert_preserved(before, migrated)
        rfs = compose('ps', '-q', 'rustfs', capture=True)
        result = subprocess.run(['docker', 'run', '--rm', '--pull', 'never', '--network', 'container:' + rfs,
            '--mount', f'type=bind,src={backup},dst=/source,readonly',
            '--mount', f'type=bind,src={ROOT / "scripts/local-ci/restore-upgrade-s3.cjs"},dst=/app/restore-upgrade-s3.cjs,readonly',
            '--entrypoint', 'node', image_info['images']['api'], '/app/restore-upgrade-s3.cjs'], env=env, text=True, capture_output=True)
        if result.returncode:
            raise RuntimeError('Upgrade sandbox S3 restore or checksum verification failed')
        object_result = json.loads(result.stdout)
        # A disposable login exercises the real new API without resetting an
        # existing employee's password or granting any production privileges.
        probe = 'upgrade-probe-' + secrets.token_hex(6)
        email = probe + '@assay.test'
        fixture = """const {PrismaClient}=require('@prisma/client');const {hashPassword}=require('better-auth/crypto');const p=new PrismaClient();
(async()=>{const u=await p.user.create({data:{email:EMAIL,name:'Upgrade Probe',username:USERNAME,emailVerified:true}});
await p.account.create({data:{userId:u.id,providerId:'credential',accountId:u.id,password:await hashPassword('UpgradeProbe9!localOnly')}});
const r=await p.role.findUniqueOrThrow({where:{name:'admin'}});await p.userRole.create({data:{userId:u.id,roleId:r.id}});await p.$disconnect();})().catch(e=>{console.error(e.name);process.exit(1)});"""
        fixture = fixture.replace('EMAIL', json.dumps(email)).replace('USERNAME', json.dumps(probe))
        compose('run', '--rm', '--no-deps', 'api', 'node', '-e', fixture)
        def start():
            try:
                compose('--profile', 'smoke', 'up', '-d', '--force-recreate', '--pull', 'never', '--wait', '--wait-timeout', '180', 'api', 'web', capture=True)
            except subprocess.CalledProcessError:
                log = private / ('startup-' + secrets.token_hex(3) + '.log')
                log.write_text(compose('logs', '--tail', '100', 'api', 'web', capture=True))
                log.chmod(0o600)
                raise RuntimeError('Upgrade sandbox startup failed; details retained only in the private upgrade log') from None
        start()
        after = capture(query, before)
        report = assert_preserved(before, after)
        client = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        base = env['LOCAL_CI_TEST_URL']
        def request(path, body=None, raw=False):
            data = None if body is None else json.dumps(body).encode()
            headers = {'Origin': base, 'Content-Type': 'application/json'}
            with client.open(urllib.request.Request(base + path, data=data, headers=headers), timeout=10) as response:
                content = response.read()
                return content if raw else json.loads(content)
        manifest = {item['key']: item for item in json.loads((backup / 'objects-manifest.json').read_text())}
        attachments = query("SELECT COALESCE(json_agg(json_build_object('id',id,'key',object_key)),'[]'::json) FROM ticket_attachments WHERE ticket_id IS NOT NULL")
        def exercise_runtime():
            request('/api/auth/sign-in/email', {'email': email, 'password': 'UpgradeProbe9!localOnly'})
            if 'admin' not in request('/api/me')['roles']:
                raise RuntimeError('Rehearsed administrator login or permissions failed')
            request('/api/tickets?pageSize=1')
            for attachment in attachments:
                body = request('/api/attachments/' + attachment['id'] + '/download', raw=True)
                if hashlib.sha256(body).hexdigest() != manifest[attachment['key']]['sha256']:
                    raise RuntimeError('Rehearsed attachment HTTP download checksum mismatch')
        exercise_runtime()
        # Exercise the old runtime against the migrated schema. Never restore
        # the old database over newer writes as part of an application rollback.
        compose('--profile', 'smoke', 'stop', 'web', 'api')
        env.update(LOCAL_CI_API_IMAGE=rollback['api'], LOCAL_CI_WEB_IMAGE=rollback['web'],
                   LOCAL_CI_UPGRADE_API_STARTUP='./node_modules/.bin/prisma migrate deploy && exec node dist/main.js')
        start()
        exercise_runtime()
        assert_preserved(before, capture(query, before))
        report['rollbackCompatible'] = True
        report['verifiedHttpAttachments'] = len(attachments)
        report.update(object_result)
        report['sourceImages'] = {'api': source['apiImageId'], 'web': source['webImageId']}
        report['trustedProxyContainers'] = proxy_names
        report['targetImageIds'] = image_info['imageIds']
        report['backupSha256'] = source['fileSha256']['db.sql.gz']
        ci.mark('upgrade', **report)
        print('Production copy upgrade passed; existing records preserved, objects restored and verified, administrator login and ticket access passed', flush=True)
