# 阿里云 + Cloudflare Tunnel 部署

此目录对应 `https://ticket.greenstor.ai` 使用的 Tunnel 接入方式。域名、镜像、网络、
令牌文件和连接器名称均通过环境变量配置，生产值不写入 Compose 模板。

```text
浏览器 HTTPS → Cloudflare → 加密 Tunnel → cloudflared
                                         ↓ HTTP / Docker 网络
                                     Assay Web → API
```

| 文件 | 用途 | 安装位置示例 |
| --- | --- | --- |
| `docker-compose.yaml`、`.env.example` | Assay 应用栈，包含数据库、缓存、附件存储、API、Web | `/data/assay` |
| `cloudflared/docker-compose.yaml`、`cloudflared/.env.example` | 独立的 Tunnel 连接器项目 | `/data/cloudflared` |
| `cloudflared/update-token.py` | 隐藏输入并更新本地令牌文件，重启及检查连接器 | 连接器目录 |

应用栈保留 `name: assay` 和 `pg-data`、`redis-data`、`rustfs-data` 卷名。
Web 不发布主机端口，显式关闭本模板中的 Traefik 自动发现，由连接器访问容器的 80 端口。
`deploy/aliyun` 仍用于 Traefik 接入方式。

## 1. 全新安装

以下命令从仓库根目录执行，目录均为安装示例；已有生产环境先阅读第 3 节。

```bash
install -d -m 700 /data/assay /data/cloudflared
install -m 644 deploy/aliyun-Cloudflare-Tunnel/docker-compose.yaml /data/assay/docker-compose.yaml
install -m 600 deploy/aliyun-Cloudflare-Tunnel/.env.example /data/assay/.env
install -m 644 deploy/aliyun-Cloudflare-Tunnel/cloudflared/docker-compose.yaml /data/cloudflared/docker-compose.yaml
install -m 600 deploy/aliyun-Cloudflare-Tunnel/cloudflared/.env.example /data/cloudflared/.env
install -m 644 deploy/aliyun-Cloudflare-Tunnel/cloudflared/update-token.py /data/cloudflared/update-token.py
```

编辑 `/data/assay/.env`，设置强密码、`AUTH_SECRET`、管理员资料和实际镜像版本。
主域名示例：

```dotenv
PUBLIC_DOMAIN=ticket.greenstor.ai
AUTH_TRUST_ORIGINS=https://${PUBLIC_DOMAIN}
CLOUDFLARED_NETWORK=assay-tunnel
```

连接器 `.env` 的 `CLOUDFLARED_NETWORK` 必须相同。新安装创建一次这个外部网络，
子网必须包含连接器固定地址（默认 `172.31.10.10`，与 web 镜像 nginx.conf 的
`set_real_ip_from` 条目一一对应）：

```bash
docker network create --subnet 172.31.10.0/24 assay-tunnel
cd /data/assay
docker compose config --quiet
docker compose up -d
# 仅全新空数据库初始化一次；已有生产库升级或重启不执行 seed。
docker compose exec api node dist/seed.js
```

既有部署的外部网络无法改子网时，把连接器 `.env` 的 `CLOUDFLARED_FIXED_IP` 设为
`docker network inspect` 查到的实际地址，并同步维护 web 的 nginx.conf；
否则登录限流会因所有流量共用一个来源 IP 而退化为全站共享配额。

应用从 `PUBLIC_DOMAIN` 推导 HTTPS 的 `PUBLIC_URL`、`AUTH_BASE_URL`、`APP_URL`。
不另外配置 `PUBLIC_URL`。`AUTH_TRUST_ORIGINS` 从 `.env` 传入。

## 2. 创建并连接 Tunnel

在 Cloudflare 控制台创建 Tunnel，使用该 Tunnel 当前有效的令牌。
按 [连接器说明](cloudflared/README.md) 将令牌保存到本地受限文件并启动连接器。
令牌不放进 Git、Compose YAML、`.env` 或命令行参数。

控制台添加已发布应用路由：

| 配置项 | 示例 |
| --- | --- |
| 主机名 | `ticket.greenstor.ai` |
| 路径 | 留空 |
| 服务 URL | `http://assay-web-1:80` |
| DNS | 指向该 Tunnel，启用代理；通常添加路由时自动创建 |

`assay-web-1` 来自本模板的项目名和 Web 服务名；项目名变化时填写实际容器名称。
服务 URL 使用 HTTP，浏览器和 Assay 的对外地址仍使用 HTTPS。
域名的 SSL/TLS 可设为“完整（严格）”，不得配置将 HTTPS 降级为 HTTP 的重定向。
既有同名 DNS 记录冲突时只核对并替换该条记录，不修改其他业务域名。

```bash
cd /data/cloudflared
docker compose ps
docker compose logs --since 10m --tail 100
```

看到 `Registered tunnel connection` 说明连接器注册成功；还需确认日志已收到正确的
`hostname` / `service` 路由，并从公网检查页面、登录请求和附件操作。
`/api/me` 未登录时返回 401 属于正常认证行为。

## 3. 从现有阿里云部署切换模板

已经通过 Tunnel 正常访问的生产服务器，不需要仅因仓库新增目录而重建服务。
服务器活动配置仍在原 `/data/assay`、`/data/cloudflared`，本目录是可复用的安装模板。

需要替换应用模板时：

1. 按 [备份文档](../../docs/05-部署文档.md) 备份数据库、附件卷及原 Compose / `.env`，核对恢复办法。
2. 保留活动部署目录、项目名、数据卷名、数据库及对象存储凭据、`AUTH_SECRET`、当前镜像引用。
   `.env.example` 只供对照，不覆盖生产 `.env`。
3. 现有 Web 和连接器若已使用 `traefik-network`，在两份 `.env` 中将
   `CLOUDFLARED_NETWORK=traefik-network`，复用该网络，不更改其他应用的网络。
4. 先用 `docker compose config --quiet` 校验，再对比解析后的卷、镜像和凭据。
   `config --format json` 包含凭据，只在服务器本地检查。
5. 只更新 API/Web：`docker compose up -d --no-deps --pull never --wait api web`。
   核对应用健康、访问域名、登录、工单及附件。

此模板的 Web 关闭 Traefik 路由，切换会移除该 Web 服务原来的直连 Traefik 入口。
若仍需同时保留 Traefik 和 Tunnel 入口，应继续使用原 `deploy/aliyun` 应用模板，
并单独使用本目录的连接器；连接器仍可直达 Web。公共 Traefik 服务无需调整。

回退时恢复原 Compose 和 `.env`，使用原镜像重建 API/Web，并检查域名路由。
应用模板切换不移动数据目录，不运行 `down -v`，不重新 seed 生产库。
令牌撤销或 Tunnel 删除需要在控制台恢复有效连接信息，恢复旧容器不能恢复已撤销的令牌。

## 4. 网络与发布

Tunnel 通过出站连接访问 Cloudflare；本模板不要求为 Web 开放主机的 80/443 端口。
需允许 Cloudflare Tunnel 的出站 DNS 和隧道连接，具体协议与端口按 Cloudflare 官方要求配置。
普通 Cloudflare 全球网络可能绕行境外，国内性能需要实际测试，不能视为国内加速方案。

GitHub Actions 继续使用部署目录的活动 `docker-compose.yaml` 更新 API/Web，
不会因新增仓库目录而自动覆盖服务器 Compose 或重启连接器。
