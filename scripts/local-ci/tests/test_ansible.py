import importlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import deployment
from run import Pipeline


class DeploymentSafety(unittest.TestCase):
    def setUp(self):
        self.private = tempfile.TemporaryDirectory()
        self.addCleanup(self.private.cleanup)
        self.root = Path(self.private.name)
        self.known = self.root / 'known hosts'
        self.known.touch()
        self.env = {'DEPLOY_HOST': 'example.invalid', 'DEPLOY_USER': 'deploy',
                    'DEPLOY_DIR': '/srv/assay', 'DEPLOY_KNOWN_HOSTS': str(self.known)}

    def test_missing_or_unsafe_target_fails_before_any_connection(self):
        for change in ({'DEPLOY_HOST': ''}, {'DEPLOY_DIR': '/'}, {'DEPLOY_DIR': '/srv/../cormex'},
                       {'DEPLOY_KNOWN_HOSTS': ''}, {'DEPLOY_PORT': '65536'}, {'DEPLOY_OFFLINE': 'yes'},
                       {'DEPLOY_HOST': '-oProxyCommand=bad'}):
            with self.subTest(change=change), patch.dict(os.environ, {**self.env, **change}), \
                    patch.object(deployment.subprocess, 'run') as run:
                with self.assertRaises(RuntimeError):
                    deployment.execute({})
                run.assert_not_called()

    def test_only_ansible_receives_deploy_passwords_and_cannot_disable_host_verification(self):
        with patch.dict(os.environ, {**self.env, 'DEPLOY_PASSWORD': 'ssh-test-secret',
                'DEPLOY_BECOME_PASSWORD': 'sudo-test-secret', 'GH_TOKEN': 'github-test-secret',
                'DOCKERHUB_TOKEN': 'docker-test-secret', 'ANSIBLE_HOST_KEY_CHECKING': 'False',
                'ANSIBLE_SSH_COMMON_ARGS': '-o StrictHostKeyChecking=no'}):
            env = deployment.environment()
            self.assertEqual(env['DEPLOY_PASSWORD'], 'ssh-test-secret')
            self.assertNotIn('GH_TOKEN', env)
            self.assertNotIn('DOCKERHUB_TOKEN', env)
            self.assertEqual(env['ANSIBLE_HOST_KEY_CHECKING'], 'True')
            self.assertNotIn('StrictHostKeyChecking=no', env['ANSIBLE_SSH_COMMON_ARGS'])
            self.assertNotIn('DEPLOY_PASSWORD', Pipeline().env)

    def test_success_without_a_new_completion_file_is_not_success(self):
        with patch.dict(os.environ, self.env), patch.object(deployment, 'command', return_value=['ansible-playbook']), \
                patch.object(deployment.subprocess, 'run') as run:
            with self.assertRaisesRegex(RuntimeError, 'complete verified result'):
                deployment.execute({'assay_operation': '/srv/assay/backups/test'})
            arguments = run.call_args.args[0]
            self.assertNotIn('DEPLOY_PASSWORD', ' '.join(arguments))
            self.assertFalse(Path(arguments[-1].removeprefix('@')).exists())

    def test_docker_credentials_are_temporary_and_failure_cleans_them(self):
        original = self.root / 'docker'
        original.mkdir()
        content = json.dumps({'auths': {'original': {'auth': 'preserved'}}, 'proxies': {'default': {'httpProxy': 'http://proxy'}}})
        (original / 'config.json').write_text(content)
        with patch.dict(os.environ, {'LOCAL_CI_STATE_DIR': str(self.root / 'state'),
                'DOCKER_HOST': 'unix:///var/run/docker.sock', 'DOCKER_CONTEXT': '',
                'DOCKER_CONFIG': str(original), 'DOCKERHUB_USERNAME': 'test-account', 'DOCKERHUB_TOKEN': 'test-token'}), \
                patch('run.subprocess.run', return_value=subprocess.CompletedProcess([], 0)):
            with self.assertRaisesRegex(RuntimeError, 'fixture'):
                with Pipeline().dockerhub_login() as env:
                    location = Path(env['DOCKER_CONFIG'])
                    self.assertNotEqual(location, original)
                    config = json.loads((location / 'config.json').read_text())
                    self.assertNotIn('auths', config)
                    self.assertIn('proxies', config)
                    raise RuntimeError('fixture')
            self.assertFalse(location.exists())
            self.assertEqual((original / 'config.json').read_text(), content)

    def test_real_playbook_transfers_script_and_returns_proof_or_stops_on_failure(self):
        executable = shutil.which('ansible-playbook') or str(deployment.ROOT / '.local-ci/tools/ansible/bin/ansible-playbook')
        if not Path(executable).is_file():
            self.skipTest('Run task tools:ansible for the actual playbook integration test')
        playbook = deployment.ROOT / 'deploy/ansible/deploy.yml'
        fixture = self.root / 'repo'
        (fixture / 'scripts/local-ci').mkdir(parents=True)
        (fixture / 'deploy/ansible').mkdir(parents=True)
        shutil.copyfile(deployment.ROOT / 'deploy/ansible/ansible.cfg', fixture / 'deploy/ansible/ansible.cfg')
        inventory = self.root / 'inventory.json'
        inventory.write_text(json.dumps({'all': {'hosts': {'assay': {
            'ansible_connection': 'local', 'ansible_python_interpreter': sys.executable}}}}))
        for name in ('scripts/backup.sh', 'scripts/backup-s3.cjs', 'scripts/local-ci/db_fingerprint.py', 'scripts/local-ci/deploy_config.py'):
            (fixture / name).touch()
        for rc in (0, 7):
            operation = self.root / ('operation-' + str(rc))
            script = fixture / 'scripts/local-ci/deploy.sh'
            # A stdin-consuming child must not eat the remaining program.
            script.write_text('cat >/dev/null\nprintf \'{"fixture":true}\' > "$2/deployment-result.json"\nexit ' + str(rc) + '\n')
            values = {'assay_operation': str(operation), 'assay_arguments': [str(self.root), str(operation)] + ['fixture'] * 10,
                      'assay_mode': 'online', 'assay_bundle': '', 'assay_sums': ''}
            cmd = [executable, '-i', str(inventory), str(playbook)]
            with self.subTest(rc=rc), patch.dict(os.environ, self.env), patch.object(deployment, 'ROOT', fixture), \
                    patch.object(deployment, 'command', return_value=cmd):
                if rc:
                    with self.assertRaises(subprocess.CalledProcessError):
                        deployment.execute(values)
                else:
                    self.assertEqual(deployment.execute(values), {'fixture': True})
                self.assertEqual((operation.stat().st_mode & 0o777), 0o700)
                self.assertTrue((operation / 'ansible-deploy.log').is_file())


class ActionsSafety(unittest.TestCase):
    def test_workflow_ref_sha_and_state_must_be_explicit(self):
        check = importlib.import_module('actions_check')
        with tempfile.TemporaryDirectory() as state:
            base = {'EXPECTED_SHA': 'a' * 40, 'RELEASE_VERSION': '1.3.13',
                    'LOCAL_CI_STATE_DIR': state, 'GITHUB_REF': 'refs/heads/main'}
            for change in ({'EXPECTED_SHA': 'b' * 40}, {'LOCAL_CI_STATE_DIR': ''},
                           {'LOCAL_CI_STATE_DIR': str(check.ROOT / '.local-ci')},
                           {'GITHUB_REF': 'refs/heads/untrusted'}, {'RELEASE_VERSION': 'latest'}):
                with self.subTest(change=change), patch.dict(os.environ, {**base, **change}), \
                        patch.object(check.subprocess, 'check_output', return_value='a' * 40):
                    with self.assertRaises(RuntimeError):
                        check.check()

    def test_github_key_contents_are_private_and_removed_after_failure(self):
        adapter = importlib.import_module('actions_deploy')
        seen = []
        def fail(args, *, env, check):
            for name in ('DEPLOY_SSH_KEY', 'DEPLOY_KNOWN_HOSTS'):
                path = Path(env[name])
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                seen.append(path)
            self.assertNotIn('ASSAY_DEPLOY_PRIVATE_KEY', env)
            self.assertNotIn('test-private-key', args)
            raise subprocess.CalledProcessError(1, args)
        with patch.dict(os.environ, {'ASSAY_DEPLOY_PRIVATE_KEY': 'test-private-key',
                'ASSAY_DEPLOY_HOST_KEYS': 'test-host-key', 'RELEASE_VERSION': '1.3.13'}), \
                patch.object(adapter.subprocess, 'run', side_effect=fail):
            with self.assertRaises(subprocess.CalledProcessError):
                adapter.deploy()
        self.assertTrue(seen)
        self.assertTrue(all(not path.exists() for path in seen))

    def test_dispatch_requires_the_pushed_exact_commit_and_never_runs_local_deploy(self):
        actions = importlib.import_module('actions')
        for remote in ('b' * 40, 'a' * 40):
            with self.subTest(remote=remote), patch.dict(os.environ, {'ASSAY_ACTION': 'deploy'}), \
                    patch.object(actions, 'clean_source', return_value={'commit': 'a' * 40}), \
                    patch.object(actions.Pipeline, 'version_check'), \
                    patch.object(actions.Pipeline, 'gh', side_effect=[remote, '']) as gh:
                if remote == 'b' * 40:
                    with self.assertRaisesRegex(RuntimeError, 'Push this commit'):
                        actions.dispatch()
                    self.assertEqual(gh.call_count, 1)
                else:
                    actions.dispatch()
                    self.assertEqual(gh.call_args.args[:3], ('workflow', 'run', 'ci-cd.yml'))
                    self.assertIn('expected_sha=' + 'a' * 40, gh.call_args.args)


if __name__ == '__main__':
    unittest.main()
