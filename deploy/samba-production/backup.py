#!/usr/bin/env python3
"""Host-side backup and isolated recovery verification; no AD provisioning or volume removal."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import sqlite3
import stat
import subprocess
import time


def run(*args, **kwargs):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, **kwargs).stdout


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')
    path.chmod(0o600)


def inspect(name):
    return json.loads(run('docker', 'inspect', name))[0]


def clone(source, target):
    # Fail rather than silently turn a short, frozen snapshot into a long file copy.
    run('cp', '-a', '--reflink=always', '--', str(source), str(target))


def fingerprint(root, content=False):
    """Names, metadata, ACLs/xattrs and optional contents, without recording file names."""
    digest = hashlib.sha256()
    counts = {'files': 0, 'directories': 0, 'bytes': 0}
    def visit(path):
        relative = os.fsencode(path.relative_to(root))
        metadata = path.lstat()
        fields = [relative, str(stat.S_IMODE(metadata.st_mode)).encode(),
                  str(metadata.st_uid).encode(), str(metadata.st_gid).encode(),
                  str(metadata.st_mtime_ns).encode()]
        if stat.S_ISLNK(metadata.st_mode):
            fields += [b'symlink', os.fsencode(os.readlink(path))]
        elif stat.S_ISDIR(metadata.st_mode):
            fields += [b'directory']
            counts['directories'] += 1
        elif stat.S_ISREG(metadata.st_mode):
            fields += [b'file', str(metadata.st_size).encode()]
            counts['files'] += 1
            counts['bytes'] += metadata.st_size
            if content:
                file_hash = hashlib.sha256()
                with path.open('rb') as stream:
                    for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b''):
                        file_hash.update(chunk)
                fields.append(file_hash.digest())
        else:
            fields += [b'special', str(metadata.st_rdev).encode()]
        for name in sorted(os.listxattr(path, follow_symlinks=False)):
            fields += [os.fsencode(name), os.getxattr(path, name, follow_symlinks=False)]
        for field in fields:
            digest.update(len(field).to_bytes(8, 'big'))
            digest.update(field)
        if stat.S_ISDIR(metadata.st_mode):
            for child in sorted(path.iterdir(), key=lambda p: os.fsencode(p.name)):
                visit(child)
    visit(root)
    return {**counts, 'sha256': digest.hexdigest()}


def database_fingerprints(container, username, database):
    query = r"""SELECT format(
      'SELECT json_build_object(''table'', %L, ''count'', count(*), ''hash'', md5(COALESCE(string_agg(row_to_json(t)::text, chr(10) ORDER BY row_to_json(t)::text), ''''))) FROM %I.%I t;',
      tablename, schemaname, tablename)
      FROM pg_tables WHERE schemaname='public' ORDER BY tablename
\gexec
"""
    output = run('docker', 'exec', '-i', container, 'psql', '-X', '-qAt',
                 '-v', 'ON_ERROR_STOP=1', '-U', username, '-d', database, input=query.encode())
    return [json.loads(line) for line in output.splitlines() if line]


def backup(config, destination):
    if destination.exists():
        raise ValueError('Backup destination already exists')
    for source in config['trees'].values():
        path = Path(source).resolve(strict=True)
        if destination == path or path in destination.parents or destination in path.parents:
            raise ValueError('Backup and source directories must not overlap')
    destination.mkdir(parents=True, mode=0o700)
    metadata = {name: inspect(name) for name in config['containers']}
    write_json(destination / 'containers.json', metadata)
    write_json(destination / 'backup-config.json', config)
    stopped = []
    paused = []
    try:
        for name in config['stop_for_backup']:
            if inspect(name)['State']['Running']:
                run('docker', 'stop', '-t', '45', name)
                stopped.append(name)
        # PostgreSQL stays live; pg_dump supplies its consistent transaction snapshot.
        with (destination / 'assay.pgdump').open('xb') as dump:
            subprocess.run(['docker', 'exec', config['postgres_container'], 'sh', '-c',
                            'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc'],
                           check=True, stdout=dump, stderr=subprocess.PIPE)
        (destination / 'assay.pgdump').chmod(0o600)
        write_json(destination / 'database-fingerprints.json', database_fingerprints(
            config['postgres_container'], config['postgres_user'], config['postgres_database']))
        os.sync()
        for name in config['pause_for_snapshot']:
            run('docker', 'pause', name)
            paused.append(name)
        start = time.monotonic()
        for label, source in config['trees'].items():
            clone(Path(source), destination / label)
        write_json(destination / 'snapshot.json', {'frozen_seconds': round(time.monotonic() - start, 2)})
    finally:
        for name in reversed(paused):
            run('docker', 'unpause', name)
        for name in stopped:
            run('docker', 'start', name)
    # Fingerprint the frozen copy; never claim a live, concurrently edited source is identical.
    trees = {label: fingerprint(destination / label) for label in config['trees']}
    write_json(destination / 'tree-fingerprints.json', trees)
    write_json(destination / 'BACKUP_COMPLETE.json', {'completed_at': time.time(), 'trees': trees,
               'database_sha256': hashlib.file_digest((destination / 'assay.pgdump').open('rb'), 'sha256').hexdigest()})
    print(json.dumps({'backup': str(destination), 'complete': True,
                      'frozen_seconds': json.loads((destination / 'snapshot.json').read_text())['frozen_seconds']}), flush=True)


def verify(config, destination):
    if not (destination / 'BACKUP_COMPLETE.json').is_file():
        raise ValueError('Backup has not completed')
    restore = destination / 'restore-validation'
    restore.mkdir(mode=0o700)
    name = 'assay-restore-' + secrets.token_hex(6)
    database = config['postgres_database']
    username = config['postgres_user']
    credentials = restore / 'postgres.env'
    credentials.write_text(f'POSTGRES_USER={username}\nPOSTGRES_DB={database}\nPOSTGRES_PASSWORD={secrets.token_urlsafe(48)}\n')
    credentials.chmod(0o600)
    created = False
    try:
        image = inspect(config['postgres_container'])['Image']
        run('docker', 'run', '-d', '--name', name, '--network', 'none', '--env-file', str(credentials),
            '--mount', f'type=bind,src={destination / "assay.pgdump"},dst=/backup/assay.pgdump,readonly', image)
        created = True
        for _ in range(60):
            ready = subprocess.run(['docker', 'exec', name, 'pg_isready', '-U', username, '-d', database],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if ready.returncode == 0:
                break
            time.sleep(1)
        else:
            raise RuntimeError('Isolated recovery database did not start')
        run('docker', 'exec', name, 'pg_restore', '--exit-on-error', '--no-owner',
            '-U', username, '-d', database, '/backup/assay.pgdump')
        restored = database_fingerprints(name, username, database)
        if restored != json.loads((destination / 'database-fingerprints.json').read_text()):
            raise RuntimeError('Restored database differs from backup')
        write_json(restore / 'database-fingerprints.json', restored)
    finally:
        if created:
            run('docker', 'rm', '-f', '-v', name)
        credentials.unlink(missing_ok=True)
    trees = {}
    for label in config['trees']:
        clone(destination / label, restore / label)
        expected = fingerprint(destination / label, content=label in config['content_verify_trees'])
        actual = fingerprint(restore / label, content=label in config['content_verify_trees'])
        if expected != actual:
            raise RuntimeError('Restored filesystem metadata, ACL, xattr or content differs')
        trees[label] = expected
        print(json.dumps({'verified_tree': label, 'files': expected['files'], 'bytes': expected['bytes']}), flush=True)
    # Validate the copied AD databases without networking or writing to the production tree.
    ad_source = restore / config['ad_tree']
    ad_image = inspect(config['ad_container'])['Image']
    args = ['docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'samba-tool']
    for relative, target in config['ad_restore_mounts'].items():
        args += ['--mount', f'type=bind,src={ad_source / relative},dst={target}']
    output = run(*args, ad_image, 'dbcheck', '--cross-ncs')
    (restore / 'ad-dbcheck.log').write_bytes(output)
    sqlite_checks = {}
    for item in config.get('sqlite_files', []):
        path = restore / item
        with sqlite3.connect(f'file:{path}?mode=ro', uri=True) as db:
            result = db.execute('PRAGMA integrity_check').fetchone()[0]
        if result != 'ok':
            raise RuntimeError('Agent operation database failed integrity check')
        sqlite_checks[item] = result
    write_json(destination / 'RESTORE_VERIFIED.json', {'verified_at': time.time(), 'database_tables': len(restored),
               'trees': trees, 'ad_dbcheck': True, 'sqlite': sqlite_checks})
    print(json.dumps({'restore_verified': True, 'database_tables': len(restored), 'backup': str(destination)}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['backup', 'verify'])
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--destination', required=True, type=Path)
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error('Run on the deployment host as root to preserve ACLs and xattrs')
    config = json.loads(args.config.read_text())
    for key in ['postgres_user', 'postgres_database']:
        if not config[key] or any(ch not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-' for ch in config[key]):
            parser.error('Invalid database identifier')
    for label in config['trees']:
        if not label or any(ch not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-' for ch in label):
            parser.error('Invalid backup tree label')
    destination = args.destination.resolve()
    if args.action == 'backup':
        backup(config, destination)
    else:
        verify(config, destination)


if __name__ == '__main__':
    try:
        main()
    except subprocess.CalledProcessError as exc:
        # Tool output can contain private paths or configuration. Keep diagnostics local.
        raise SystemExit(f'Command failed (exit {exc.returncode}); inspect private host logs before retrying') from None
