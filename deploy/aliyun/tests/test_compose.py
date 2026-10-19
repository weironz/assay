"""Render only: verify env-derived origins and historical production volume identities."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[1]


class AliyunDeployment(unittest.TestCase):
    def render(self, extra='', omit_domain=False):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            shutil.copyfile(SOURCE / 'docker-compose.yaml', target / 'docker-compose.yaml')
            text = (SOURCE / '.env.example').read_text()
            text = text.replace('PUBLIC_DOMAIN=assay.example.com', '' if omit_domain else 'PUBLIC_DOMAIN=primary.example.test')
            (target / '.env').write_text(text + '\n' + extra)
            env = os.environ.copy()
            # Shell values override .env; make this a controlled deployment fixture.
            for key in ['PUBLIC_DOMAIN', 'PUBLIC_URL', 'AUTH_TRUST_ORIGINS', 'LEGACY_PUBLIC_DOMAIN', 'COMPOSE_PROJECT_NAME', 'COMPOSE_FILE', 'COMPOSE_ENV_FILES', 'COMPOSE_DISABLE_ENV_FILE', 'REGISTRY', 'IMAGE_TAG', 'RUSTFS_IMAGE', 'POSTGRES_IMAGE', 'REDIS_IMAGE']:
                env.pop(key, None)
            return subprocess.run(['docker', 'compose', '--project-directory', str(target), '--env-file', str(target / '.env'), '-f', str(target / 'docker-compose.yaml'), 'config', '--format', 'json'], env=env, capture_output=True, text=True)

    def config(self, **kwargs):
        result = self.render(**kwargs)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_single_domain_derives_all_app_urls_and_trust(self):
        config = self.config(extra='PUBLIC_URL=https://stale.example.test\n')
        api = config['services']['api']['environment']
        for key in ['PUBLIC_URL', 'AUTH_BASE_URL', 'APP_URL', 'AUTH_TRUST_ORIGINS']:
            self.assertEqual(api[key], 'https://primary.example.test')
        rule = config['services']['web']['labels']['traefik.http.routers.assay.rule']
        self.assertIn('Host(`primary.example.test`)', rule)
        self.assertNotIn('example.com', rule)

    def test_old_domain_and_trust_are_explicit_environment_values(self):
        config = self.config(extra='LEGACY_PUBLIC_DOMAIN=previous.example.test\nAUTH_TRUST_ORIGINS=https://${PUBLIC_DOMAIN},https://${LEGACY_PUBLIC_DOMAIN}\n')
        self.assertEqual(config['services']['api']['environment']['AUTH_TRUST_ORIGINS'], 'https://primary.example.test,https://previous.example.test')
        self.assertIn('Host(`previous.example.test`)', config['services']['web']['labels']['traefik.http.routers.assay.rule'])

    def test_volume_identity_and_proxy_isolation_survive_directory_rename(self):
        config = self.config(extra='POSTGRES_IMAGE=postgres:fixture-existing\nREDIS_IMAGE=redis:fixture-existing\nRUSTFS_IMAGE=rustfs/rustfs:fixture-existing\n')
        self.assertEqual(config['name'], 'assay')
        for service, logical, target in [('postgres', 'pg-data', '/var/lib/postgresql/data'), ('redis', 'redis-data', '/data'), ('rustfs', 'rustfs-data', '/data')]:
            self.assertEqual(config['volumes'][logical]['name'], 'assay_' + logical)
            self.assertEqual(config['services'][service]['volumes'][0]['source'], logical)
            self.assertEqual(config['services'][service]['volumes'][0]['target'], target)
        self.assertEqual(config['services']['postgres']['image'], 'postgres:fixture-existing')
        self.assertEqual(config['services']['redis']['image'], 'redis:fixture-existing')
        self.assertEqual(config['services']['rustfs']['image'], 'rustfs/rustfs:fixture-existing')
        self.assertTrue(config['networks']['traefik-network']['external'])
        self.assertEqual(config['services']['web'].get('ports', []), [])
        self.assertNotIn('seed', ' '.join(config['services']['api']['command']))

    def test_missing_domain_stops_before_deployment(self):
        result = self.render(omit_domain=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('PUBLIC_DOMAIN', result.stderr)


if __name__ == '__main__':
    unittest.main()
