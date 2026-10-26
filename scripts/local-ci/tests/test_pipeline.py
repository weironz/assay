import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1] / 'run.py'
spec = importlib.util.spec_from_file_location('local_ci', MODULE)
ci = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ci)


class LocalCiSafety(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.environment = patch.dict(os.environ, {'LOCAL_CI_STATE_DIR': self.directory.name,
            'LOCAL_CI_VERSION': '1.3.11', 'LOCAL_CI_DOCKERHUB_NAMESPACE': 'example',
            'LOCAL_CI_GITHUB_REPOSITORY': 'example/assay'}, clear=False)
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.source = patch.object(ci, 'source', return_value={'commit': 'a' * 40, 'sourceSha256': 'b' * 64})
        self.source.start()
        self.addCleanup(self.source.stop)
        self.pipeline = ci.Pipeline()

    def test_stale_receipts_never_authorize_publication(self):
        self.pipeline.mark('verified')
        self.assertEqual(self.pipeline.receipt('verified')['commit'], 'a' * 40)
        with patch.object(ci, 'source', return_value={'commit': 'c' * 40, 'sourceSha256': 'b' * 64}):
            with self.assertRaisesRegex(RuntimeError, 'Source changed'):
                self.pipeline.receipt('verified')

    def test_asset_tampering_is_detected_before_any_registry_operation(self):
        for name in ci.ASSETS:
            (self.pipeline.dist / name).write_bytes(b'fixture')
        self.pipeline.mark('build-cli', assets={name: ci.sha256(self.pipeline.dist / name) for name in ci.ASSETS[:2]})
        self.pipeline.mark('build-images', images={}, imageIds={}, agentSha256=ci.sha256(self.pipeline.dist / ci.ASSETS[2]))
        (self.pipeline.dist / ci.ASSETS[0]).write_bytes(b'tampered')
        with patch.object(ci, 'call') as commands:
            with self.assertRaisesRegex(RuntimeError, 'assets changed'):
                self.pipeline.check_artifacts()
            commands.assert_not_called()

    def test_remote_docker_context_is_rejected_before_container_mutation(self):
        self.pipeline.env['DOCKER_HOST'] = 'ssh://production.example'
        with patch.object(ci, 'call') as commands:
            with self.assertRaisesRegex(RuntimeError, 'refuses remote Docker'):
                self.pipeline.local_docker()
            commands.assert_not_called()

    def test_context_selector_cannot_hide_a_remote_daemon_behind_local_host(self):
        self.pipeline.env.update(DOCKER_HOST='unix:///var/run/docker.sock', DOCKER_CONTEXT='production')
        with patch.object(ci, 'call', return_value='ssh://production.example') as commands:
            with self.assertRaisesRegex(RuntimeError, 'refuses remote Docker'):
                self.pipeline.local_docker()
            self.assertEqual(commands.call_count, 1)
            self.assertIn('production', commands.call_args.args[0])

    def test_rebuilt_images_cannot_reuse_an_old_verification(self):
        receipts = {'verified': {'assets': {'cli': 'same'}, 'imageIds': {'api': 'old'}},
                    'build-images': {'imageIds': {'api': 'new'}}}
        with patch.object(self.pipeline, 'receipt', side_effect=lambda name: receipts[name]), patch.object(self.pipeline, 'check_artifacts', return_value={'cli': 'same'}):
            with self.assertRaisesRegex(RuntimeError, 'changed after verification'):
                self.pipeline.verified_artifacts()

    def test_sandbox_cleanup_is_scoped_to_its_unique_project(self):
        with patch.object(self.pipeline, 'local_docker'), patch.object(ci, 'call') as commands:
            with self.pipeline.sandbox('api') as (_compose, _env, network):
                self.assertRegex(network, r'^assay-local-ci-api-[0-9a-f]{10}_default$')
            command = commands.call_args.args[0]
            self.assertEqual(command[command.index('-p') + 1], network.removesuffix('_default'))
            self.assertEqual(command[-5:], ['--profile', 'smoke', 'down', '--volumes', '--remove-orphans'])

    def test_unconfigured_deploy_cannot_attempt_ssh(self):
        for key in ['LOCAL_CI_DEPLOY_HOST', 'LOCAL_CI_DEPLOY_USER', 'LOCAL_CI_DEPLOY_DIR']:
            os.environ.pop(key, None)
        with patch.object(ci, 'clean_source'), patch.object(self.pipeline, 'verified_artifacts'), patch.object(self.pipeline, 'receipt', return_value={'images': {}}), patch.object(ci, 'call') as commands:
            with self.assertRaisesRegex(RuntimeError, 'Explicit production SSH'):
                self.pipeline.deploy()
            commands.assert_not_called()

    def test_deployment_file_survives_a_child_consuming_standard_input(self):
        script = Path(self.directory.name) / 'deploy.sh'
        marker = Path(self.directory.name) / 'completed'
        script.write_text('cat >/dev/null\nprintf complete > "$1"\n')
        subprocess.run(['bash', str(script), str(marker)], input='child input', text=True, check=True)
        self.assertEqual(marker.read_text(), 'complete')
        marker.unlink()
        subprocess.run(['bash', '-s', '--', str(marker)], input=script.read_text(), text=True, check=True)
        self.assertFalse(marker.exists(), 'streamed scripts must not be used for deployment')

    def test_ssh_success_without_remote_completion_proof_cannot_record_deployment(self):
        image_ids = {'api': 'sha256:' + '1' * 64, 'web': 'sha256:' + '2' * 64}
        images = {name: {'digest': value, 'imageId': value} for name, value in image_ids.items()}
        receipts = {'release': {}, 'push-images': {'images': images}, 'build-images': {'imageIds': image_ids},
                    'upgrade': {'preserved': True, 'rollbackCompatible': True, 'targetImageIds': image_ids,
                                'sourceImages': {'api': 'sha256:' + '3' * 64, 'web': 'sha256:' + '4' * 64},
                                'trustedProxyContainers': ['trusted-proxy']}}
        target = {'LOCAL_CI_DEPLOY_HOST': 'example.invalid', 'LOCAL_CI_DEPLOY_USER': 'deploy',
                  'LOCAL_CI_DEPLOY_DIR': '/srv/assay', 'LOCAL_CI_DEPLOY_OFFLINE': 'false'}
        proof = {'version': self.pipeline.version, 'imageIds': image_ids, 'dataPreserved': True}
        for result in ('', json.dumps(proof)):
            with self.subTest(completion=bool(result)), patch.dict(os.environ, target), patch.object(ci, 'clean_source'), \
                    patch.object(self.pipeline, 'verified_artifacts'), patch.object(self.pipeline, 'receipt', side_effect=lambda name: receipts[name]), \
                    patch.object(self.pipeline, 'mark') as mark, patch.object(ci, 'call', return_value=result) as commands:
                if result:
                    self.pipeline.deploy()
                    mark.assert_called_once()
                else:
                    with self.assertRaisesRegex(RuntimeError, 'complete verified result'):
                        self.pipeline.deploy()
                    mark.assert_not_called()
                transferred = [item.args[0] for item in commands.call_args_list if item.args[0][0] == 'scp']
                self.assertTrue(any(str(item[-2]).endswith('/deploy.sh') for item in transferred))
                execution = [item for item in commands.call_args_list
                             if item.args[0][0] == 'ssh' and '/tools/deploy.sh ' in item.args[0][-1]]
                self.assertEqual(len(execution), 1)
                self.assertNotIn('data', execution[0].kwargs)
                self.assertNotIn('bash -s', execution[0].args[0][-1])

    def test_latest_and_shell_expressions_are_not_valid_versions(self):
        for value in ['latest', 'v1.3.11', '1.3.11; true', '1.3.11\nextra']:
            with patch.dict(os.environ, {'LOCAL_CI_VERSION': value}):
                with self.assertRaises(ValueError):
                    ci.Pipeline()

    def test_managed_tokens_are_scoped_to_publication_commands(self):
        with patch.dict(os.environ, {'ASSAY_RELEASE_GITHUB_TOKEN': 'github-test-secret',
                                     'DOCKERHUB_TOKEN': 'docker-test-secret', 'GH_TOKEN': 'inherited-auth'}):
            pipeline = ci.Pipeline()
            self.assertNotIn('ASSAY_RELEASE_GITHUB_TOKEN', pipeline.env)
            self.assertNotIn('DOCKERHUB_TOKEN', pipeline.env)
            self.assertEqual(pipeline.env['GH_TOKEN'], 'inherited-auth')
            with patch.object(ci, 'call', return_value='ok') as commands:
                pipeline.gh('release', 'upload', 'v1.3.12', 'fixture.bin')
            self.assertEqual(commands.call_args.kwargs['env']['GH_TOKEN'], 'github-test-secret')
            self.assertNotIn('github-test-secret', commands.call_args.args[0])
            self.assertNotIn('DOCKERHUB_TOKEN', commands.call_args.kwargs['env'])
            self.assertEqual(pipeline.env['GH_TOKEN'], 'inherited-auth')

    def test_unconfigured_github_authentication_is_preserved(self):
        with patch.dict(os.environ, {'GH_TOKEN': 'inherited-auth'}):
            os.environ.pop('ASSAY_RELEASE_GITHUB_TOKEN', None)
            os.environ.pop('ASSAY_RELEASE_GH_CONFIG_DIR', None)
            self.assertEqual(ci.Pipeline().github_env()['GH_TOKEN'], 'inherited-auth')

    def test_explicit_local_github_login_is_scoped_to_github_commands(self):
        directory = Path(self.directory.name) / 'gh-login'
        directory.mkdir()
        (directory / 'hosts.yml').touch()
        with patch.dict(os.environ, {'ASSAY_RELEASE_GH_CONFIG_DIR': str(directory),
                                     'GH_TOKEN': 'inherited-auth', 'GITHUB_TOKEN': 'inherited-secondary'}):
            os.environ.pop('ASSAY_RELEASE_GITHUB_TOKEN', None)
            pipeline = ci.Pipeline()
            github = pipeline.github_env()
            self.assertEqual(github['GH_CONFIG_DIR'], str(directory))
            self.assertNotIn('GH_TOKEN', github)
            self.assertNotIn('GITHUB_TOKEN', github)
            self.assertEqual(pipeline.env['GH_TOKEN'], 'inherited-auth')
            self.assertEqual(pipeline.env['GITHUB_TOKEN'], 'inherited-secondary')

    def test_unavailable_local_login_never_falls_back_to_inherited_auth(self):
        with patch.dict(os.environ, {'ASSAY_RELEASE_GH_CONFIG_DIR': str(Path(self.directory.name) / 'missing')}):
            os.environ.pop('ASSAY_RELEASE_GITHUB_TOKEN', None)
            with self.assertRaisesRegex(RuntimeError, 'release GitHub login is unavailable'):
                ci.Pipeline().github_env()

    def test_managed_github_secret_takes_priority_over_local_login(self):
        with patch.dict(os.environ, {'ASSAY_RELEASE_GH_CONFIG_DIR': '/missing-local-login',
                                     'ASSAY_RELEASE_GITHUB_TOKEN': 'github-test-secret'}):
            self.assertEqual(ci.Pipeline().github_env()['GH_TOKEN'], 'github-test-secret')

    def test_docker_login_uses_stdin_and_does_not_relay_secret_output(self):
        token = 'docker-test-secret'
        with patch.dict(os.environ, {'DOCKERHUB_TOKEN': token, 'DOCKERHUB_USERNAME': 'test-account'}):
            result = subprocess.CompletedProcess([], 1, token, token)
            output = io.StringIO()
            with patch.object(ci.subprocess, 'run', return_value=result) as commands, contextlib.redirect_stdout(output):
                with self.assertRaisesRegex(RuntimeError, 'Docker Hub login failed') as failure:
                    ci.Pipeline().dockerhub_login()
            self.assertNotIn(token, str(failure.exception) + output.getvalue())
            self.assertNotIn(token, commands.call_args.args[0])
            self.assertEqual(commands.call_args.kwargs['input'], token + '\n')
            self.assertNotIn('DOCKERHUB_TOKEN', commands.call_args.kwargs['env'])
            self.assertIn('--password-stdin', commands.call_args.args[0])

    def test_docker_token_requires_explicit_login_account(self):
        with patch.dict(os.environ, {'DOCKERHUB_TOKEN': 'docker-test-secret'}):
            os.environ.pop('DOCKERHUB_USERNAME', None)
            with patch.object(ci.subprocess, 'run') as commands:
                with self.assertRaisesRegex(RuntimeError, 'DOCKERHUB_USERNAME'):
                    ci.Pipeline().dockerhub_login()
            commands.assert_not_called()

    def test_auth_check_does_not_push_publish_or_deploy(self):
        with patch.object(self.pipeline, 'local_docker'), patch.object(self.pipeline, 'dockerhub_login'), patch.object(self.pipeline, 'gh') as commands:
            self.pipeline.auth_check()
        self.assertEqual([call.args[:2] for call in commands.call_args_list],
                         [('api', 'user'), ('api', 'repos/example/assay')])

    def test_publish_dry_run_contains_no_production_deployment(self):
        task = shutil.which('task')
        if not task:
            self.skipTest('Task is needed for task graph validation')
        for name in ['publish', 'ci', 'build', 'release', 'auth:check']:
            result = subprocess.run([task, '--dry', name], cwd=ci.ROOT, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn('run.py deploy', result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
