#!/usr/bin/env python3
"""Update the token file for this Compose deployment without displaying it."""
import getpass
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request


def run(command):
    return subprocess.run(command, check=True, capture_output=True, text=True).stdout


def main():
    directory = Path(__file__).resolve().parent
    compose = ['docker', 'compose', '--project-directory', str(directory),
               '-f', str(directory / 'docker-compose.yaml')]
    config = json.loads(run([*compose, 'config', '--format', 'json']))
    token_file = Path(config['secrets']['tunnel_token']['file'])
    if not token_file.is_absolute():
        token_file = directory / token_file
    # Check the existing mount before requesting a credential. The deployment
    # owns this file and its permissions; preserve its inode and ownership.
    if not token_file.is_file() or token_file.is_symlink():
        raise RuntimeError('Expected an existing regular token file')
    token = getpass.getpass('请输入该 Tunnel 当前有效的令牌（不会显示）：').strip()
    if len(token) < 40 or any(character.isspace() for character in token):
        raise ValueError('Invalid token format')
    with token_file.open('r+') as output:
        os.fchmod(output.fileno(), 0o400)
        output.write(token)
        output.truncate()
        output.flush()
        os.fsync(output.fileno())
    del token
    run([*compose, 'restart', 'cloudflared'])
    print('令牌文件已更新，正在检查 Tunnel 连接……', flush=True)
    container_id = run([*compose, 'ps', '-q', 'cloudflared']).strip()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        state = json.loads(run(['docker', 'inspect', container_id]))[0]
        addresses = [network['IPAddress'] for network in
                     state['NetworkSettings']['Networks'].values()
                     if network['IPAddress']]
        for address in addresses:
            try:
                with opener.open('http://' + address + ':20241/ready', timeout=3) as response:
                    connections = json.load(response).get('readyConnections', 0)
                if connections > 0:
                    print('Tunnel 已就绪，当前连接数：' + str(connections))
                    return
            except (OSError, ValueError):
                pass
        time.sleep(2)
    print('令牌文件已更新，但 Tunnel 尚未就绪。请检查控制台 Tunnel 状态及容器日志。')
    raise SystemExit(1)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Docker request payloads and credential values must not be printed.
        print('更新未完成（' + type(error).__name__ + '）。请检查文件权限及容器日志。')
        raise SystemExit(1)
