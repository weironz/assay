import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('prepare', Path(__file__).with_name('prepare.py'))
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


class ExistingShareTests(unittest.TestCase):
    def setUp(self):
        self.text = '''# Keep the administrator's comments and unrelated options.
[scan]
path = /storage/company/common/scans
read only = no
browseable = no
valid users = @"ACME\\dept_scan" @"ACME\\Domain Admins"
admin users = @"ACME\\Domain Admins"
acl_xattr:ignore system acls = yes
hide unreadable = yes
'''

    def test_nested_hidden_share_keeps_its_storage_path_and_admission_groups(self):
        result = prepare.inventory(self.text, '/storage/company', 'ACME', 'svc_manage')
        share = result['shares'][0]
        self.assertEqual(share['path'], 'common/scans')
        self.assertEqual(share['groups'], ['dept_scan', 'Domain Admins'])
        self.assertFalse(share['browseable'])
        self.assertFalse(share['read_only'])

    def test_service_admission_changes_only_two_existing_options(self):
        result = prepare.admit_management(self.text, 'ACME\\svc_manage')
        self.assertEqual(result.replace(' "ACME\\svc_manage"', ''), self.text)
        imported = prepare.inventory(result, '/storage/company', 'ACME', 'svc_manage')
        self.assertEqual(imported['shares'][0]['groups'], ['dept_scan', 'Domain Admins'])
        with self.assertRaises(ValueError):
            prepare.admit_management(result, 'ACME\\svc_manage')

    def test_paths_and_nonexplicit_admission_cannot_be_silently_imported(self):
        for path in ['/etc', '/storage/company', '/storage/company/../private', '/storage/company/a\\b']:
            with self.assertRaises(ValueError):
                prepare.inventory(self.text.replace('/storage/company/common/scans', path), '/storage/company', 'ACME', 'svc_manage')
        for name in ['global', 'sysvol', 'netlogon', '../escape']:
            with self.assertRaises(ValueError):
                prepare.inventory(self.text.replace('[scan]', '[' + name + ']'), '/storage/company', 'ACME', 'svc_manage')
        with self.assertRaises(ValueError):
            prepare.inventory(self.text + 'include = other.conf\n', '/storage/company', 'ACME', 'svc_manage')

    def test_external_edits_change_the_manifest_digest(self):
        first = prepare.inventory(self.text, '/storage/company', 'ACME', 'svc_manage')
        second = prepare.inventory(self.text.replace('read only = no', 'read only = yes'), '/storage/company', 'ACME', 'svc_manage')
        self.assertNotEqual(first['config_sha256'], second['config_sha256'])


if __name__ == '__main__':
    unittest.main()
