#!/usr/bin/env python3
"""Bootstrap ONLY the isolated test deployment. Not an Agent runtime dependency."""
import argparse, ipaddress, json, os, pathlib, secrets, shutil, subprocess, re
parser = argparse.ArgumentParser()
parser.add_argument('--directory', default='/data/assay-samba-test')
parser.add_argument('--lan-ip', required=True)
parser.add_argument('--vpn-ip', required=True)
args = parser.parse_args()
for ip in (args.lan_ip, args.vpn_ip): ipaddress.ip_address(ip)
root = pathlib.Path(args.directory).resolve()
if root != pathlib.Path('/data/assay-samba-test'): raise SystemExit('Only /data/assay-samba-test is allowed; never point this bootstrap at an existing AD.')
root.mkdir(mode=0o750, exist_ok=True)
if (root/'api.env').exists(): raise SystemExit('Deployment already initialized. Existing secrets and AD are preserved; use docker compose up.')
for name in ['ad-etc','ad-state','ad-run','shares','managed','agent-state','tls','secrets']:
    (root/name).mkdir(mode=0o755,exist_ok=True)
os.chmod(root/'secrets',0o700)
os.chown(root/'agent-state',10001,10001)
admin_password = 'Aa9!'+secrets.token_urlsafe(20)
ad_password = 'Aa9!'+secrets.token_urlsafe(24)
db_password = secrets.token_hex(24)
def private(name, value, owner=0):
    p=root/name; p.write_text(value+'\n'); p.chmod(0o400); os.chown(p,owner,owner)
private('secrets/agent-token',secrets.token_urlsafe(48),10001)
private('secrets/files-token',secrets.token_urlsafe(48),10001)
private('secrets/ad-password',ad_password,10001)
private('secrets/test-admin-password',admin_password)
private('database.env',f'POSTGRES_USER=assay\nPOSTGRES_DB=assay\nPOSTGRES_PASSWORD={db_password}')
private('api.env',f'''DATABASE_URL=postgresql://assay:{db_password}@postgres:5432/assay?schema=public
AUTH_SECRET={secrets.token_hex(48)}
AUTH_BASE_URL=https://{args.lan_ip}:8446
AUTH_TRUST_ORIGINS=https://{args.lan_ip}:8446,https://{args.vpn_ip}:8446
APP_URL=https://{args.lan_ip}:8446
ADMIN_EMAIL=admin@assay.test
ADMIN_PASSWORD={admin_password}
ADMIN_NAME=测试管理员
REQUIRE_EMAIL_VERIFICATION=false
PRIVILEGED_MFA_MODE=optional''')
(root/'.env').write_text(f'TEST_LAN_IP={args.lan_ip}\nTEST_VPN_IP={args.vpn_ip}\n')
(root/'.env').chmod(0o600)
config = dict(listen='0.0.0.0:8080',token_file='/secrets/agent-token',ldap_url='ldaps://172.30.225.10:636',ldap_ca_file='/tls/ca.crt',ldap_bind_dn='CN=Administrator,CN=Users,DC=assay,DC=test',ldap_password_file='/secrets/ad-password',base_dn='DC=assay,DC=test',users_dn='OU=Employees,DC=assay,DC=test',groups_dn='OU=Groups,DC=assay,DC=test',smb_server='172.30.225.10',smb_username='ASSAY\\Administrator',shares_root='/shares',config_dir='/managed',state_dir='/state',primary_gid=20000,smb_pid_file='/samba-run/smbd.pid',read_only=False)
config['files'] = dict(token_file='/secrets/files-token',smb_server='172.30.225.10',domain='ASSAY',ldap_url='ldaps://172.30.225.10:636',ldap_ca_file='/tls/ca.crt',users_dn='OU=Employees,DC=assay,DC=test')
(root/'agent.json').write_text(json.dumps(config,indent=2))
for name in ['compose.yaml','nginx.conf']:
    src=pathlib.Path(__file__).parent/name
    if src.resolve()!=(root/name).resolve(): shutil.copyfile(src,root/name)
def run(cmd):
    result=subprocess.run(cmd,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    if result.returncode:
        message=(result.stdout+result.stderr).decode(errors='replace')
        for sensitive in [ad_password,admin_password,db_password]: message=message.replace(sensitive,'[redacted]')
        raise SystemExit('Bootstrap command failed: '+message[-2500:])
tls=root/'tls'
run(['openssl','req','-x509','-newkey','rsa:3072','-nodes','-days','365','-subj','/CN=Assay Samba Test CA','-keyout',str(tls/'ca.key'),'-out',str(tls/'ca.crt')])
for name,san in [('web',f'IP:{args.lan_ip},IP:{args.vpn_ip}'),('ad','IP:172.30.225.10,DNS:ad,DNS:ad.assay.test')]:
    run(['openssl','req','-newkey','rsa:3072','-nodes','-subj',f'/CN=Assay test {name}','-keyout',str(tls/f'{name}.key'),'-out',str(tls/f'{name}.csr')])
    ext=tls/f'{name}.ext';ext.write_text(f'subjectAltName={san}\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n')
    run(['openssl','x509','-req','-in',str(tls/f'{name}.csr'),'-CA',str(tls/'ca.crt'),'-CAkey',str(tls/'ca.key'),'-CAcreateserial','-days','365','-extfile',str(ext),'-out',str(tls/f'{name}.crt')])
for p in tls.glob('*.key'): p.chmod(0o600)
image=os.environ.get('SAMBA_TEST_IMAGE','quay.io/samba.org/samba-ad-server:default-fedora-amd64')
# Official one-time domain provisioning is for a NEW disposable test domain only.
run(['docker','run','--rm','--network','none','--cap-add','SYS_ADMIN','--hostname','ad','--entrypoint','/usr/bin/samba-tool','-v',f'{root}/ad-etc:/etc/samba','-v',f'{root}/ad-state:/var/lib/samba',image,'domain','provision','--realm=ASSAY.TEST','--domain=ASSAY','--server-role=dc','--dns-backend=SAMBA_INTERNAL','--use-rfc2307','--host-ip=172.30.225.10',f'--adminpass={ad_password}'])
conf=root/'ad-etc/smb.conf'
s=conf.read_text().replace('[global]','''[global]
    pid directory = /run/samba-pids
    tls enabled = yes
    tls keyfile = /tls/ad.key
    tls certfile = /tls/ad.crt
    tls cafile = /tls/ca.crt
    server min protocol = SMB3_00
''',1)
s=re.sub(r'(\n\[(?!global\])[^]]+\])', r'    include = /managed/assay-shares.conf\n\1', s, count=1)
conf.write_text(s)
(root/'managed/assay-shares.conf').write_text('# Managed by Assay Samba Agent. Do not edit this file.\n')
# These official bootstrap commands only initialize the dedicated empty test OUs.
for unit in ['Employees','Groups']:
    run(['docker','run','--rm','--network','none','--entrypoint','/usr/bin/samba-tool','-v',f'{root}/ad-etc:/etc/samba','-v',f'{root}/ad-state:/var/lib/samba',image,'ou','create',f'OU={unit},DC=assay,DC=test'])
# Permit repeated password changes in the isolated test domain; production policy is untouched.
run(['docker','run','--rm','--network','none','--entrypoint','/usr/bin/samba-tool','-v',f'{root}/ad-etc:/etc/samba','-v',f'{root}/ad-state:/var/lib/samba',image,'domain','passwordsettings','set','--min-pwd-age=0'])
(root/'BOOTSTRAP_COMPLETE').write_text('isolated-test-domain\n')
print('Isolated deployment initialized. Admin password: /data/assay-samba-test/secrets/test-admin-password (root-readable).')
