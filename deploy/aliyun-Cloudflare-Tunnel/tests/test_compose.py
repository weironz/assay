"""Render production templates without starting containers or accessing credentials."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[1]
TRAEFIK = SOURCE.parent / 'aliyun'


def render(source=SOURCE, extra='', env_source=None):
    with tempfile.TemporaryDirectory() as directory:
        target = Path(directory)
        shutil.copyfile(source / 'docker-compose.yaml', target / 'docker-compose.yaml')
        text = ((env_source or source) / '.env.example').read_text()
        text = text.replace('PUBLIC_DOMAIN=assay.example.com', 'PUBLIC_DOMAIN=primary.example.test')
        text += '\n' + extra
        (target / '.env').write_text(text)
        environment = os.environ.copy()
        keys = set(re.findall(r'^([A-Z][A-Z0-9_]*)=', text, re.M))
        keys.update({'PUBLIC_URL', 'LEGACY_PUBLIC_DOMAIN',
                     'POSTGRES_IMAGE', 'REDIS_IMAGE', 'RUSTFS_IMAGE', 'REGISTRY'})
        for key in list(environment):
            if key in keys or key.startswith(('COMPOSE_', 'CLOUDFLARED_')):
                environment.pop(key, None)
        result = subprocess.run(
            ['docker', 'compose', '--project-directory', str(target),
             '--env-file', str(target / '.env'), '-f', str(target / 'docker-compose.yaml'),
             'config', '--format', 'json'],
            env=environment, capture_output=True, text=True,
        )
        if result.returncode:
            raise AssertionError(result.stderr)
        return json.loads(result.stdout)


class TunnelDeployment(unittest.TestCase):
    def test_existing_data_services_and_volume_identities_are_preserved(self):
        extra = ('POSTGRES_IMAGE=postgres:existing\nREDIS_IMAGE=redis:existing\n'
                 'RUSTFS_IMAGE=rustfs/rustfs:existing\nIMAGE_TAG=existing\n')
        tunnel = render(extra=extra)
        direct = render(TRAEFIK, extra=extra, env_source=SOURCE)
        self.assertEqual(tunnel['name'], direct['name'])
        self.assertEqual(tunnel['volumes'], direct['volumes'])
        for service in ['postgres', 'redis', 'rustfs', 'api']:
            self.assertEqual(tunnel['services'][service], direct['services'][service])
        for logical in ['pg-data', 'redis-data', 'rustfs-data']:
            self.assertEqual(tunnel['volumes'][logical]['name'], 'assay_' + logical)
        self.assertNotIn('seed', ' '.join(tunnel['services']['api']['command']))

    def test_web_is_available_only_on_internal_and_connector_networks(self):
        config = render(extra='CLOUDFLARED_NETWORK=existing-production-network\n')
        for service in config['services'].values():
            self.assertFalse(service.get('ports'))
        self.assertEqual(config['services']['web']['labels'], {'traefik.enable': 'false'})
        self.assertEqual(set(config['services']['web']['networks']), {'internal', 'tunnel-network'})
        network = config['networks']['tunnel-network']
        self.assertTrue(network['external'])
        self.assertEqual(network['name'], 'existing-production-network')
        self.assertNotIn('traefik-network', config['networks'])

    def test_connector_names_network_dns_and_token_file_are_configurable(self):
        config = render(SOURCE / 'cloudflared', extra=(
            'CLOUDFLARED_PROJECT=alternate-connector\n'
            'CLOUDFLARED_CONTAINER_NAME=alternate-connector\n'
            'CLOUDFLARED_NETWORK=existing-production-network\n'
            'CLOUDFLARED_DNS_PRIMARY=9.9.9.9\n'
            'CLOUDFLARED_DNS_SECONDARY=8.8.8.8\n'
            'CLOUDFLARED_TOKEN_FILE=./secrets/custom-token\n'))
        self.assertEqual(config['name'], 'alternate-connector')
        connector = config['services']['cloudflared']
        self.assertEqual(connector['container_name'], 'alternate-connector')
        self.assertEqual(connector['dns'], ['9.9.9.9', '8.8.8.8'])
        self.assertFalse(connector.get('ports'))
        self.assertEqual(connector['restart'], 'unless-stopped')
        self.assertEqual(connector['command'][-2:], ['--token-file', '/run/secrets/tunnel_token'])
        self.assertNotIn('--token', connector['command'])
        self.assertEqual(config['networks']['origin']['name'], 'existing-production-network')
        self.assertTrue(config['secrets']['tunnel_token']['file'].endswith('/secrets/custom-token'))

    def test_fresh_app_and_connector_share_the_default_network(self):
        app = render()
        connector = render(SOURCE / 'cloudflared')
        self.assertEqual(app['networks']['tunnel-network']['name'],
                         connector['networks']['origin']['name'])


if __name__ == '__main__':
    unittest.main()
