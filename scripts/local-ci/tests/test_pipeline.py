import contextlib
import importlib.util
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

    def test_sandbox_cleanup_is_scoped_to_its_unique_project(self):
        with patch.object(self.pipeline, 'local_docker'), patch.object(ci, 'call') as commands:
            with self.pipeline.sandbox('api') as (_compose, _env, network):
                self.assertRegex(network, r'^assay-local-ci-api-[0-9a-f]{10}_default$')
            command = commands.call_args.args[0]
            self.assertEqual(command[command.index('-p') + 1], network.removesuffix('_default'))
            self.assertEqual(command[-3:], ['down', '--volumes', '--remove-orphans'])

    def test_unconfigured_deploy_cannot_attempt_ssh(self):
        for key in ['LOCAL_CI_DEPLOY_HOST', 'LOCAL_CI_DEPLOY_USER', 'LOCAL_CI_DEPLOY_DIR']:
            os.environ.pop(key, None)
        with patch.object(ci, 'clean_source'), patch.object(self.pipeline, 'receipt', return_value={'images': {}}), patch.object(ci, 'call') as commands:
            with self.assertRaisesRegex(RuntimeError, 'Explicit production SSH'):
                self.pipeline.deploy()
            commands.assert_not_called()

    def test_latest_and_shell_expressions_are_not_valid_versions(self):
        for value in ['latest', 'v1.3.11', '1.3.11; true', '1.3.11\nextra']:
            with patch.dict(os.environ, {'LOCAL_CI_VERSION': value}):
                with self.assertRaises(ValueError):
                    ci.Pipeline()

    def test_publish_dry_run_contains_no_production_deployment(self):
        task = shutil.which('task')
        if not task:
            self.skipTest('Task is needed for task graph validation')
        for name in ['publish', 'ci', 'build', 'release']:
            result = subprocess.run([task, '--dry', name], cwd=ci.ROOT, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn('run.py deploy', result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
