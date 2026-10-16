import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('prepare', Path(__file__).with_name('prepare.py'))
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


class ExistingShareTests(unittest.TestCase):
    def test_vpn_is_optional_and_only_adds_a_trusted_browser_origin(self):
        config = {'lan_ip': '192.0.2.10', 'https_port': 8446}
        self.assertEqual(prepare.web_origins(config), ['https://192.0.2.10:8446'])
        config['vpn_ip'] = '100.64.1.2'
        self.assertEqual(prepare.web_origins(config), ['https://192.0.2.10:8446', 'https://100.64.1.2:8446'])
        config['vpn_ip'] = config['lan_ip']
        self.assertEqual(prepare.web_origins(config), ['https://192.0.2.10:8446'])

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

    def test_directory_client_adds_only_one_fixed_address(self):
        source = '[global]\nhosts allow = LOCAL 127.0.0.0/8 192.0.2.0/24\nworkgroup = ACME\n'
        expected = source.replace('192.0.2.0/24', '192.0.2.0/24 172.29.225.10')
        self.assertEqual(prepare.allow_directory_client(source, '172.29.225.10'), expected)
        self.assertEqual(prepare.allow_directory_client(expected, '172.29.225.10'), expected)
        for address in ['0.0.0.0/0', '172.29.225.10\ninclude = /bad', 'hostname']:
            with self.assertRaises(ValueError):
                prepare.allow_directory_client(source, address)

    def test_include_bridge_keeps_the_existing_root_startup_parser_compatible(self):
        original = '/etc/samba/company.conf'
        managed = '/etc/samba/assay/custom-shares.conf'
        wrapper = '/etc/samba/assay/custom-include.conf'
        main = '[global]\nrealm = AD.EXAMPLE.COM\ninclude = ' + original + '\n[sysvol]\npath = /sysvol\n'
        modified, bridge = prepare.share_include_bridge(main, original, managed, wrapper)
        parsed = prepare.parse_samba(modified)
        self.assertEqual(parsed['global']['realm'], 'AD.EXAMPLE.COM')
        self.assertEqual(parsed['global']['include'], wrapper)
        self.assertEqual(modified.count('[global]'), 1)
        self.assertIn('include = ' + original, bridge)
        self.assertIn('include = ' + managed, bridge)

    def test_explicit_source_policy_replaces_all_and_keeps_local_and_api_access(self):
        original = '[global]\n# Keep the rest\nhosts allow = ALL\nserver signing = mandatory\n'
        result = prepare.configure_allowed_sources(original, ['192.0.2.0/24', '100.70.0.0/16'], '172.29.225.10')
        expected = 'LOCAL 127.0.0.0/8 192.0.2.0/24 100.70.0.0/16 172.29.225.10'
        self.assertEqual(result, original.replace('hosts allow = ALL', 'hosts allow = ' + expected))
        self.assertEqual(prepare.configure_allowed_sources(result, ['192.0.2.0/24', '100.70.0.0/16'], '172.29.225.10'), result)

    def test_source_policy_rejects_ambiguous_or_injected_networks(self):
        source = '[global]\nhosts allow = ALL\n'
        for networks in [[], 'ALL', ['ALL'], ['0.0.0.0/0'], ['192.0.2.1/24'], ['192.0.2.0/24\ninclude = /bad']]:
            with self.subTest(networks=networks), self.assertRaises(ValueError):
                prepare.configure_allowed_sources(source, networks, '172.29.225.10')


if __name__ == '__main__':
    unittest.main()
