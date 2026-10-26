# GreenStor COP

GreenStor Company Operations Platform（公司运营服务平台）。在现有 Assay 工单系统基础上增量增加资产、备品备件、库存和组织管理。现有认证/MFA、工单、分享与 CLI/MCP 接口保持兼容；请假、报销的业务与审批扩展协议已预留，本期未实现对应流程。

- [改造方案与实施计划](docs/cop/01-改造方案与实施计划.md)
- [开发验证与运维](docs/cop/02-开发验证与运维.md)
- [API 与扩展约定](docs/cop/03-API与扩展约定.md)
- [OIDC 企业登录与 Keycloak 配置](docs/04-OIDC企业登录.md)

以下为沿用的 Assay 工单模块与基础部署说明；COP 的迁移/导入注意事项以以上文档为准。

# 工单管理系统 (Assay Ticket System)

前后端分离的工单管理系统。前端 React + Vite，后端 NestJS + Prisma + PostgreSQL，附件走 RustFS（S3 兼容），会话用 better-auth + Redis。

- 设计文档：[docs/01-设计文档.md](docs/01-设计文档.md)
- 开发计划：[docs/02-开发计划.md](docs/02-开发计划.md)
- 技术选型讨论：[docs/00-工单系统技术选型.md](docs/00-工单系统技术选型.md)
- 技术调研：[docs/03-技术调研结论.md](docs/03-技术调研结论.md)
- **REST API 文档**：[docs/04-API.md](docs/04-API.md)（49 个接口，含认证方式与调用示例）
- **CLI 与 MCP 文档**：[docs/06-Assay CLI.md](docs/06-Assay%20CLI.md)（安装、命令参数、`assay update`、本地 MCP）
- **工单分享链接**：[docs/08-工单分享链接实现与运维.md](docs/08-工单分享链接实现与运维.md)（外部只读分享、权限边界、安全与运维）
- **部署文档**：[docs/05-部署文档.md](docs/05-部署文档.md)（IP 直连 / Traefik / Cloudflare Tunnel，含备份与排错）

## 目录结构

```
apps/api   NestJS 后端（Prisma / 存储抽象 / 健康检查）
apps/web   React 前端（Vite / Tailwind v4 / TanStack Query）
docker-compose.dev.yml     开发环境：pg + redis + rustfs + adminer + mailpit + api + web（热更新）
docker-compose.yaml        独立部署模板：直接暴露端口，CI 冒烟测试也用这份
deploy/aliyun/docker-compose.yaml 阿里云环境应用栈（Traefik 路由，保留生产卷名）
deploy/aliyun/traefik.compose.yaml 公共代理的可选初始化模板（已有代理不覆盖）
deploy/aliyun-Cloudflare-Tunnel/ 阿里云 Tunnel 应用栈、独立连接器与安装说明
```

## 快速开始（开发环境一键拉起）

前置：Docker + Docker Compose。开发用 `docker-compose.dev.yml`：

```bash
cp .env.example .env      # 首次
docker compose -f docker-compose.dev.yml up -d --build
```

启动后：

| 服务 | 地址 |
|------|------|
| 前端 Web | http://localhost:5173 |
| 后端 API 健康检查 | http://localhost:3000/health |
| Adminer（数据库） | http://localhost:8090 |
| RustFS 控制台 | http://localhost:9101 |

> 端口在 `.env` 里可改。默认已避开常见占用：postgres 主机端口 5433、adminer 8090、
> RustFS 9100/9101（容器间仍走内部 `rustfs:9000`，不受主机端口影响）。

API 容器启动时执行 `prisma migrate deploy` 并灌入种子数据；COP 的编号 sequence 和库存约束必须通过迁移安装。历史仅使用 `db push` 的数据库升级前须备份、校验并建立迁移基线，见 [COP 运维说明](docs/cop/02-开发验证与运维.md)。
`/health` 返回 `{"status":"ok","db":"up","storage":"s3"}` 即表示全链路就绪。

### 初始化数据（seed）

种子数据（角色/权限/admin/默认队列/类型/分类）在 api 容器**首次启动时自动灌入**，幂等，可重复执行。
如需手动重跑：

```bash
docker compose -f docker-compose.dev.yml exec api pnpm db:seed
```

## 常用命令（开发）

```bash
docker compose -f docker-compose.dev.yml logs -f api   # 看后端日志
docker compose -f docker-compose.dev.yml logs -f web   # 看前端日志
docker compose -f docker-compose.dev.yml down          # 停止
docker compose -f docker-compose.dev.yml down -v       # 停止并清空数据卷
```

## 登录

默认管理员账号（在 `.env` 的 `ADMIN_EMAIL/ADMIN_PASSWORD` 配置，api 启动时自动创建）：

```
admin@example.com / 你在 .env 中设置的 ADMIN_PASSWORD
```

生产环境必须显式设置 `ADMIN_PASSWORD`（缺失时 API 拒绝启动）；本地开发不设置时会生成一次性随机密码，见 api 启动日志中的 `AuthBootstrap` 警告。

登录后可在「用户管理」创建其他角色（handler / supervisor / requester）用户。

## 邮件通知

站内信之外，可配置 SMTP 让"被指派 / 有回复 / 工单超时"等事件同时发邮件（`.env` 填 `SMTP_HOST` 等；不配则只发站内信）。
开发环境内置 **Mailpit** 邮件捕获器：外发邮件都进它，UI 查看 <http://localhost:8025>（不真正外发）。

## 生产部署

单域名部署：Nginx 托管前端静态资源，并把 `/api/` 反代到后端；前端 SPA 路由与 API 通过 `/api` 前缀隔离。
生产 `docker-compose.yaml` **直接拉取 Docker Hub 预构建镜像**，无需在服务器上构建：

- `willdockerhub/assay-api`（后端）
- `willdockerhub/assay-web`（前端 + Nginx）

```bash
cp .env.prod.example .env      # 填入强密码 / 密钥 / PUBLIC_URL
docker compose up -d           # 默认读取 docker-compose.yaml，拉取镜像启动
```

- 访问：`http://<PUBLIC_URL>`（默认 `WEB_PORT=8088`）
- 首次启动自动执行数据库迁移（`prisma migrate deploy`）+ 灌种子 + 创建管理员
- 仅 `web:80` 对外暴露；postgres / redis / rustfs 均为内部服务
- 镜像版本可用 `IMAGE_TAG` 覆盖（默认 `latest`，另有 `1.1.0`）
- 备份：`bash scripts/backup.sh`（导出数据库 + 打包附件卷）

### 阿里云环境

Traefik 应用栈放在 [deploy/aliyun/docker-compose.yaml](deploy/aliyun/docker-compose.yaml)，环境变量模板为 [deploy/aliyun/.env.example](deploy/aliyun/.env.example)。安装到服务器时分别复制为 `/data/assay/docker-compose.yaml` 与 `/data/assay/.env`。

阿里云只填 `PUBLIC_DOMAIN`，Compose 推导 HTTPS 的 `PUBLIC_URL`、`AUTH_BASE_URL` 和 `APP_URL`；信任来源显式使用 `.env` 中的 `AUTH_TRUST_ORIGINS`，可选旧域名由 `LEGACY_PUBLIC_DOMAIN` 配置。没有生产域名写死在模板里。阿里云 API 日常启动仅迁移数据库并启动服务；全新空库需要显式执行一次 `docker compose exec api node dist/seed.js`，升级时不运行 seed。

现有部署更新模板前先备份、比较数据卷及镜像；在 `.env` 设置当前 `POSTGRES_IMAGE`、`REDIS_IMAGE`、`RUSTFS_IMAGE` 完整引用，避免本机同名标签漂移或使用模板默认值降级。公共 Traefik 是另一个项目，已有代理保持原配置与证书卷。具体步骤见 [部署文档 §2](docs/05-部署文档.md#2-阿里云环境traefik--域名--自动-https)。

Cloudflare Tunnel 接入使用独立目录 [deploy/aliyun-Cloudflare-Tunnel](deploy/aliyun-Cloudflare-Tunnel/README.md)，包含无主机端口的应用栈、连接器和令牌更新工具。说明覆盖 `ticket.greenstor.ai` 入口和现有生产卷的迁移方式。

### 本地 CI 与备用发布

GitHub Actions 额度不可用时，使用根目录 `Taskfile.yml`：`task ci VERSION=1.3.11` 完成测试和构建，`task publish VERSION=1.3.11` 推送 Docker Hub 并发布 GitHub Release。生产部署是单独的 `task deploy:production`，不会由发布任务自动触发。安装、参数、产物和回滚步骤见 [本地 CI 说明](scripts/local-ci/README.md)。

### 发版（GitHub Actions 自动完成）

推送**只跑测试**（类型检查 + 编译 + 整栈冒烟测试），不会自动发版。
发版一律手动触发，跑完整流水线：**测试 → 构建镜像 → 双仓库推送 → 部署 → 健康校验 → 构建 CLI → 创建 GitHub Release**，
健康校验失败自动回滚到上一版本。

```bash
gh workflow run ci-cd.yml -f release_version=1.3.10                    # 统一发版：镜像、部署、CLI、GitHub Release
gh workflow run ci-cd.yml -f image_tag=1.3.10 -f skip_deploy=true      # 仅构建推送指定镜像，不部署或创建 Release
gh workflow run ci-cd.yml -f skip_deploy=true                         # 用 commit SHA 标记镜像，仅推送不部署
gh run watch                                       # 跟踪进度
```

镜像同时推送到两处：

| 仓库 | 地址 | 用途 |
|---|---|---|
| 阿里云 ACR | `registry.cn-shenzhen.aliyuncs.com/willspace/assay-{api,web}` | 生产服务器拉取（国内，秒级） |
| Docker Hub | `willdockerhub/assay-{api,web}` | 对外分发 |

生产默认从 ACR 拉取；想改用 Docker Hub 就在 `.env` 里加 `REGISTRY=willdockerhub`。

> **改 compose 要当心**：流水线只做 `docker compose pull && up -d`（只换镜像），
> 不会自动同步 compose 文件——这是有意为之。阿里云环境使用 `deploy/aliyun/docker-compose.yaml`
> 那套卷名（`pg-data` 等），而 `docker-compose.yaml` 用的是 `*-prod` 卷名；
> 拿后者覆盖服务器会挂载一组空卷，看起来就像数据全没了。同步前务必先 diff。

需要的 GitHub Secrets：`DOCKERHUB_USERNAME` `DOCKERHUB_TOKEN` `ACR_URL` `ACR_USERNAME` `ACR_PASSWORD`
`DEPLOY_HOST` `DEPLOY_USER` `DEPLOY_SSH_KEY` `DEPLOY_KNOWN_HOSTS`。站点地址从运行中的 API 配置读取，不再另设域名 Secret。

手动构建（应急用）：

```bash
docker build -t willdockerhub/assay-api:latest ./apps/api
docker build -t willdockerhub/assay-web:latest --build-arg VITE_API_BASE_URL="" ./apps/web
# 服务器上： docker compose pull && docker compose up -d
```

## 镜像体积

| 镜像 | 说明 | 体积 |
|---|---|---|
| `assay-web` | 前端静态文件 + Nginx（Bun 1.4.0 构建，nginx alpine-slim） | **20.7 MB** |
| `assay-api` | NestJS 服务（Node 运行时 + Prisma 引擎） | **651 MB** |

生产环境务必修改：`POSTGRES_PASSWORD`、`S3_ACCESS_KEY/SECRET_KEY`、`AUTH_SECRET`、`ADMIN_PASSWORD`。

## 国际化

界面支持四种语言，默认英文，用户选择保存在浏览器：English / 简体中文 / 繁體中文 / ไทย。
切换器在登录页右上角与登录后顶部导航栏右侧。

## 两步验证

用户可在「设置 → 安全」启用验证器应用（TOTP），登录时需输入动态码，也支持一次性恢复码。部署要求与操作细节见 [两步验证与验证器使用](docs/09-两步验证与验证器使用.md)。

## 当前进度

- [x] P0 骨架 + docker compose 一键起
- [x] P1 认证(better-auth + 服务端 Session/Redis) + RBAC + 用户/队列管理
- [x] P2 工单核心(建单/列表/详情/编辑) + 状态机 + 指派 + 消息时间线(public/internal) + 审计
- [x] P3 富文本(Tiptap+Markdown) + 附件(RustFS) + 双端 XSS 消毒 + 操作历史时间线
- [x] P4 站内通知(铃铛/未读) + SLA 超时提醒(BullMQ) + 优先级升级 + SLA 倒计时徽章
- [x] P5 仪表盘统计 + 保存筛选视图 + 深色模式 + 管理员删除工单
- [x] P6 生产打包:多阶段镜像 + Nginx 单域名反代 + Prisma 迁移 + 备份脚本

### 可选 Samba 管理

Rust Agent、Web 管理与独立 IP 测试环境见 [设计方案](docs/samba/01-设计与实施计划.md)、[部署与运维](docs/samba/02-测试部署与运维.md)、[测试验收](docs/samba/03-测试验收记录.md) 和 [Agent 文档](agents/samba/README.md)。默认不启用 Samba 集成，不自动接管现有域或共享。

平台管理的员工资料、用户组成员、共享目录详情及登录账号关联说明见 [交互与账号模型](docs/samba/04-平台管理交互与账号模型.md)。
