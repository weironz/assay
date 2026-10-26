#!/usr/bin/env python3
"""Local release pipeline. All containers and outputs are isolated from deployments."""
import argparse
import contextlib
import datetime
import fcntl
import hashlib
import http.cookiejar
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
STEPS = ('test-deployment', 'test-web', 'test-api', 'test-cli', 'test-agent', 'build-images', 'build-cli', 'smoke')
SERVICES = {'api': 'apps/api', 'web': 'apps/web', 'samba-agent': 'agents/samba'}
ASSETS = ('assay-x86_64-unknown-linux-musl', 'assay-x86_64-pc-windows-msvc.exe', 'assay-samba-agent-x86_64-unknown-linux-musl')


def call(args, *, cwd=ROOT, env=None, capture=False, data=None, check=True):
    result = subprocess.run([str(a) for a in args], cwd=cwd, env=env,
                            input=data, text=True, check=check,
                            stdout=subprocess.PIPE if capture else None,
                            stderr=subprocess.PIPE if capture else None)
    return result.stdout.strip() if capture else result


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def source():
    commit = call(['git', 'rev-parse', 'HEAD'], capture=True)
    digest = hashlib.sha256()
    paths = call(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], capture=True)
    for name in sorted(set(paths.split('\0')) - {''}):
        path = ROOT / name
        digest.update(name.encode() + b'\0')
        if path.is_symlink():
            digest.update(os.readlink(path).encode())
        elif path.is_file():
            digest.update(str(path.stat().st_mode & 0o111).encode())
            digest.update(bytes.fromhex(sha256(path)))
        else:
            digest.update(b'deleted')
    return {'commit': commit, 'sourceSha256': digest.hexdigest()}


def clean_source():
    if call(['git', 'status', '--porcelain', '--untracked-files=all'], capture=True):
        raise RuntimeError('Commit source changes before recording verification or publishing')
    return source()


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.replace(path)


class Pipeline:
    def __init__(self):
        self.version = os.getenv('LOCAL_CI_VERSION') or json.loads((ROOT / 'package.json').read_text())['version']
        if not re.fullmatch(r'\d+\.\d+\.\d+', self.version):
            raise ValueError('VERSION must be an explicit X.Y.Z, never latest')
        self.namespace = os.getenv('LOCAL_CI_DOCKERHUB_NAMESPACE', 'willdockerhub')
        self.repository = os.getenv('LOCAL_CI_GITHUB_REPOSITORY', 'weironz/assay')
        if not re.fullmatch(r'[a-z0-9][a-z0-9_-]*', self.namespace):
            raise ValueError('Invalid Docker Hub namespace')
        if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', self.repository):
            raise ValueError('Invalid GitHub repository')
        state = Path(os.getenv('LOCAL_CI_STATE_DIR', ROOT / '.local-ci')).resolve()
        # This is an output/cache directory, never a deployment directory.
        if state in (ROOT, Path('/'), Path('/data/assay')):
            raise ValueError('Use a dedicated local CI output directory')
        self.state = state / self.version
        self.dist = self.state / 'dist'
        self.state.mkdir(parents=True, exist_ok=True)
        self.dist.mkdir(exist_ok=True)
        self.env = os.environ.copy()
        # Publication credentials are selected only for the commands that need
        # them, never forwarded to compilers or Docker build commands.
        self.env.pop('ASSAY_RELEASE_GITHUB_TOKEN', None)
        self.env.pop('DOCKERHUB_TOKEN', None)
        for key in list(self.env):
            if key.startswith('COMPOSE_'):
                self.env.pop(key)
        cargo = os.getenv('CARGO', 'cargo')
        if '/' in cargo:
            self.env['PATH'] = str(Path(cargo).parent) + os.pathsep + self.env.get('PATH', '')
        self.cargo = cargo

    def github_env(self):
        env = self.env.copy()
        token = os.getenv('ASSAY_RELEASE_GITHUB_TOKEN')
        config_dir = os.getenv('ASSAY_RELEASE_GH_CONFIG_DIR')
        if token:
            # Keep the platform's inherited authentication unchanged elsewhere.
            env['GH_TOKEN'] = token
        elif config_dir:
            # An explicitly selected local gh login is a fallback when managed
            # secret configuration is unavailable. Let gh read its own store.
            directory = Path(config_dir).expanduser().resolve()
            if not (directory / 'hosts.yml').is_file():
                raise RuntimeError('Configured release GitHub login is unavailable; authenticate in ASSAY_RELEASE_GH_CONFIG_DIR')
            env['GH_CONFIG_DIR'] = str(directory)
            env.pop('GH_TOKEN', None)
            env.pop('GITHUB_TOKEN', None)
        return env

    def gh(self, *arguments, capture=False):
        return call(['gh', *arguments], env=self.github_env(), capture=capture)

    def dockerhub_login(self):
        token = os.getenv('DOCKERHUB_TOKEN')
        if not token:
            print('Docker Hub: using existing Docker client credentials; write access is checked on push', flush=True)
            return
        username = os.getenv('DOCKERHUB_USERNAME', '')
        if not re.fullmatch(r'[a-z0-9][a-z0-9_-]*', username):
            raise RuntimeError('Set DOCKERHUB_USERNAME to the login account when binding DOCKERHUB_TOKEN')
        result = subprocess.run(['docker', 'login', '--username', username, '--password-stdin'],
                                input=token + '\n', text=True, env=self.env, capture_output=True)
        if result.returncode:
            # Do not relay credential-helper or registry output into CI logs.
            raise RuntimeError('Docker Hub login failed; check the configured publication credentials')
        print('Docker Hub login succeeded', flush=True)

    def auth_check(self):
        self.local_docker()
        self.dockerhub_login()
        self.gh('api', 'user', '--jq', '.login')
        self.gh('api', 'repos/' + self.repository, '--jq', '.full_name')
        print('Authentication and repository access checked; image pushes and Release uploads are checked during publication', flush=True)

    def version_check(self):
        values = [json.loads((ROOT / f).read_text())['version'] for f in ['package.json', 'apps/api/package.json', 'apps/web/package.json']]
        for directory in ['cli', 'agents/samba']:
            values.append(re.search(r'^version = "([^"]+)"', (ROOT / directory / 'Cargo.toml').read_text(), re.M)[1])
        if any(value != self.version for value in values):
            raise RuntimeError('VERSION must match root/API/Web/CLI/Agent package versions')

    def local_docker(self):
        endpoint = self.env.get('DOCKER_HOST')
        explicit_context = self.env.get('DOCKER_CONTEXT')
        if explicit_context or not endpoint:
            context = explicit_context or call(['docker', 'context', 'show'], capture=True, env=self.env)
            endpoint = call(['docker', 'context', 'inspect', context, '--format', '{{(index .Endpoints "docker").Host}}'], capture=True, env=self.env)
        if not endpoint.startswith(('unix://', 'npipe://')):
            raise RuntimeError('Local CI refuses remote Docker daemons; production uses the explicit SSH deploy task')
        call(['docker', 'info', '--format', 'Docker {{.ServerVersion}}'], env=self.env)

    def doctor(self):
        self.version_check()
        for tool in ['docker', 'gh', 'git', 'python3', self.cargo, 'cargo-xwin', 'clang-cl', 'lld-link', 'llvm-lib', 'llvm-dlltool']:
            if not shutil.which(tool, path=self.env.get('PATH')):
                raise RuntimeError('Missing prerequisite: ' + tool)
        self.local_docker()
        call(['docker', 'compose', 'version'], env=self.env)
        call([self.cargo, '--version'], env=self.env)
        call([self.cargo, 'fmt', '--version'], env=self.env)
        call([self.cargo, 'clippy', '--version'], env=self.env)
        call([self.cargo, 'xwin', '--version'], env=self.env)
        call(['clang-cl', '--version'], env=self.env)
        call(['lld-link', '--version'], env=self.env)
        self.gh('api', 'user', '--jq', '.login')
        print('Version and local prerequisites checked; Docker Hub write access is checked on push', flush=True)

    def mark(self, step, **outputs):
        write_json(self.state / (step + '.json'), {**source(), 'version': self.version,
                   'step': step, 'passedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), **outputs})

    def receipt(self, step):
        path = self.state / (step + '.json')
        if not path.is_file():
            raise RuntimeError('Run the missing task first: ' + step)
        value = json.loads(path.read_text())
        current = source()
        if value.get('version') != self.version or any(value.get(k) != v for k, v in current.items()):
            raise RuntimeError('Source changed; rerun the stale task: ' + step)
        return value

    def build_flags(self):
        flags = ['--platform', 'linux/amd64', '--provenance=false', '--sbom=false']
        ca = os.getenv('LOCAL_CI_PROXY_CA') or os.getenv('CODEX_PROXY_CERT')
        if ca:
            if not Path(ca).is_file():
                raise RuntimeError('Configured proxy CA file is missing')
            flags += ['--secret', 'id=proxy_ca,src=' + ca]
        return flags

    def image(self, service, test=False):
        return f'assay-local/{service}{"-test" if test else ""}:{self.version}-{source()["commit"][:12]}'

    def docker_build(self, service, test=False):
        self.local_docker()
        self.version_check()
        args = ['docker', 'buildx', 'build', *self.build_flags(), '--load', '-t', self.image(service, test)]
        args += ['--label', 'org.opencontainers.image.revision=' + source()['commit'],
                 '--label', 'org.opencontainers.image.version=' + self.version]
        if test:
            args += ['--target', 'builder']
        if service == 'web':
            args += ['--build-arg', 'VITE_API_BASE_URL=']
        call([*args, str(ROOT / SERVICES[service])], env=self.env)
        return self.image(service, test)

    @contextlib.contextmanager
    def sandbox(self, purpose, images=None):
        self.local_docker()
        project = 'assay-local-ci-' + purpose + '-' + secrets.token_hex(5)
        env = self.env.copy()
        env['LOCAL_CI_TEST_PORT'] = str(free_port())
        env['LOCAL_CI_TEST_URL'] = 'http://127.0.0.1:' + env['LOCAL_CI_TEST_PORT']
        if images:
            env.update(LOCAL_CI_API_IMAGE=images['api'], LOCAL_CI_WEB_IMAGE=images['web'])
        command = ['docker', 'compose', '--project-directory', str(ROOT), '--env-file', os.devnull,
                   '-p', project, '-f', str(ROOT / 'deploy/local-ci/docker-compose.yaml')]
        def compose(*args, **kwargs):
            return call([*command, *args], env=env, **kwargs)
        try:
            yield compose, env, project + '_default'
        finally:
            # Only our unique project and its disposable volumes are eligible.
            if not re.fullmatch(r'assay-local-ci-[a-z]+-[0-9a-f]{10}', project):
                raise RuntimeError('Invalid sandbox cleanup project')
            compose('--profile', 'smoke', 'down', '--volumes', '--remove-orphans')

    def test_deployment(self):
        for directory in ['deploy/aliyun/tests', 'deploy/aliyun-Cloudflare-Tunnel/tests', 'deploy/samba-production', 'scripts/local-ci/tests']:
            call([sys.executable, '-m', 'unittest', 'discover', '-s', directory, '-p', 'test_*.py'], env=self.env)
        call(['bash', 'scripts/test-backup.sh'], env=self.env)
        call(['node', '--test', 'deploy/samba-test/tests/test-origin.test.cjs'], env=self.env)
        self.mark('test-deployment')

    def test_web(self):
        image = self.docker_build('web', True)
        # One contract test imports the server's scope definitions relative to
        # the web tree. Keep that source relationship without baking API files
        # or credentials into the production Web image.
        call(['docker', 'run', '--rm', '--mount',
              f'type=bind,src={ROOT / "apps/api/src"},dst=/api/src,readonly',
              image, 'bun', 'run', 'test'], env=self.env)
        self.mark('test-web')

    def test_api(self):
        image = self.docker_build('api', True)
        with self.sandbox('api') as (compose, env, network):
            compose('up', '-d', '--wait', '--wait-timeout', '180', 'postgres', 'redis')
            url = 'postgresql://ci:ci_test_password@postgres:5432/assay_ci?schema=public'
            args = ['docker', 'run', '--rm', '--network', network]
            values = {'DATABASE_URL': url, 'REDIS_URL': 'redis://redis:6379',
                      'SESSION_EPOCH_TEST_DATABASE_URL': url, 'SAMBA_AUDIT_TEST_DATABASE_URL': url,
                      'AUTH_BASE_URL': 'http://localhost:3000', 'AUTH_TRUST_ORIGINS': 'http://localhost:5173',
                      'NODE_ENV': 'test', 'MAIL_PROVIDER': 'none'}
            for key, value in values.items():
                args += ['-e', key + '=' + value]
            for directory in ['test', 'scripts']:
                args += ['--mount', f'type=bind,src={ROOT / "apps/api" / directory},dst=/app/{directory},readonly']
            call([*args, image, 'sh', '-ec', './node_modules/.bin/prisma validate && ./node_modules/.bin/prisma migrate deploy && node scripts/run-tests.cjs'], env=env)
        self.mark('test-api')

    def rust(self, directory, arguments):
        env = self.env.copy()
        target = self.state.parent / 'cache' / ('target-agent' if directory == 'agents/samba' else 'target-cli')
        target.mkdir(parents=True, exist_ok=True)
        env['CARGO_TARGET_DIR'] = str(target)
        call([self.cargo, *arguments, '--manifest-path', str(ROOT / directory / 'Cargo.toml')], env=env)

    def test_cli(self):
        self.rust('cli', ['test', '--locked'])
        self.mark('test-cli')

    def test_agent(self):
        self.rust('agents/samba', ['fmt', '--check'])
        # cargo fmt's --check is a rustfmt option; clippy's warnings flag follows --.
        env = self.env.copy()
        env['CARGO_TARGET_DIR'] = str(self.state.parent / 'cache/target-agent')
        call([self.cargo, 'clippy', '--locked', '--manifest-path', str(ROOT / 'agents/samba/Cargo.toml'), '--all-targets', '--', '-D', 'warnings'], env=env)
        self.rust('agents/samba', ['test', '--locked'])
        self.mark('test-agent')

    def build_images(self):
        images, ids = {}, {}
        for service in SERVICES:
            images[service] = self.docker_build(service)
            ids[service] = call(['docker', 'image', 'inspect', images[service], '--format', '{{.Id}}'], capture=True, env=self.env)
        container = call(['docker', 'create', images['samba-agent']], capture=True, env=self.env)
        try:
            call(['docker', 'cp', container + ':/assay-samba-agent', str(self.dist / ASSETS[2])], env=self.env)
        finally:
            call(['docker', 'rm', container], env=self.env)
        self.mark('build-images', images=images, imageIds=ids, agentSha256=sha256(self.dist / ASSETS[2]))

    def build_cli(self):
        self.local_docker()
        self.version_check()
        destination = self.state / 'linux-export'
        call(['docker', 'buildx', 'build', *self.build_flags(), '-f', str(ROOT / 'cli/Dockerfile.release'),
              '--target', 'linux-export', '--output', 'type=local,dest=' + str(destination), str(ROOT / 'cli')], env=self.env)
        shutil.copy2(destination / ASSETS[0], self.dist / ASSETS[0])
        # Native cargo-xwin avoids expanding a multi-gigabyte compiler image on
        # Docker's copy-based storage drivers. Its SDK/cache stays in CI output.
        env = self.env.copy()
        target = self.state.parent / 'cache/target-cli'
        env['CARGO_TARGET_DIR'] = str(target)
        env['XWIN_CACHE_DIR'] = str(self.state.parent / 'cache/xwin')
        call([self.cargo, 'xwin', 'build', '--locked', '--release', '--target', 'x86_64-pc-windows-msvc',
              '--manifest-path', str(ROOT / 'cli/Cargo.toml')], env=env)
        shutil.copy2(target / 'x86_64-pc-windows-msvc/release/assay.exe', self.dist / ASSETS[1])
        # Verify both file formats, and execute the statically linked Linux CLI.
        if (self.dist / ASSETS[0]).read_bytes()[:4] != b'\x7fELF' or (self.dist / ASSETS[1]).read_bytes()[:2] != b'MZ':
            raise RuntimeError('Invalid Linux or Windows binary format')
        (self.dist / ASSETS[0]).chmod(0o755)
        output = call([self.dist / ASSETS[0], '--version'], capture=True, env=self.env)
        if self.version not in output:
            raise RuntimeError('CLI version does not match the release')
        self.mark('build-cli', assets={name: sha256(self.dist / name) for name in ASSETS[:2]})

    def smoke(self):
        images = self.receipt('build-images')['images']
        with self.sandbox('smoke', images) as (compose, env, _network):
            try:
                compose('--profile', 'smoke', 'up', '-d', '--wait', '--wait-timeout', '240')
                base = env['LOCAL_CI_TEST_URL']
                client = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
                def request(path, body=None):
                    headers = {'Origin': base}
                    if body is not None:
                        headers['Content-Type'] = 'application/json'
                    req = urllib.request.Request(base + path, data=None if body is None else json.dumps(body).encode(), headers=headers)
                    try:
                        with client.open(req, timeout=10) as response:
                            return response.status, response.read()
                    except urllib.error.HTTPError as error:
                        return error.code, error.read()
                for _ in range(120):
                    if request('/api/health/live')[0] == 200:
                        break
                    time.sleep(2)
                else:
                    raise RuntimeError('API health check did not become ready')
                for path in ['/', '/tickets', '/brand/greenstor-lockup.png', '/brand/greenstor-lockup-dark.png', '/brand/favicon.png']:
                    if request(path)[0] != 200:
                        raise RuntimeError('Smoke response failed: ' + path)
                if request('/api/me')[0] != 401:
                    raise RuntimeError('Anonymous API access was not rejected')
                if request('/api/auth/sign-in/email', {'email': 'admin@example.com', 'password': 'ciadmin12345'})[0] != 200:
                    raise RuntimeError('Disposable admin login failed')
                code, body = request('/api/me')
                if code != 200 or 'admin' not in json.loads(body)['roles']:
                    raise RuntimeError('Disposable admin roles are missing')
                if request('/api/tickets?pageSize=1')[0] != 200:
                    raise RuntimeError('Ticket list smoke failed')
                mfa_env = env.copy()
                mfa_env.update(ASSAY_TEST_URL=base, ASSAY_TEST_PASSWORD='ciadmin12345')
                # This subprocess only addresses the disposable loopback stack.
                mfa_env['NO_PROXY'] = mfa_env.get('NO_PROXY', '') + ',127.0.0.1,localhost'
                mfa_env['no_proxy'] = mfa_env['NO_PROXY']
                call([sys.executable, 'scripts/smoke-two-factor.py'], env=mfa_env)
                statuses = [request('/api/auth/sign-in/email', {'email': 'admin@example.com', 'password': 'wrong'})[0] for _ in range(8)]
                if 429 not in statuses:
                    raise RuntimeError('Login throttling did not activate')
            except BaseException:
                compose('logs', '--tail', '80')
                raise
        self.mark('smoke', imageIds=self.receipt('build-images')['imageIds'])

    def verify(self):
        clean_source()
        for step in STEPS:
            self.receipt(step)
        assets = self.check_artifacts()
        images = self.receipt('build-images')['imageIds']
        if self.receipt('smoke').get('imageIds') != images:
            raise RuntimeError('Images changed after smoke testing; rerun smoke')
        self.mark('verified', steps=list(STEPS), imageIds=images, assets=assets)
        print('All local tests, builds and isolated smoke checks passed for ' + self.version, flush=True)

    def check_artifacts(self):
        cli = self.receipt('build-cli')
        images = self.receipt('build-images')
        expected = {**cli['assets'], ASSETS[2]: images['agentSha256']}
        if set(expected) != set(ASSETS) or any(sha256(self.dist / name) != digest for name, digest in expected.items()):
            raise RuntimeError('Release assets changed after their build')
        for service, reference in images['images'].items():
            actual = call(['docker', 'image', 'inspect', reference, '--format', '{{.Id}}'], capture=True, env=self.env)
            if actual != images['imageIds'][service]:
                raise RuntimeError('A verified image tag was changed: ' + service)
        return expected

    def verified_artifacts(self):
        verified = self.receipt('verified')
        assets = self.check_artifacts()
        if (verified.get('assets') != assets or
                verified.get('imageIds') != self.receipt('build-images')['imageIds']):
            raise RuntimeError('Artifacts changed after verification; rerun the complete checks')
        return assets

    def push_images(self):
        clean_source()
        self.local_docker()
        self.verified_artifacts()
        self.dockerhub_login()
        built = self.receipt('build-images')
        published = {}
        previous_path = self.state / 'push-images.json'
        previous = self.receipt('push-images').get('images', {}) if previous_path.exists() else {}
        for service, local in built['images'].items():
            reference = f'{self.namespace}/assay-{service}:{self.version}'
            probe = subprocess.run(['docker', 'buildx', 'imagetools', 'inspect', reference, '--format', '{{json .Manifest}}'], env=self.env, text=True, capture_output=True)
            if probe.returncode == 0:
                remote = json.loads(probe.stdout)['digest']
                if (previous.get(service, {}).get('digest') != remote or
                        previous.get(service, {}).get('imageId') != built['imageIds'][service]):
                    raise RuntimeError('Version tag already exists; refusing overwrite: ' + reference)
                published[service] = previous[service]
                continue
            missing = re.search(r'manifest unknown|not found|no such manifest', probe.stderr, re.I)
            if not missing or re.search(r'unauthorized|denied|forbidden|429|timeout', probe.stderr, re.I):
                raise RuntimeError('Cannot verify remote tag availability; check Docker Hub login and network: ' + reference)
            call(['docker', 'tag', local, reference], env=self.env)
            call(['docker', 'push', reference], env=self.env)
            manifest = json.loads(call(['docker', 'buildx', 'imagetools', 'inspect', reference, '--format', '{{json .Manifest}}'], capture=True, env=self.env))
            digest = manifest['digest']
            raw = json.loads(call(['docker', 'buildx', 'imagetools', 'inspect', reference + '@' + digest, '--raw'], capture=True, env=self.env))
            if raw.get('config', {}).get('digest') != built['imageIds'][service]:
                raise RuntimeError('Registry image config differs from the verified local image')
            if not re.fullmatch(r'sha256:[0-9a-f]{64}', digest):
                raise RuntimeError('Registry digest is missing')
            published[service] = {'reference': reference, 'digest': digest, 'imageId': built['imageIds'][service]}
            self.mark('push-images', images=published)
        self.mark('push-images', images=published)

    def release(self):
        current = clean_source()
        checksums = self.verified_artifacts()
        images = self.receipt('push-images')['images']
        if set(images) != set(SERVICES):
            raise RuntimeError('Push all three images before publishing the release')
        manifest = {**current, 'version': self.version, 'images': images, 'assets': checksums,
                    'productionDeployed': False, 'verification': self.receipt('verified')}
        write_json(self.dist / 'release-manifest.json', manifest)
        sums = {**checksums, 'release-manifest.json': sha256(self.dist / 'release-manifest.json')}
        (self.dist / 'SHA256SUMS').write_text(''.join(f'{digest}  {name}\n' for name, digest in sorted(sums.items())))
        tag = 'v' + self.version
        refs = call(['git', 'ls-remote', '--tags', 'origin', 'refs/tags/' + tag, 'refs/tags/' + tag + '^{}'], capture=True)
        remote = dict(line.split()[::-1] for line in refs.splitlines()) if refs else {}
        tag_commit = remote.get('refs/tags/' + tag + '^{}') or remote.get('refs/tags/' + tag)
        if tag_commit and tag_commit != current['commit']:
            raise RuntimeError('Release tag belongs to a different commit; refusing overwrite')
        probe = subprocess.run(['gh', 'release', 'view', tag, '--repo', self.repository, '--json', 'isDraft,assets,url'], env=self.github_env(), text=True, capture_output=True)
        existing = json.loads(probe.stdout) if probe.returncode == 0 else None
        if probe.returncode and not re.search(r'not found|HTTP 404', probe.stderr, re.I):
            raise RuntimeError('Cannot check the existing GitHub release')
        if existing and not existing['isDraft']:
            receipt = self.receipt('release')
            if receipt['url'] != existing['url']:
                raise RuntimeError('Published release already exists; refusing overwrite')
            print(existing['url'], flush=True)
            return
        notes = self.state / 'release-notes.md'
        notes.write_text('# Assay ' + tag + '\n\nBuilt and verified locally from `' + current['commit'] + '`.\n\n'
                         '## Docker Hub\n\n' + '\n'.join('- `' + item['reference'] + '@' + item['digest'] + '`' for item in images.values()) +
                         '\n\n## Binaries\n\n- Linux x86_64 static musl CLI\n- Windows x86_64 MSVC CLI\n- Linux x86_64 Samba Agent (host Samba tools required for standalone use)\n\n'
                         'Verify downloads against `SHA256SUMS`. `release-manifest.json` records the source and image digests.\n\n'
                         '**Production was not deployed. No latest image tags were updated.**\n')
        if not tag_commit:
            local_tag = subprocess.run(['git', 'rev-parse', '--verify', tag + '^{}'], cwd=ROOT, text=True, capture_output=True)
            if local_tag.returncode == 0 and local_tag.stdout.strip() != current['commit']:
                raise RuntimeError('Local release tag belongs to another commit')
            if local_tag.returncode:
                call(['git', 'tag', '-a', tag, current['commit'], '-m', 'Release ' + tag], env=self.env)
            call(['git', 'push', 'origin', 'refs/tags/' + tag], env=self.env)
        if not existing:
            self.gh('release', 'create', tag, '--repo', self.repository, '--verify-tag', '--draft',
                    '--title', 'Assay ' + tag, '--notes-file', notes)
        names = {*ASSETS, 'SHA256SUMS', 'release-manifest.json'}
        already = {asset['name'] for asset in (existing or {}).get('assets', [])}
        if already - names:
            raise RuntimeError('The existing draft has unexpected assets')
        missing = sorted(names - already)
        if missing:
            self.gh('release', 'upload', tag, '--repo', self.repository, *[self.dist / name for name in missing])
        downloads = self.state / 'release-download-check'
        downloads.mkdir(exist_ok=True)
        self.gh('release', 'download', tag, '--repo', self.repository, '--dir', downloads, '--clobber')
        for name in names:
            if sha256(downloads / name) != sha256(self.dist / name):
                raise RuntimeError('Uploaded asset checksum differs: ' + name)
        self.gh('release', 'edit', tag, '--repo', self.repository, '--draft=false', '--latest')
        assets = json.loads(self.gh('release', 'view', tag, '--repo', self.repository, '--json', 'assets,url', capture=True))
        if {asset['name'] for asset in assets['assets']} != {*ASSETS, 'SHA256SUMS', 'release-manifest.json'}:
            raise RuntimeError('Published release assets do not match the verified set')
        self.mark('release', url=assets['url'], images=images)
        print(assets['url'], flush=True)

    def deploy(self):
        # No other pipeline action calls this method.
        clean_source()
        self.receipt('release')
        self.verified_artifacts()
        images = self.receipt('push-images')['images']
        host = os.getenv('LOCAL_CI_DEPLOY_HOST', '')
        user = os.getenv('LOCAL_CI_DEPLOY_USER', '')
        directory = os.getenv('LOCAL_CI_DEPLOY_DIR', '')
        port = os.getenv('LOCAL_CI_DEPLOY_PORT', '22')
        if not re.fullmatch(r'[A-Za-z0-9_.:-]+', host) or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_-]*', user):
            raise RuntimeError('Explicit production SSH host and user are required')
        if not re.fullmatch(r'/[A-Za-z0-9_./-]+', directory) or directory == '/' or not port.isdigit():
            raise RuntimeError('Explicit absolute production directory and valid SSH port are required')
        options = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-p', port]
        if os.getenv('LOCAL_CI_SSH_CONFIG'):
            options += ['-F', os.environ['LOCAL_CI_SSH_CONFIG']]
        target = user + '@' + host
        operation = directory + '/backups/local-ci-' + self.version + '-' + time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
        call(['ssh', *options, target, shlex.join(['mkdir', '-p', operation + '/tools'])], env=self.env)
        scp_options = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-P', port]
        if os.getenv('LOCAL_CI_SSH_CONFIG'):
            scp_options += ['-F', os.environ['LOCAL_CI_SSH_CONFIG']]
        call(['scp', *scp_options, ROOT / 'scripts/backup.sh', target + ':' + operation + '/tools/backup.sh'], env=self.env)
        arguments = [directory, operation, self.version, self.namespace, images['api']['digest'], images['web']['digest']]
        command = shlex.join(['bash', '-s', '--', *arguments])
        call(['ssh', *options, target, command], data=(ROOT / 'scripts/local-ci/deploy.sh').read_text(), env=self.env)
        self.mark('deployed', host=host, directory=directory, backup=operation)

    def status(self):
        print(json.dumps({'version': self.version, 'source': source(), 'output': str(self.state),
                          'receipts': [p.stem for p in self.state.glob('*.json')]}, indent=2))


def free_port():
    with socket.socket() as connection:
        connection.bind(('127.0.0.1', 0))
        return connection.getsockname()[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['doctor', 'auth-check', *STEPS, 'verify', 'push-images', 'release', 'deploy', 'status'])
    args = parser.parse_args()
    pipeline = Pipeline()
    lock = (pipeline.state.parent / 'pipeline.lock').open('a')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise RuntimeError('Another local CI task is using this output directory')
    getattr(pipeline, args.action.replace('-', '_'))()


if __name__ == '__main__':
    try:
        main()
    except subprocess.CalledProcessError as error:
        # Never print the subprocess environment or captured credential/config data.
        print(f'Local CI command failed (exit {error.returncode}). See the preceding task output.', file=sys.stderr)
        raise SystemExit(error.returncode)
    except (RuntimeError, ValueError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
