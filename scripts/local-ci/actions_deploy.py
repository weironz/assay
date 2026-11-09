#!/usr/bin/env python3
"""Adapt GitHub secret contents to the local path-based deploy contract."""
import os
from pathlib import Path
import subprocess
import tempfile


def deploy():
    with tempfile.TemporaryDirectory(prefix='assay-ssh-') as location:
        env = os.environ.copy()
        for secret, variable, filename in (
                ('ASSAY_DEPLOY_PRIVATE_KEY', 'DEPLOY_SSH_KEY', 'id_ed25519'),
                ('ASSAY_DEPLOY_HOST_KEYS', 'DEPLOY_KNOWN_HOSTS', 'known_hosts')):
            value = env.pop(secret, '')
            if not value:
                raise RuntimeError('Configure GitHub production secret ' + variable)
            path = Path(location) / filename
            path.write_text(value.rstrip() + '\n')
            path.chmod(0o600)
            env[variable] = str(path)
        subprocess.run(['task', 'local:deploy', 'VERSION=' + env['RELEASE_VERSION']], env=env, check=True)


if __name__ == '__main__':
    try:
        deploy()
    except RuntimeError as error:
        raise SystemExit(str(error))
