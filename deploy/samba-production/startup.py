#!/usr/bin/env python3
"""Start an existing deployment after its host addresses and Samba are ready."""
import argparse
import ipaddress
import json
from pathlib import Path
import re
import subprocess
import sys
import time


def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout


def compose(project):
    return ['docker', 'compose', '--project-directory', str(project),
            '--file', str(project / 'compose.yaml'), '--env-file', str(project / '.env')]


def prerequisites(config):
    services = config['services']
    # Read rendered Compose internally; never log its environment or credentials.
    addresses = {str(ipaddress.ip_address(p['host_ip']))
                 for p in services['web']['ports'] if p.get('host_ip')}
    addresses -= {'0.0.0.0', '::'}
    pid = services['agent']['pid']
    if not pid.startswith('container:') or not pid[10:]:
        raise ValueError('Agent must reference the existing Samba container')
    return addresses, pid[10:]


def ready(addresses, samba):
    # Wildcard publication (the default) requires no interface, VPN or IP assignment.
    if addresses:
        interfaces = json.loads(run('ip', '-json', 'address', 'show'))
        assigned = {a['local'] for interface in interfaces for a in interface.get('addr_info', [])
                    if a.get('local') and not a.get('tentative') and not a.get('dadfailed')}
        if not addresses <= assigned:
            return False
    try:
        state = json.loads(run('docker', 'inspect', '--format', '{{json .State}}', samba))
    except subprocess.CalledProcessError:
        return False
    # The company AD must have a real healthcheck; don't mistake process start for readiness.
    return state.get('Running', False) and state.get('Health', {}).get('Status') == 'healthy'


def start(project, timeout):
    command = compose(project)
    config = json.loads(run(*command, 'config', '--format', 'json'))
    addresses, samba = prerequisites(config)
    deadline = time.monotonic() + timeout
    print('Waiting for configured Web addresses and existing Samba health', flush=True)
    while not ready(addresses, samba):
        if time.monotonic() >= deadline:
            raise TimeoutError('Host addresses or existing Samba are not ready; retry via systemd')
        time.sleep(2)
    # Start dependencies first. Do not restart AD or touch databases, volumes or share configs.
    dependencies = [name for name in config['services'] if name != 'web']
    run(*command, 'up', '-d', '--wait', '--wait-timeout', '90', *dependencies)
    # Docker can leave a running container without an endpoint after an early bind failure.
    # Recreating only the stateless Web container repairs that incomplete network state.
    run(*command, 'up', '-d', '--no-deps', '--force-recreate', '--wait',
        '--wait-timeout', '90', 'web')
    print('Assay startup complete; all services ready', flush=True)


def unit_text(project, script, timeout):
    def quote(value):
        # systemd specifier/environment expansion is independent of shell quoting.
        return json.dumps(str(value).replace('%', '%%').replace('$', '$$'))
    command = ' '.join(quote(x) for x in [sys.executable, script, '--project-directory', project,
                                         '--timeout', timeout])
    return f'''[Unit]
Description=Assay startup after host addresses and Samba are ready
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target
RequiresMountsFor={quote(project)} {quote(script)}
StartLimitIntervalSec=0

[Service]
Type=oneshot
ExecStart={command}
RemainAfterExit=yes
Restart=on-failure
RestartSec=15s
TimeoutStartSec={timeout + 210}s
UMask=0077

[Install]
WantedBy=multi-user.target
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project-directory', required=True, type=Path)
    parser.add_argument('--timeout', type=int, default=180)
    parser.add_argument('--install', action='store_true')
    parser.add_argument('--unit-name', default='assay-startup.service')
    args = parser.parse_args()
    if args.timeout < 1 or not re.fullmatch(r'[a-zA-Z0-9_-]+\.service', args.unit_name):
        parser.error('A positive timeout and simple .service name are required')
    project = args.project_directory.resolve(strict=True)
    if args.install:
        # Validate configuration before installing; don't print the rendered config.
        prerequisites(json.loads(run(*compose(project), 'config', '--format', 'json')))
        target = Path('/etc/systemd/system') / args.unit_name
        target.write_text(unit_text(project, Path(__file__).resolve(), args.timeout))
        target.chmod(0o644)
        run('systemctl', 'daemon-reload')
        run('systemctl', 'enable', args.unit_name)
        print('Installed ' + args.unit_name + '; start it with systemctl to validate now')
    else:
        start(project, args.timeout)


if __name__ == '__main__':
    try:
        main()
    except subprocess.CalledProcessError:
        # Docker config output can contain passwords; keep failures out of the journal.
        print('Startup command failed; inspect container status and Compose configuration privately', file=sys.stderr)
        sys.exit(1)
    except (ValueError, TimeoutError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
