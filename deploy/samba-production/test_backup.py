import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('backup', Path(__file__).with_name('backup.py'))
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


class ReflinkRecoveryTests(unittest.TestCase):
    def test_shared_data_matches_and_a_changed_copy_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source'
            target = root / 'restored'
            source.mkdir()
            (source / 'payload').write_bytes(bytes(range(256)) * 4096)
            (source / 'sparse').touch()
            with (source / 'sparse').open('wb') as stream:
                stream.seek(4 * 1024 * 1024)
                stream.write(b'end')
            copy = subprocess.run(['cp', '-a', '--reflink=always', str(source), str(target)], capture_output=True)
            if copy.returncode:
                self.skipTest('Filesystem does not support reflink')
            result = backup.verify_reflink_content(source, target)
            self.assertEqual(result['extent_verified_files'] + result['byte_verified_files'], 2)
            self.assertEqual(backup.fingerprint(source), backup.fingerprint(target))
            with (target / 'payload').open('r+b') as stream:
                stream.write(b'changed')
            with self.assertRaisesRegex(RuntimeError, 'contents differ'):
                backup.verify_reflink_content(source, target)


if __name__ == '__main__':
    unittest.main()
