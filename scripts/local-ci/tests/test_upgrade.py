"""Guards that must stop an upgrade before it loses existing data or config."""
import copy
import importlib.util
from pathlib import Path
import unittest


def module(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).resolve().parents[1] / (name + '.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


db = module('db_fingerprint')
config = module('deploy_config')


class Preservation(unittest.TestCase):
    def setUp(self):
        self.before = {'tables': {'tickets': {'count': 2, 'rows': ['a', 'a']},
                                  'accounts': {'count': 1, 'rows': ['password-hash-row']}},
                       'attachmentBindings': {'attachment': {'ticket': 'ticket', 'message': None}}}

    def test_allows_added_records_and_empty_association_backfill(self):
        after = copy.deepcopy(self.before)
        after['tables']['tickets'] = {'count': 3, 'rows': ['a', 'a', 'new']}
        after['attachmentBindings']['attachment']['message'] = 'message'
        self.assertTrue(db.assert_preserved(self.before, after)['preserved'])

    def test_missing_duplicate_record_is_not_hidden_by_set_comparison(self):
        after = copy.deepcopy(self.before)
        after['tables']['tickets'] = {'count': 1, 'rows': ['a']}
        with self.assertRaisesRegex(RuntimeError, 'tickets'):
            db.assert_preserved(self.before, after)

    def test_password_change_missing_table_and_attachment_reassignment_fail(self):
        for change in ('password', 'table', 'binding', 'attachment'):
            after = copy.deepcopy(self.before)
            if change == 'password':
                after['tables']['accounts']['rows'] = ['changed-password']
            elif change == 'table':
                del after['tables']['tickets']
            elif change == 'binding':
                after['attachmentBindings']['attachment']['ticket'] = 'another-ticket'
            else:
                after['attachmentBindings'].clear()
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                db.assert_preserved(self.before, after)

    def test_new_columns_are_not_mistaken_for_changed_old_data(self):
        statements = []
        def query(sql):
            statements.append(sql)
            if 'pg_tables' in sql:
                return ['tickets']
            if 'information_schema.columns' in sql:
                return ['id', 'title', 'new_nullable_column']
            return {'count': 1, 'rows': ['unchanged']}
        baseline = {'tables': {'tickets': {'columns': ['id', 'title']}}}
        result = db.capture(query, baseline)
        self.assertEqual(result['tables']['tickets']['columns'], ['id', 'title'])
        self.assertNotIn('new_nullable_column', statements[-1])
        baseline['tables']['tickets']['columns'].append('removed_column')
        with self.assertRaisesRegex(RuntimeError, 'columns missing'):
            db.capture(query, baseline)


class Configuration(unittest.TestCase):
    def setUp(self):
        self.before = {'services': {'api': {'image': 'old-api', 'environment': {'AUTH_SECRET': 'fixture-secret', 'IMAGE_TAG': 'old'}},
                                   'web': {'image': 'old-web'},
                                   'postgres': {'image': 'postgres:16', 'volumes': ['original-volume:/data']}},
                       'networks': {'default': {'name': 'original-network'}}}

    def test_only_image_and_explicit_upgrade_settings_are_exempt(self):
        after = copy.deepcopy(self.before)
        after['services']['api']['image'] = 'new-api'
        after['services']['api']['environment'].update(IMAGE_TAG='new', ATTACHMENT_DRAFT_CLEANUP_ENABLED='false')
        after['services']['web'].update(image='new-web', environment={'ASSAY_TRUSTED_PROXY_IPS': '172.19.0.6'})
        self.assertEqual(config.canonical(self.before), config.canonical(after))
        for change in ('secret', 'volume', 'network'):
            tampered = copy.deepcopy(after)
            if change == 'secret':
                tampered['services']['api']['environment']['AUTH_SECRET'] = 'changed'
            elif change == 'volume':
                tampered['services']['postgres']['volumes'] = ['new-volume:/data']
            else:
                tampered['networks']['default']['name'] = 'new-network'
            self.assertNotEqual(config.canonical(self.before), config.canonical(tampered))

    def test_env_keeps_credentials_comments_and_domain_verbatim(self):
        text = '# deployment\nAUTH_SECRET="fixture # secret"\nPUBLIC_URL=https://example.test\nIMAGE_TAG=old\n'
        after = config.update_env(text, {'IMAGE_TAG': 'new', 'ASSAY_TRUSTED_PROXY_IPS': '172.19.0.6'})
        self.assertIn('AUTH_SECRET="fixture # secret"\nPUBLIC_URL=https://example.test\n', after)
        self.assertIn('IMAGE_TAG=new\n', after)
        with self.assertRaisesRegex(RuntimeError, 'Duplicate'):
            config.update_env(text + 'IMAGE_TAG=ambiguous\n', {'IMAGE_TAG': 'new'})

    def test_seed_or_enabled_draft_cleanup_cannot_pass_runtime_preflight(self):
        candidate = copy.deepcopy(self.before)
        api = candidate['services']['api']
        api['command'] = ['sh', '-c', './node_modules/.bin/prisma migrate deploy && exec node dist/main.js']
        api['environment']['ATTACHMENT_DRAFT_CLEANUP_ENABLED'] = 'false'
        config.assert_safe_runtime(candidate)
        api['environment']['ATTACHMENT_DRAFT_CLEANUP_ENABLED'] = 'true'
        with self.assertRaisesRegex(RuntimeError, 'cleanup'):
            config.assert_safe_runtime(candidate)
        api['environment']['ATTACHMENT_DRAFT_CLEANUP_ENABLED'] = 'false'
        api['command'] = 'node dist/seed.js && node dist/main.js'
        with self.assertRaisesRegex(RuntimeError, 'no-seed'):
            config.assert_safe_runtime(candidate)

    def test_web_patch_keeps_other_services_and_rejects_ambiguous_environment(self):
        text = 'services:\n  web:\n    image: web\n    environment:\n      KEEP: original\n    networks: [private]\n  postgres:\n    image: postgres\n'
        after = config.web_proxy_setting(text)
        self.assertIn('      KEEP: original\n    networks: [private]\n  postgres:\n    image: postgres\n', after)
        self.assertEqual(config.web_proxy_setting(after), after)
        for environment in ('    environment: {KEEP: original}\n', '    environment:\n      - KEEP=original\n'):
            with self.assertRaisesRegex(RuntimeError, 'mapping'):
                config.web_proxy_setting('services:\n  web:\n' + environment)

    def test_legacy_api_without_env_file_receives_explicit_cleanup_flag(self):
        text = 'services:\n  api:\n    environment:\n      AUTH_SECRET: ${AUTH_SECRET}\n  web:\n    image: web\n'
        after = config.environment_setting(text, 'api', 'ATTACHMENT_DRAFT_CLEANUP_ENABLED', '${ATTACHMENT_DRAFT_CLEANUP_ENABLED:-false}')
        self.assertIn('      ATTACHMENT_DRAFT_CLEANUP_ENABLED: ${ATTACHMENT_DRAFT_CLEANUP_ENABLED:-false}\n', after)
        self.assertIn('      AUTH_SECRET: ${AUTH_SECRET}\n  web:\n    image: web\n', after)


if __name__ == '__main__':
    unittest.main()
