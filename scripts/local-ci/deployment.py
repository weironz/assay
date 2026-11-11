#!/usr/bin/env python3
"""Ansible control node shared by local Task and GitHub Actions."""
import argparse
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
SECRETS = ('ASSAY_RELEASE_GITHUB_TOKEN', 'DOCKERHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN',
           'DEPLOY_PASSWORD', 'DEPLOY_BECOME_PASSWORD')


def target():
    host, user, directory = (os.getenv('DEPLOY_' + name, '') for name in ('HOST', 'USER', 'DIR'))
    port = os.getenv('DEPLOY_PORT', '22')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]*', host) or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_-]*', user):
        raise RuntimeError('Explicit production SSH DEPLOY_HOST and DEPLOY_USER are required')
    if (not re.fullmatch(r'/[A-Za-z0-9_./-]+', directory) or directory == '/' or
            '..' in Path(directory).parts or not port.isdigit() or not 1 <= int(port) <= 65535):
        raise RuntimeError('Set DEPLOY_DIR to the existing absolute Assay directory and DEPLOY_PORT to a valid port')
    if os.getenv('DEPLOY_OFFLINE', 'false') not in ('true', 'false'):
        raise RuntimeError('DEPLOY_OFFLINE must be true or false')
    for name in ('DEPLOY_KNOWN_HOSTS', 'DEPLOY_SSH_KEY', 'DEPLOY_SSH_CONFIG'):
        value = os.getenv(name)
        if name == 'DEPLOY_KNOWN_HOSTS' and not value:
            raise RuntimeError('DEPLOY_KNOWN_HOSTS must name a previously verified host-key file')
        if value and not Path(value).expanduser().is_file():
            raise RuntimeError(name + ' file is unavailable')
    return host, user, directory


def command(profile='default'):
    if profile not in ('default', 'samba'):
        raise RuntimeError('Unknown Ansible deployment profile')
    executable = shutil.which('ansible-playbook')
    if not executable:
        executable = str(ROOT / '.local-ci/tools/ansible/bin/ansible-playbook')
    if not Path(executable).is_file():
        raise RuntimeError('Install the Ansible control environment with task tools:ansible')
    return [executable, '-i', str(ROOT / 'deploy/ansible/inventory.yml'),
            str(ROOT / ('deploy/ansible/samba.yml' if profile == 'samba' else 'deploy/ansible/deploy.yml'))]


def environment(syntax=False):
    env = os.environ.copy()
    for name in SECRETS:
        env.pop(name, None)
    # Never inherit a caller's weakened host-key checking or alternate inventory.
    for name in list(env):
        if name.startswith('ANSIBLE_'):
            env.pop(name)
    env.update(ANSIBLE_CONFIG=str(ROOT / 'deploy/ansible/ansible.cfg'),
               ANSIBLE_HOST_KEY_CHECKING='True', ANSIBLE_NOCOLOR='1')
    if not syntax:
        for name in ('DEPLOY_PASSWORD', 'DEPLOY_BECOME_PASSWORD'):
            if os.getenv(name):
                env[name] = os.environ[name]
        args = []
        if os.getenv('DEPLOY_SSH_CONFIG'):
            args += ['-F', str(Path(os.environ['DEPLOY_SSH_CONFIG']).expanduser().resolve())]
        args += ['-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' +
                 str(Path(os.environ['DEPLOY_KNOWN_HOSTS']).expanduser().resolve())]
        env['ANSIBLE_SSH_COMMON_ARGS'] = shlex.join(args)
    return env


def execute(values, profile='default'):
    target()  # Validate before even starting Ansible or making remote changes.
    with tempfile.TemporaryDirectory(prefix='assay-ansible-') as name:
        private = Path(name)
        result = private / 'completion.json'
        parameters = private / 'operation.json'
        parameters.write_text(json.dumps({**values, 'assay_repository': str(ROOT), 'assay_result': str(result)}))
        parameters.chmod(0o600)
        invocation = command() if profile == 'default' else command(profile)
        subprocess.run([*invocation, '--extra-vars', '@' + str(parameters)], cwd=ROOT,
                       env=environment(), check=True)
        try:
            return json.loads(result.read_text())
        except (OSError, ValueError):
            raise RuntimeError('Remote deployment did not produce a complete verified result') from None


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--syntax-check', action='store_true', required=True)
    parser.add_argument('--profile', choices=['default', 'samba'], default='default')
    args = parser.parse_args()
    subprocess.run([*command(args.profile), '--syntax-check'], cwd=ROOT, env=environment(syntax=True), check=True)
