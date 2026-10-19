# 阿里云 Cloudflare Tunnel

此 Compose 独立部署于 `/data/cloudflared`，复用 Assay Web 所在的 Docker 网络。
完整应用部署与迁移步骤见 [上级说明](../README.md)。
它不发布主机端口，也不需要重启现有 Traefik 或 Assay。

## 部署

将本目录中的 `docker-compose.yaml` 和 `.env.example` 复制到目标目录。
先确认 `.env` 中的外部网络名称与 Assay Web 所在网络一致。
新安装默认 `assay-tunnel`；现有服务器使用 `traefik-network` 时在 `.env` 中保留该值。
第二个连接器需要不同的 `CLOUDFLARED_PROJECT` 和 `CLOUDFLARED_CONTAINER_NAME`，
例如均设为 `cloudflared-will`，各自维护独立令牌文件。

```bash
cd /data/cloudflared
cp .env.example .env
install -d -m 700 secrets
read -r -s -p 'Tunnel token: ' tunnel_token_input
printf '\n'
printf '%s' "$tunnel_token_input" > secrets/tunnel-token
unset tunnel_token_input
# 官方镜像当前以 65532:65532 运行。更换镜像时先核对镜像的 User。
chown 65532:65532 secrets/tunnel-token
chmod 400 secrets/tunnel-token
docker compose config --quiet
docker compose up -d
```

Compose 文件引用令牌文件，令牌不放在 YAML、`.env` 或命令行参数里。
Docker Compose 的本地文件 secret 使用 bind mount，因此文件所有权需要允许容器用户读取；
不要依赖 Compose secret 的 `uid`/`gid` 字段自动更改本地文件权限。

已有同名 `docker run` 容器时，先停止并改名保留，避免容器名称冲突。
新容器正常后再清理旧容器。`.env`、`secrets/` 和含令牌的旧容器配置不得提交到 Git。

## 控制台路由

在该令牌对应的 Tunnel 中配置已发布应用路由：

- 主机名：Assay 的对外域名，与 API 的 `AUTH_BASE_URL` 一致。
- 路径：留空。
- 服务 URL：`http://assay-web-1:80`；如果 Web 容器名称不同，使用实际名称。
- 同一主机名只保留所需的一条应用路由，不保留指向 `localhost` 的旧路由。
- TLS 自定义设置保持默认，浏览器仍通过 HTTPS 访问 Cloudflare。

请求经加密 Tunnel 到达同机 Web 的 HTTP 端口，再由 Web 转发 API。
Assay 对外 URL 和受信任来源保持 HTTPS。不要把服务 URL 改为 `https://...:80`。

## 检查和维护

```bash
cd /data/cloudflared
docker compose ps
docker compose logs --since 10m --tail 100
```

日志应出现 `Registered tunnel connection`，应用路由应指向正确的 HTTP 服务。
`Unauthorized: Tunnel not found` 需要核对 Tunnel 是否存在以及令牌是否已轮换；
`Failed to refresh DNS local resolver` 需要从容器网络检查 DNS。
当前显式 DNS 保留 Docker 内部服务发现，并避免继承主机 VPN 的 DNS 设置。

`latest` 只在显式拉取时可能变化，`--no-autoupdate` 关闭容器内自动更新。
如需固定版本，可以通过 `.env` 的 `CLOUDFLARED_IMAGE` 指定官方版本标签。
升级时先保留当前镜像引用，再执行 `docker compose pull && docker compose up -d` 并验收。

轮换令牌后，可在服务器终端运行 `sudo python3 /data/cloudflared/update-token.py`。
工具会隐藏令牌输入，更新当前 Compose 引用的令牌文件并保留文件所有权，
重启该连接器后等待 Tunnel 就绪；其他 Assay 服务不会重启。
手动更新令牌文件时需保持容器用户可读，再执行 `docker compose restart cloudflared`。
Tunnel 就绪后仍需验证已发布应用路由、DNS 和公网访问。
回退时停止新 Compose 服务，再将保留的旧容器改回原名称并启动；
已撤销的旧令牌不能用于恢复连接。
