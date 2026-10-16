import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('startup', Path(__file__).with_name('startup.py'))
startup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(startup)


class StartupTests(unittest.TestCase):
    def setUp(self):
        self.config = {'services': {'agent': {'pid': 'container:existing-ad'}, 'api': {},
                                   'web': {'ports': [{'host_ip': '192.0.2.10'},
                                                     {'host_ip': '100.64.1.2'}]}}}

    def test_all_explicit_bind_addresses_are_required(self):
        addresses, samba = startup.prerequisites(self.config)
        self.assertEqual(addresses, {'192.0.2.10', '100.64.1.2'})
        self.assertEqual(samba, 'existing-ad')
        self.config['services']['agent']['pid'] = 'host'
        with self.assertRaises(ValueError):
            startup.prerequisites(self.config)

    def test_late_vpn_address_blocks_start_without_probing_ad(self):
        interfaces = [{'addr_info': [{'local': '192.0.2.10'}]}]
        with patch.object(startup, 'run', return_value=json.dumps(interfaces)) as run:
            self.assertFalse(startup.ready({'192.0.2.10', '100.64.1.2'}, 'existing-ad'))
        self.assertEqual(run.call_count, 1)

    def test_ad_must_be_running_and_healthy(self):
        interfaces = json.dumps([{'addr_info': [{'local': '192.0.2.10'}]}])
        for state, expected in [({'Running': True}, False),
                                ({'Running': True, 'Health': {'Status': 'starting'}}, False),
                                ({'Running': True, 'Health': {'Status': 'healthy'}}, True)]:
            with self.subTest(state=state), patch.object(startup, 'run', side_effect=[interfaces, json.dumps(state)]):
                self.assertEqual(startup.ready({'192.0.2.10'}, 'existing-ad'), expected)

    def test_failed_readiness_does_not_start_or_recreate_services(self):
        with patch.object(startup, 'run', return_value=json.dumps(self.config)) as run, \
             patch.object(startup, 'ready', return_value=False), \
             patch.object(startup.time, 'monotonic', side_effect=[0, 2]):
            with self.assertRaises(TimeoutError):
                startup.start(Path('/private/assay'), 1)
        self.assertEqual(run.call_count, 1)

    def test_dependencies_precede_web_and_only_web_is_forcibly_recreated(self):
        with patch.object(startup, 'run', side_effect=[json.dumps(self.config), '', '']) as run, \
             patch.object(startup, 'ready', side_effect=[False, True]), \
             patch.object(startup.time, 'sleep'):
            startup.start(Path('/private/assay'), 10)
        commands = [list(c.args) for c in run.call_args_list]
        self.assertEqual(commands[1][-2:], ['agent', 'api'])
        self.assertNotIn('--force-recreate', commands[1])
        self.assertIn('--force-recreate', commands[2])
        self.assertEqual(commands[2][-1], 'web')
        self.assertFalse(any('restart' in c or 'down' in c for c in commands))

    def test_systemd_retries_and_escapes_configurable_paths(self):
        unit = startup.unit_text(Path('/data/Assay space%$'), '/ops/startup.py', 180)
        self.assertIn('"/data/Assay space%%$$"', unit)
        self.assertIn('Restart=on-failure', unit)
        self.assertIn('RequiresMountsFor=', unit)
        self.assertIn('StartLimitIntervalSec=0', unit)
        self.assertNotIn('ExecStop=', unit)


if __name__ == '__main__':
    unittest.main()
