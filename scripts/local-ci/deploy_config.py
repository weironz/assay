"""Prepare a narrowly scoped API/Web upgrade without changing data services."""
import argparse
import hashlib
import ipaddress
import json
from pathlib import Path
import re
import subprocess


def canonical(config):
    config = json.loads(json.dumps(config))
    for name in ('api', 'web'):
        service = config['services'][name]
        service.pop('image', None)
        environment = service.setdefault('environment', {})
        for key in ('IMAGE_TAG', 'REGISTRY', 'ASSAY_TRUSTED_PROXY_IPS', 'ATTACHMENT_DRAFT_CLEANUP_ENABLED'):
            environment.pop(key, None)
    return hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest()


def environment_setting(text, service, key, value):
    lines = text.splitlines(keepends=True)
    starts = [i for i, line in enumerate(lines) if re.fullmatch(r'  ' + re.escape(service) + r':\s*\n?', line)]
    if len(starts) != 1:
        raise RuntimeError('Expected exactly one ' + service + ' service in the active Compose file')
    start = starts[0]
    end = next((i for i in range(start + 1, len(lines)) if re.match(r'^\S|^  [A-Za-z0-9_-]+:', lines[i])), len(lines))
    setting = '      ' + key + ': ' + value + '\n'
    section = lines[start + 1:end]
    environments = [i for i, line in enumerate(section) if re.match(r'^    environment:', line)]
    if not environments:
        section = ['    environment:\n', setting, *section]
    else:
        index = environments[0]
        if section[index].strip() != 'environment:':
            raise RuntimeError('Use a mapping for ' + service + '.environment before deployment')
        stop = next((i for i in range(index + 1, len(section)) if re.match(r'^    \S', section[i])), len(section))
        if any(re.match(r'^\s+- ', line) for line in section[index + 1:stop]):
            raise RuntimeError('Use a mapping for ' + service + '.environment before deployment')
        section[index + 1:stop] = [setting, *[line for line in section[index + 1:stop]
            if not re.match(r'^      ' + re.escape(key) + ':', line)]]
    return ''.join([*lines[:start + 1], *section, *lines[end:]])


def web_proxy_setting(text):
    return environment_setting(text, 'web', 'ASSAY_TRUSTED_PROXY_IPS', '${ASSAY_TRUSTED_PROXY_IPS:-}')


def update_env(text, values):
    seen = set()
    result = []
    for line in text.splitlines():
        key = line.split('=', 1)[0] if '=' in line and not line.lstrip().startswith('#') else None
        if key in values:
            if key in seen:
                raise RuntimeError('Duplicate deployment environment key: ' + key)
            seen.add(key)
            line = key + '=' + values[key]
        result.append(line)
    result += [key + '=' + value for key, value in values.items() if key not in seen]
    return '\n'.join(result) + '\n'


def render(directory, compose=None, environment=None):
    command = ['docker', 'compose', '--project-directory', str(directory)]
    if environment:
        command += ['--env-file', str(environment)]
    command += ['-f', str(compose or directory / 'docker-compose.yaml'), 'config', '--format', 'json']
    return json.loads(subprocess.check_output(command, text=True))


def assert_safe_runtime(config):
    api = config['services']['api']
    command = api.get('command')
    command_text = command if isinstance(command, str) else ' '.join(command or [])
    if not command_text or 'seed' in command_text:
        raise RuntimeError('Use an explicit no-seed production API startup command')
    if str(api.get('environment', {}).get('ATTACHMENT_DRAFT_CLEANUP_ENABLED', '')).lower() != 'false':
        raise RuntimeError('Keep automatic draft cleanup explicitly disabled during production upgrades')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['prepare', 'check'])
    parser.add_argument('directory', type=Path)
    parser.add_argument('operation', type=Path)
    parser.add_argument('version')
    parser.add_argument('registry')
    parser.add_argument('proxy_containers')
    args = parser.parse_args()
    directory, operation = args.directory, args.operation
    expected = {'api': args.registry + '/assay-api:' + args.version,
                'web': args.registry + '/assay-web:' + args.version}
    if args.action == 'check':
        current = render(directory)
        assert_safe_runtime(current)
        if canonical(current) != (operation / 'config-fingerprint.txt').read_text().strip():
            raise RuntimeError('Deployment changed protected service settings, volumes, networks or credentials')
        if any(current['services'][name]['image'] != image for name, image in expected.items()):
            raise RuntimeError('Deployment image references do not match the verified release')
        return
    before = render(directory)
    command = before['services']['api'].get('command')
    command_text = command if isinstance(command, str) else ' '.join(command or [])
    if not command_text or 'seed' in command_text:
        raise RuntimeError('Use an explicit no-seed production API startup command')
    web = subprocess.check_output(['docker', 'compose', 'ps', '-q', 'web'], cwd=directory, text=True).strip()
    web_info = json.loads(subprocess.check_output(['docker', 'inspect', web], text=True))[0]
    networks = set(web_info['NetworkSettings']['Networks'])
    addresses = set()
    for name in filter(None, args.proxy_containers.split(',')):
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', name):
            raise RuntimeError('Invalid trusted proxy container name')
        item = json.loads(subprocess.check_output(['docker', 'inspect', name], text=True))[0]
        shared = networks & set(item['NetworkSettings']['Networks'])
        if not shared or item['State']['Status'] != 'running':
            raise RuntimeError('A declared trusted proxy cannot reach the active Web service')
        for network in shared:
            addresses.add(str(ipaddress.IPv4Address(item['NetworkSettings']['Networks'][network]['IPAddress'])))
    values = {'IMAGE_TAG': args.version, 'REGISTRY': args.registry,
              'ASSAY_TRUSTED_PROXY_IPS': ','.join(sorted(addresses)), 'ATTACHMENT_DRAFT_CLEANUP_ENABLED': 'false'}
    (operation / 'next.env').write_text(update_env((directory / '.env').read_text(), values))
    candidate_text = web_proxy_setting((directory / 'docker-compose.yaml').read_text())
    candidate_text = environment_setting(candidate_text, 'api', 'ATTACHMENT_DRAFT_CLEANUP_ENABLED', '${ATTACHMENT_DRAFT_CLEANUP_ENABLED:-false}')
    (operation / 'next-compose.yaml').write_text(candidate_text)
    (operation / 'next.env').chmod((directory / '.env').stat().st_mode & 0o777)
    (operation / 'next-compose.yaml').chmod((directory / 'docker-compose.yaml').stat().st_mode & 0o777)
    candidate = render(directory, operation / 'next-compose.yaml', operation / 'next.env')
    assert_safe_runtime(candidate)
    if canonical(before) != canonical(candidate):
        raise RuntimeError('Candidate deployment would change protected configuration')
    if any(candidate['services'][name]['image'] != image for name, image in expected.items()):
        raise RuntimeError('Candidate image references do not match the release')
    (operation / 'config-fingerprint.txt').write_text(canonical(before) + '\n')
    print('Candidate API/Web config checked; trusted proxy addresses resolved; data services and credentials preserved')


if __name__ == '__main__':
    main()
