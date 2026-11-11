import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1] / 'run.py'
sys.path.insert(0, str(MODULE.parent))
import deployment
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

    def test_dedicated_builder_cleanup_is_opt_in_and_retains_images(self):
        with patch.object(self.pipeline,'local_docker') as local,patch.object(self.pipeline,'version_check'),patch.object(self.pipeline,'build_flags',return_value=[]),patch.object(ci,'call',return_value='Total: 1GB') as commands:
            with patch.dict(os.environ,{'LOCAL_CI_PRUNE_BUILD_CACHE':'false'}):self.pipeline.docker_build('web')
            self.assertEqual(commands.call_count,1)
            commands.reset_mock();local.reset_mock()
            with patch.dict(os.environ,{'LOCAL_CI_PRUNE_BUILD_CACHE':'true'}):self.pipeline.docker_build('web')
            self.assertEqual(local.call_count,2)
            self.assertEqual(commands.call_args.args[0],['docker','builder','prune','--all','--force'])

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
        for key in ['DEPLOY_HOST', 'DEPLOY_USER', 'DEPLOY_DIR']:
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
        known_hosts = Path(self.directory.name) / 'known_hosts'
        known_hosts.touch()
        target = {'DEPLOY_HOST': 'example.invalid', 'DEPLOY_USER': 'deploy',
                  'DEPLOY_DIR': '/srv/assay', 'DEPLOY_OFFLINE': 'false', 'DEPLOY_KNOWN_HOSTS': str(known_hosts)}
        proof = {'version': self.pipeline.version, 'imageIds': image_ids, 'dataPreserved': True}
        for result in (None, proof):
            with self.subTest(completion=bool(result)), patch.dict(os.environ, target), patch.object(ci, 'clean_source'), \
                    patch.object(self.pipeline, 'verified_artifacts'), patch.object(self.pipeline, 'receipt', side_effect=lambda name: receipts[name]), \
                    patch.object(self.pipeline, 'mark') as mark, patch.object(deployment, 'execute', return_value=result) as execution:
                if result:
                    self.pipeline.deploy()
                    mark.assert_called_once()
                else:
                    with self.assertRaisesRegex(RuntimeError, 'completion proof'):
                        self.pipeline.deploy()
                    mark.assert_not_called()
                arguments = execution.call_args.args[0]['assay_arguments']
                self.assertEqual(arguments[0], '/srv/assay')
                self.assertEqual(arguments[-1], 'trusted-proxy')
                self.assertEqual(arguments[7:9], list(image_ids.values()))

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
            self.assertNotIn('GH_TOKEN', pipeline.env)
            with patch.object(ci, 'call', return_value='ok') as commands:
                pipeline.gh('release', 'upload', 'v1.3.12', 'fixture.bin')
            self.assertEqual(commands.call_args.kwargs['env']['GH_TOKEN'], 'github-test-secret')
            self.assertNotIn('github-test-secret', commands.call_args.args[0])
            self.assertNotIn('DOCKERHUB_TOKEN', commands.call_args.kwargs['env'])
            self.assertNotIn('GH_TOKEN', pipeline.env)

    def test_unconfigured_github_authentication_is_preserved(self):
        with patch.dict(os.environ, {'GH_TOKEN': 'inherited-auth'}):
            os.environ.pop('ASSAY_RELEASE_GITHUB_TOKEN', None)
            os.environ.pop('ASSAY_RELEASE_GH_CONFIG_DIR', None)
            self.assertEqual(ci.Pipeline().github_env()['GH_TOKEN'], 'inherited-auth')

    def test_github_credentials_must_come_from_environment(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(RuntimeError, 'Export ASSAY_RELEASE_GITHUB_TOKEN'):
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
            with patch.object(ci.subprocess, 'run', return_value=result) as commands, contextlib.redirect_stdout(output), \
                    patch.dict(os.environ, {'DOCKER_HOST': 'unix:///var/run/docker.sock', 'DOCKER_CONTEXT': ''}):
                with self.assertRaisesRegex(RuntimeError, 'Docker Hub login failed') as failure:
                    with ci.Pipeline().dockerhub_login():
                        pass
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
                    with ci.Pipeline().dockerhub_login():
                        pass
            commands.assert_not_called()

    def test_release_creates_tag_with_scoped_github_auth_and_verifies_downloads(self):
        for name in ci.ASSETS:
            (self.pipeline.dist / name).write_bytes(b'fixture')
        checksums = {name: ci.sha256(self.pipeline.dist / name) for name in ci.ASSETS}
        images = {name: {'reference': 'example/' + name, 'digest': 'sha256:' + '1' * 64,
                         'imageId': 'sha256:' + '2' * 64} for name in ci.SERVICES}
        receipts = {'verified': {}, 'push-images': {'images': images}}
        def github(*args, capture=False):
            if args[:2] == ('release', 'download'):
                destination = Path(args[args.index('--dir') + 1])
                for asset in self.pipeline.dist.iterdir():
                    shutil.copyfile(asset, destination / asset.name)
            if args[:2] == ('release', 'view'):
                return json.dumps({'url': 'https://example.test/release',
                    'assets': [{'name': path.name} for path in self.pipeline.dist.iterdir()]})
            return 'f' * 40 if '--jq' in args else ''
        with patch.object(ci, 'clean_source', return_value=ci.source()), \
                patch.object(self.pipeline, 'verified_artifacts', return_value=checksums), \
                patch.object(self.pipeline, 'receipt', side_effect=lambda name: receipts[name]), \
                patch.object(self.pipeline, 'mark') as mark, patch.object(self.pipeline, 'gh', side_effect=github) as gh, \
                patch.object(ci, 'call', return_value='') as call, \
                patch.object(ci.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, '', 'not found')), \
                patch.object(self.pipeline, 'github_env', return_value={}):
            self.pipeline.release()
        endpoints = [item.args[3] for item in gh.call_args_list if item.args[:3] == ('api', '--method', 'POST')]
        self.assertEqual(endpoints, ['repos/example/assay/git/tags', 'repos/example/assay/git/refs'])
        self.assertFalse(any('push' in item.args[0] for item in call.call_args_list))
        mark.assert_called_once_with('release', url='https://example.test/release', images=images)

    def test_auth_check_does_not_push_publish_or_deploy(self):
        with patch.object(self.pipeline, 'local_docker'), patch.object(self.pipeline, 'dockerhub_login', return_value=contextlib.nullcontext()), patch.object(self.pipeline, 'gh') as commands:
            self.pipeline.auth_check()
        self.assertEqual([call.args[:2] for call in commands.call_args_list],
                         [('api', 'user'), ('api', 'repos/example/assay')])

    def test_publish_dry_run_contains_no_production_deployment(self):
        task = shutil.which('task')
        if not task:
            self.skipTest('Task is needed for task graph validation')
        for name in ['publish', 'ci', 'check', 'build', 'release', 'auth:check',
                     'local:publish', 'local:ci', 'github:ci', 'github:publish']:
            result = subprocess.run([task, '--dry', name], cwd=ci.ROOT, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn('run.py deploy', result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
