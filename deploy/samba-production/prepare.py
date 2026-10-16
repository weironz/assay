#!/usr/bin/env python3
"""Prepare a fresh Assay instance against existing AD, after a verified backup.

All site addresses, paths, names and image references come from a private JSON file.
Does not start containers, reset employee passwords, move shares or initialize file ACLs.
"""
import argparse
import configparser
import hashlib
import ipaddress
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import shlex
import shutil
import subprocess

NAME = re.compile(r'^[a-z][a-z0-9_-]{1,47}$')
FILE = re.compile(r'^[A-Za-z0-9_.-]{1,128}$')


def run(*args, **kwargs):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, **kwargs).stdout


def private(path, value):
    path.write_bytes(value if isinstance(value, bytes) else value.encode())
    path.chmod(0o600)


def web_origins(config):
    origins = []
    # VPN is only an optional trusted browser origin, never a listening/startup dependency.
    for key in ['lan_ip', 'vpn_ip']:
        if config.get(key):
            address = ipaddress.ip_address(config[key])
            host = f'[{address}]' if address.version == 6 else str(address)
            origin = f'https://{host}:{config["https_port"]}'
            if origin not in origins:
                origins.append(origin)
    return origins


def parse_samba(text):
    parser = configparser.ConfigParser(interpolation=None, delimiters=('=',), strict=True)
    parser.read_string(text)
    return parser


def inventory(text, samba_root, domain, manager):
    parser = parse_samba(text)
    rows = []
    for name in parser.sections():
        if not NAME.fullmatch(name) or name in ['global', 'sysvol', 'netlogon']:
            raise ValueError('Only explicit business shares can be registered')
        section = parser[name]
        if 'include' in section or 'copy' in section:
            raise ValueError('Expand conditional share definitions before importing')
        path = PurePosixPath(section['path'])
        relative = str(path.relative_to(PurePosixPath(samba_root)))
        if relative == '.' or any(p in ['.', '..'] for p in relative.split('/')) or any(c in relative for c in '\\:\x00'):
            raise ValueError('Share path escapes the configured storage root')
        groups = []
        for principal in shlex.split(section['valid users']):
            if principal == domain + '\\' + manager:
                continue
            prefix = '@' + domain + '\\'
            if not principal.startswith(prefix) or '%' in principal:
                raise ValueError('Share admission requires explicit domain groups')
            groups.append(principal[len(prefix):])
        rows.append(dict(name=name, comment=section.get('comment', ''), groups=groups,
                         read_only=section.getboolean('read only', fallback=True), ready=True,
                         active=True, path=relative, browseable=section.getboolean('browseable', fallback=True)))
    return {'config_sha256': hashlib.sha256(text.encode()).hexdigest(), 'shares': rows}


def admit_management(text, principal):
    # Preserve every unrelated line, option and comment in the operator-owned file.
    parser = parse_samba(text)
    expected = {(name, option) for name in parser.sections() for option in ['valid users', 'admin users']}
    found = set()
    current = None
    lines = []
    for line in text.splitlines(keepends=True):
        heading = re.fullmatch(r'\s*\[([^]]+)\]\s*\n?', line)
        if heading:
            current = heading.group(1)
        option = re.match(r'^(\s*)(valid users|admin users)\s*=\s*(.*?)\s*$', line, re.I)
        if option:
            key = (current, option.group(2).lower())
            if key not in expected:
                raise ValueError('Unexpected access directive')
            found.add(key)
            if principal in shlex.split(option.group(3)):
                raise ValueError('Management identity is already admitted; reconcile explicitly')
            line = option.group(1) + option.group(2) + ' = ' + option.group(3) + ' "' + principal + '"\n'
        lines.append(line)
    if found != expected:
        raise ValueError('Every share must explicitly define valid users and admin users')
    modified = ''.join(lines)
    after = parse_samba(modified)
    for section in parser.sections():
        for option, value in parser[section].items():
            expected_value = value + ' "' + principal + '"' if option in ['valid users', 'admin users'] else value
            if after[section][option] != expected_value:
                raise ValueError('Unrelated Samba option changed')
    return modified


def allow_directory_client(text, address):
    address = str(ipaddress.IPv4Address(address))
    matches = list(re.finditer(r'^(\s*hosts allow\s*=\s*)([^\r\n]*)$', text, re.M | re.I))
    if len(matches) != 1:
        raise ValueError('Expected one explicit Samba hosts allow directive')
    match = matches[0]
    if address in match.group(2).split():
        return text
    return text[:match.end(2)] + ' ' + address + text[match.end(2):]


def configure_allowed_sources(text, networks, directory_address):
    """Replace the source policy only when the operator explicitly supplies CIDRs."""
    if not isinstance(networks, list) or not networks:
        raise ValueError('samba_allowed_networks must be a nonempty list of IPv4 CIDRs')
    allowed = ['LOCAL', '127.0.0.0/8']
    for value in networks:
        if not isinstance(value, str) or '/' not in value:
            raise ValueError('Samba allowed networks must be explicit IPv4 CIDRs')
        network = ipaddress.IPv4Network(value, strict=True)
        if network.prefixlen == 0:
            raise ValueError('Use explicit company/VPN networks instead of all sources')
        if str(network) not in allowed:
            allowed.append(str(network))
    address = str(ipaddress.IPv4Address(directory_address))
    if not any(ipaddress.IPv4Address(address) in ipaddress.IPv4Network(value)
               for value in allowed if value != 'LOCAL'):
        allowed.append(address)
    matches = list(re.finditer(r'^(\s*hosts allow\s*=\s*)([^\r\n]*)$', text, re.M | re.I))
    if len(matches) != 1:
        raise ValueError('Expected one explicit Samba hosts allow directive')
    match = matches[0]
    return text[:match.start(2)] + ' '.join(allowed) + text[match.end(2):]


def share_include_bridge(main, original, managed, wrapper):
    if main.count('include = ' + original) != 1:
        raise ValueError('Expected one explicit company share include')
    modified = main.replace('include = ' + original, 'include = ' + wrapper)
    # Existing entrypoints may parse the root file using strict configparser.
    parser = configparser.ConfigParser(interpolation=None, delimiters=('=',))
    parser.read_string(modified)
    return modified, 'include = ' + original + '\n[global]\ninclude = ' + managed + '\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--apply', action='store_true', help='Create service identities and write reviewed configuration')
    args = parser.parse_args()
    c = json.loads(args.config.read_text())
    root = Path(c['destination']).resolve()
    ad = Path(c['ad_data_dir']).resolve(strict=True)
    proof = Path(c['verified_backup']) / 'RESTORE_VERIFIED.json'
    if not proof.is_file() or not json.loads(proof.read_text()).get('ad_dbcheck'):
        raise ValueError('A successful isolated restore verification is required')
    backup_config = json.loads((proof.parent / 'backup-config.json').read_text())
    if backup_config['ad_container'] != c['ad_container'] or ad != Path(backup_config['trees'][backup_config['ad_tree']]).resolve():
        raise ValueError('Restore proof belongs to another AD deployment')
    if root.exists():
        raise ValueError('Fresh deployment destination must not exist')
    if root == ad or root in ad.parents or ad in root.parents:
        raise ValueError('Assay and AD deployment roots must be separate')
    for name in ['management_account', 'directory_account', 'project', 'managed_subdirectory']:
        if not NAME.fullmatch(c[name]):
            raise ValueError('Invalid account, project or managed directory name')
    for name in ['smb_config_name', 'share_config_name', 'managed_config_name', 'managed_registry_name', 'managed_include_name']:
        if not FILE.fullmatch(c[name]) or c[name] in ['.', '..']:
            raise ValueError('Invalid configuration filename')
    if len({c['managed_config_name'], c['managed_registry_name'], c['managed_include_name']}) != 3:
        raise ValueError('Managed configuration, registry and include filenames must differ')
    for name in ['lan_ip', 'api_directory_ip', 'agent_directory_ip', 'agent_bind_ip']:
        ipaddress.ip_address(c[name])
    ipaddress.ip_address(c.get('web_bind_ip', '0.0.0.0'))
    if c.get('vpn_ip'):
        ipaddress.ip_address(c['vpn_ip'])
    subnet = ipaddress.ip_network(c['management_subnet'])
    if ipaddress.ip_address(c['agent_bind_ip']) not in subnet or not subnet.is_private:
        raise ValueError('Agent must bind to the configured private management bridge gateway')
    application = ipaddress.ip_network(c['application_subnet'])
    client_ip = ipaddress.ip_address(c['api_directory_source_ip'])
    if not application.is_private or application.overlaps(subnet) or client_ip not in application or client_ip in [application.network_address, application.broadcast_address]:
        raise ValueError('Dedicated directory client must be inside a separate private application subnet')
    if not re.fullmatch(r'[A-Za-z0-9.-]+', c['directory_host']):
        raise ValueError('Invalid certificate DNS name')
    for name in ['https_port', 'agent_port']:
        if not isinstance(c[name], int) or not 1024 <= c[name] <= 65535:
            raise ValueError('Invalid service port')
    for image in c['images'].values():
        if not re.fullmatch(r'[A-Za-z0-9./_-]+@sha256:[a-f0-9]{64}', image):
            raise ValueError('Production images must be pinned by digest')
    etc = ad / c['ad_etc_relative']
    main_config = etc / c['smb_config_name']
    source = etc / c['share_config_name']
    main_text = main_config.read_text()
    main_parser = configparser.ConfigParser(interpolation=None, delimiters=('=',), strict=False)
    main_parser.read_string(main_text)
    domain = main_parser['global']['realm'].lower()
    netbios = main_parser['global']['workgroup']
    if domain != c['expected_domain'].lower():
        raise ValueError('Existing Samba realm differs from deployment configuration')
    base_dn = ','.join('DC=' + part for part in domain.split('.'))
    for dn in [c['users_dn'], c['groups_dn'], c['services_dn']]:
        if not dn.lower().startswith('ou=') or not dn.lower().endswith(',' + base_dn.lower()):
            raise ValueError('Explicit OUs inside the production domain are required')
    shares = inventory(source.read_text(), c['samba_shares_root'], netbios, c['management_account'])
    original_include = '/etc/samba/' + c['share_config_name']
    # The existing domain is never re-provisioned, re-created or restarted.
    if main_text.count('include = ' + original_include) != 1:
        raise ValueError('Expected one explicit company share include; review nonstandard configuration manually')
    modified_source = admit_management(source.read_text(), netbios + '\\' + c['management_account'])
    inventory(modified_source, c['samba_shares_root'], netbios, c['management_account'])
    include = '/etc/samba/' + c['managed_subdirectory'] + '/' + c['managed_config_name']
    wrapper = '/etc/samba/' + c['managed_subdirectory'] + '/' + c['managed_include_name']
    modified_main, bridge = share_include_bridge(main_text, original_include, include, wrapper)
    modified_main = allow_directory_client(modified_main, c['api_directory_source_ip'])
    if 'samba_allowed_networks' in c:
        modified_main = configure_allowed_sources(modified_main, c['samba_allowed_networks'], c['api_directory_source_ip'])
    if not args.apply:
        print(json.dumps({'ready': True, 'domain': domain, 'shares': len(shares['shares']),
                          'destination': str(root), 'fresh_database': True}))
        return
    root.mkdir(parents=True, mode=0o750)
    for name in ['secrets', 'tls', 'agent-state', 'rollback']:
        (root / name).mkdir(mode=0o700)
    private(root / 'deployment-input.json', json.dumps(c, indent=2))
    shutil.copyfile(main_config, root / 'rollback' / 'smb.conf')
    shutil.copyfile(source, root / 'rollback' / 'company-shares.conf')
    management_password = 'Aa9!' + secrets.token_urlsafe(40)
    directory_password = 'Aa9!' + secrets.token_urlsafe(40)
    for name, value in [('agent-token', secrets.token_urlsafe(48)), ('files-token', secrets.token_urlsafe(48)),
                        ('management-password', management_password), ('directory-password', directory_password)]:
        private(root / 'secrets' / name, value + '\n')
    for name, source_path in [('web.crt', c['web_cert_source']), ('web.key', c['web_key_source']),
                              ('directory-ca.crt', str(ad / c['directory_ca_relative']))]:
        private(root / 'tls' / name, Path(source_path).read_bytes())
    password = Path(c['local_admin_password_file']).read_text().rstrip('\r\n')
    if any('\n' in value or '\r' in value for value in [password, c['admin_email'], c['admin_name']]):
        raise ValueError('Invalid local administrator configuration')
    db_password = secrets.token_hex(32)
    origins = web_origins(c)
    private(root / 'database.env', f'POSTGRES_USER=assay\nPOSTGRES_DB=assay\nPOSTGRES_PASSWORD={db_password}\n')
    private(root / 'api.env', '\n'.join([
        f'DATABASE_URL=postgresql://assay:{db_password}@postgres:5432/assay?schema=public',
        'AUTH_SECRET=' + secrets.token_hex(48), 'AUTH_BASE_URL=' + origins[0], 'APP_URL=' + origins[0],
        'AUTH_TRUST_ORIGINS=' + ','.join(origins), 'ADMIN_EMAIL=' + c['admin_email'],
        'ADMIN_PASSWORD=' + password, 'ADMIN_NAME=' + c['admin_name'],
        'AUTH_ALLOW_REGISTRATION=false', 'REQUIRE_EMAIL_VERIFICATION=false', 'PRIVILEGED_MFA_MODE=optional',
        'DIRECTORY_AUTH_ENABLED=true', 'DIRECTORY_AUTO_PROVISION=true', 'DIRECTORY_DISPLAY_NAME=公司账号',
        'DIRECTORY_LDAP_URL=ldaps://' + c['directory_host'] + ':636', 'DIRECTORY_DOMAIN=' + domain,
        'DIRECTORY_NETBIOS_DOMAIN=' + netbios, 'DIRECTORY_BASE_DN=' + base_dn,
        'DIRECTORY_BIND_DN=CN=' + c['directory_account'] + ',' + c['services_dn'],
    ]) + '\n')
    managed = etc / c['managed_subdirectory']
    managed.mkdir(mode=0o755)
    header = '# Managed by Assay Samba Agent. Do not edit this file.\n'
    if any(managed.iterdir()):
        raise ValueError('Managed configuration directory must be empty')
    private(managed / c['managed_config_name'], header)
    private(managed / c['managed_include_name'], bridge)
    agent = dict(listen=f'{c["agent_bind_ip"]}:{c["agent_port"]}', token_file='/secrets/agent-token',
                 ldap_url='ldaps://' + c['directory_host'] + ':636', ldap_ca_file='/tls/directory-ca.crt',
                 ldap_bind_dn='CN=' + c['management_account'] + ',' + c['services_dn'],
                 ldap_password_file='/secrets/management-password', base_dn=base_dn,
                 users_dn=c['users_dn'], groups_dn=c['groups_dn'], group_prefix=c.get('group_prefix', ''),
                 smb_server=c['smb_server'], smb_username=netbios + '\\' + c['management_account'],
                 shares_root='/shares', config_dir='/managed', state_dir='/state', primary_gid=c['primary_gid'],
                 smb_pid_file='/unused/smbd.pid', reload_via_proc=True, read_only=False,
                 shares_file_name=c['managed_registry_name'], samba_config_file_name=c['managed_config_name'],
                 samba_shares_root=c['samba_shares_root'], external_shares_file='/config/external-shares.json',
                 external_samba_config_file='/existing/' + c['share_config_name'])
    agent['files'] = dict(token_file='/secrets/files-token', smb_server=c['smb_server'], domain=netbios,
                          ldap_url=agent['ldap_url'], ldap_ca_file=agent['ldap_ca_file'], users_dn=c['users_dn'],
                          max_file_bytes=c.get('max_file_bytes', 200 * 1024 * 1024))
    private(root / 'agent.json', json.dumps(agent, indent=2))
    env = dict(ASSAY_PROJECT=c['project'], SAMBA_CONTAINER=c['ad_container'], DIRECTORY_HOST=c['directory_host'],
               AGENT_DIRECTORY_IP=c['agent_directory_ip'], API_DIRECTORY_IP=c['api_directory_ip'],
               AGENT_BIND_IP=c['agent_bind_ip'], AGENT_PORT=c['agent_port'], WEB_BIND_IP=c.get('web_bind_ip', '0.0.0.0'),
               APPLICATION_SUBNET=c['application_subnet'], API_DIRECTORY_SOURCE_IP=c['api_directory_source_ip'],
               WEB_HTTPS_PORT=c['https_port'], MANAGEMENT_SUBNET=c['management_subnet'],
               SAMBA_ETC_DIR=str(etc), SAMBA_SHARES_DIR=str(ad / c['shares_relative']), MANAGED_CONFIG_DIR=str(managed),
               ASSAY_API_IMAGE=c['images']['api'], ASSAY_WEB_IMAGE=c['images']['web'], ASSAY_AGENT_IMAGE=c['images']['agent'])
    if any('\n' in str(value) or '$' in str(value) or '#' in str(value) for value in env.values()):
        raise ValueError('Unsupported Compose parameter characters')
    private(root / '.env', '\n'.join(key + '=' + str(value) for key, value in env.items()) + '\n')
    shutil.copyfile(Path(__file__).with_name('compose.yaml'), root / 'compose.yaml')
    shutil.copyfile(Path(__file__).with_name('nginx.conf'), root / 'nginx.conf')
    run('docker', 'compose', '--project-directory', str(root), 'config', '--quiet')
    candidate = root / 'rollback' / 'candidate-etc'
    shutil.copytree(etc, candidate)
    (candidate / c['smb_config_name']).write_text(modified_main)
    (candidate / c['share_config_name']).write_text(modified_source)
    ad_image = json.loads(run('docker', 'inspect', c['ad_container']))[0]['Image']
    # Parse the complete candidate before the first directory or production config write.
    output = run('docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'testparm',
                 '--mount', f'type=bind,src={candidate},dst=/etc/samba,readonly',
                 ad_image, '--suppress-prompt', '-s')
    effective = parse_samba(output.decode())
    for share in shares['shares']:
        if effective[share['name']]['path'] != c['samba_shares_root'].rstrip('/') + '/' + share['path']:
            raise ValueError('Candidate changed an existing share path')
    private(root / 'rollback' / 'candidate-testparm.conf', output)
    accounts = [dict(name=c['management_account'], password=management_password, management=True),
                dict(name=c['directory_account'], password=directory_password, management=False)]
    operation = dict(smb_conf='/etc/samba/' + c['smb_config_name'], base_dn=base_dn,
                     services_dn=c['services_dn'], managed_ous=[c['users_dn'], c['groups_dn']], accounts=accounts)
    output = run('docker', 'exec', '-i', c['ad_container'], 'python3', '-c',
                 Path(__file__).with_name('configure-ad.py').read_text(), input=json.dumps(operation).encode())
    private(root / 'rollback' / 'directory-changes.json', output)
    # Only service admission is appended to the existing shares. File ACLs are untouched.
    source.write_text(modified_source)
    private(root / 'external-shares.json', json.dumps(inventory(modified_source, c['samba_shares_root'], netbios, c['management_account']), indent=2))
    main_config.write_text(modified_main)
    run('docker', 'exec', c['ad_container'], 'testparm', '--suppress-prompt', '-s')
    run('docker', 'exec', c['ad_container'], 'smbcontrol', 'all', 'reload-config')
    private(root / 'PREPARED.json', json.dumps({'domain': domain, 'shares': len(shares['shares']), 'fresh_database': True}))
    print(json.dumps({'prepared': True, 'domain': domain, 'shares': len(shares['shares']), 'destination': str(root)}))


if __name__ == '__main__':
    main()
