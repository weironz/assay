#!/usr/bin/env python3
"""Independent SMB acceptance client; never run against a company AD."""
import json
import os
from pathlib import Path
import secrets
import subprocess
import time
import urllib.parse
import urllib.request
import uuid

import smbclient


def main():
    directory = Path(os.environ['SAMBA_NO_DELETE_TEST_DIR']).resolve()
    assert (directory / 'BOOTSTRAP_COMPLETE').read_text().strip() == 'isolated-test-domain'
    config = json.loads((directory / 'agent.json').read_text())
    assert config['base_dn'].lower() == 'dc=assay,dc=test'
    base = os.environ['SAMBA_AGENT_TEST_ORIGIN'].rstrip('/')
    url = urllib.parse.urlsplit(base)
    allowed_hosts = {'127.0.0.1', 'localhost'}
    # Some Docker-in-Docker daemons cannot publish a port on a PID-sharing
    # container. Permit its exact local test-container address, never arbitrary
    # LAN/VPN hosts; also verify the test-domain identity before any write.
    inspected = json.loads(subprocess.check_output(['docker','inspect','assay-samba-test-agent-1'],text=True))[0]
    assert str(directory / 'compose.yaml') in inspected['Config']['Labels']['com.docker.compose.project.config_files']
    allowed_hosts.update(n['IPAddress'] for n in inspected['NetworkSettings']['Networks'].values() if n.get('IPAddress'))
    assert url.scheme == 'http' and url.hostname in allowed_hosts
    token = (directory / 'secrets/agent-token').read_text().strip()
    http = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def request(path, data=None):
        payload = json.dumps(data).encode() if data is not None else None
        r = urllib.request.Request(base + path, data=payload,
            headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
        with http.open(r, timeout=30) as response:
            return json.load(response)

    assert request('/v1/snapshot')['domain'].lower() == 'dc=assay,dc=test'

    def command(action, args, success=True):
        identifier = str(uuid.uuid4())
        result = request('/v1/commands', {'request_id': identifier, 'action': action, 'args': args})
        deadline = time.monotonic() + 100
        while result['state'] in ('queued', 'running', 'pending'):
            assert time.monotonic() < deadline, 'Isolated operation timed out'
            time.sleep(.2)
            result = request('/v1/operations/' + identifier)
        if success:
            assert result['state'] == 'succeeded', result
        else:
            assert result['state'] == 'failed', result
        return result

    suffix = secrets.token_hex(4)
    staff, leader, team, share = ['qa_' + kind + '_' + suffix for kind in ('staff', 'leader', 'team', 'acl')]
    password = 'Qa9!' + secrets.token_urlsafe(24)
    for name in (staff, leader):
        command('user.create', {'name': name, 'display_name': 'ACL isolated probe', 'password': password})
    command('group.create', {'name': team, 'description': 'Isolated ACL verification'})
    snapshot = request('/v1/snapshot')
    group = next(g for g in snapshot['groups'] if g['name'] == team)
    users = {u['name']: u for u in snapshot['users'] if u['name'] in (staff, leader)}
    # A leader is ALSO a department member. A blanket department deny would
    # incorrectly lock this user out, so the real SMB test covers that case.
    command('group.members', {'group_id': group['id'], 'user_ids': [users[staff]['id'], users[leader]['id']], 'add': True})
    command('share.save', {'name': share, 'comment': 'Isolated no-delete probe', 'groups': [group['id']], 'read_only': False})

    original = (directory / 'agent.json').read_bytes()
    config['acl_admin_sids'] = [users[leader]['sid']]
    (directory / 'agent.json').write_text(json.dumps(config, indent=2) + '\n')
    # Only the dedicated test Agent is recreated; never target an arbitrary
    # production compose file, and never stop the AD during an ACL operation.
    compose = ['docker', 'compose', '--project-directory', str(directory), '-f', str(directory / 'compose.yaml')]
    override = os.environ.get('SAMBA_ACL_TEST_OVERRIDE')
    if override:
        compose += ['-f', str(Path(override).resolve())]
    subprocess.run([*compose, 'up', '-d', '--no-deps', '--force-recreate', 'agent'], check=True)
    for _ in range(100):
        try:
            request('/v1/snapshot')
            break
        except Exception:
            time.sleep(.3)
    else:
        raise RuntimeError('Isolated Agent did not become ready')

    smb_server = os.getenv('SAMBA_ACL_SMB_HOST', '127.0.0.1')
    assert smb_server in ('127.0.0.1', 'localhost')
    port = int(os.getenv('SAMBA_ACL_SMB_PORT', '1445'))
    root = '\\\\' + smb_server + '\\' + share

    def connect(name):
        smbclient.reset_connection_cache()
        smbclient.register_session(smb_server, username='ASSAY\\' + name, password=password, port=port, encrypt=True)

    def write(path, content):
        with smbclient.open_file(root + '\\' + path, mode='wb', port=port) as stream:
            stream.write(content)

    def denied(fn):
        try:
            fn()
        except Exception as error:
            assert 'STATUS_ACCESS_DENIED' in str(error) or '0xc0000022' in str(error).lower(), type(error).__name__
        else:
            raise AssertionError('Employee unexpectedly received a protected right')

    connect(staff)
    write('existing.txt', b'original probe')
    smbclient.mkdir(root + '\\existing-dir', port=port)
    write('existing-dir\\nested.txt', b'original nested probe')
    query = '/v1/acl?' + urllib.parse.urlencode({'share': share, 'path': ''})
    before = request(query)
    arguments={'share':share,'path':'','principal_id':group['id'],'group':True,
        'mode':'write_no_delete','inherit':True,'normalize_delete_permissions':True,'revision':before['revision']}
    preview=request('/v1/acl-preview',arguments)
    assert preview['ready'] and preview['writes'] is False and preview['entries']>=4
    assert request(query)['revision']==before['revision']
    result = command('acl.grant',arguments)
    assert result['result']['deleteProtection'] is True
    assert result['result']['propagatedEntries'] >= 3
    command('acl.grant',arguments,success=False)
    connect(staff)
    with smbclient.open_file(root + '\\existing.txt', mode='rb', port=port) as stream:
        assert stream.read() == b'original probe'
    write('existing.txt', b'edited probe')
    write('created-after.txt', b'new probe')
    smbclient.mkdir(root + '\\new-dir', port=port)
    write('new-dir\\new.txt', b'new nested probe')
    for name in ('existing.txt', 'created-after.txt', 'existing-dir\\nested.txt', 'new-dir\\new.txt'):
        denied(lambda name=name: smbclient.remove(root + '\\' + name, port=port))
    denied(lambda: smbclient.rename(root + '\\existing.txt', root + '\\renamed.txt', port=port))
    # Even the creator/owner must not get WRITE_DAC back implicitly.
    denied(lambda: smbclient.open_file(root + '\\created-after.txt', mode='rb', desired_access=0x40000, port=port).close())
    connect(leader)
    smbclient.open_file(root + '\\created-after.txt', mode='rb', desired_access=0x40000, port=port).close()
    for name in ('existing.txt', 'created-after.txt', 'existing-dir\\nested.txt', 'new-dir\\new.txt'):
        smbclient.remove(root + '\\' + name, port=port)
    smbclient.rmdir(root + '\\existing-dir', port=port)
    smbclient.rmdir(root + '\\new-dir', port=port)
    smbclient.reset_connection_cache()
    report = {'passed':True,'scope':'isolated ASSAY.TEST only','staffReadWrite':True,'existingAndNewDeletesDenied':True,
        'ownerWriteDacDenied':True,'renameDenied':True,'leaderAlsoDepartmentMember':True,'leaderDeletesAllowed':True,'leaderWriteDacAllowed':True,'readOnlyPreview':True,'staleRevisionRejected':True,'backupId':result['result']['backupId']}
    (directory / 'no-delete-result.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))
    # Keep evidence and the isolated config together until explicit test cleanup.
    assert original


if __name__ == '__main__':
    main()
