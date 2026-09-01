# 工单管理系统 (Assay Ticket System)

前后端分离的工单管理系统。前端 React + Vite，后端 NestJS + Prisma + PostgreSQL，附件走 RustFS（S3 兼容），会话用 better-auth + Redis。

- 设计文档：[docs/01-设计文档.md](docs/01-设计文档.md)
- 开发计划：[docs/02-开发计划.md](docs/02-开发计划.md)
- 技术调研：[docs/03-技术调研结论.md](docs/03-技术调研结论.md)
- **REST API 文档**：[docs/04-API.md](docs/04-API.md)（49 个接口，含认证方式与调用示例）

## 目录结构

```
apps/api   NestJS 后端（Prisma / 存储抽象 / 健康检查）
apps/web   React 前端（Vite / Tailwind v4 / TanStack Query）
docker-compose.dev.yml     开发环境：pg + redis + rustfs + adminer + mailpit + api + web（热更新）
docker-compose.yaml        独立部署模板：直接暴露端口，CI 冒烟测试也用这份
docker-compose.traefik.yaml 生产实际在跑的那份（Traefik 路由 + 自动证书）
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

表结构会在 api 容器启动时自动同步（`prisma db push`）并灌入种子数据。
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
admin@example.com / admin12345
```

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

### 发版（GitHub Actions 自动完成）

推送**只跑测试**（类型检查 + 编译 + 整栈冒烟测试），不会自动发版。
发版一律手动触发，跑完整流水线：**测试 → 构建镜像 → 双仓库推送 → 部署 → 健康校验**，
健康校验失败自动回滚到上一版本。

```bash
gh workflow run ci-cd.yml                          # 发版并部署
gh workflow run ci-cd.yml -f image_tag=1.3.0       # 指定版本号
gh workflow run ci-cd.yml -f skip_deploy=true      # 只推镜像不部署
gh run watch                                       # 跟踪进度
```

镜像同时推送到两处：

| 仓库 | 地址 | 用途 |
|---|---|---|
| 阿里云 ACR | `registry.cn-shenzhen.aliyuncs.com/willspace/assay-{api,web}` | 生产服务器拉取（国内，秒级） |
| Docker Hub | `willdockerhub/assay-{api,web}` | 对外分发 |

生产默认从 ACR 拉取；想改用 Docker Hub 就在 `.env` 里加 `REGISTRY=willdockerhub`。

> **改 compose 要当心**：流水线只做 `docker compose pull && up -d`（只换镜像），
> 不会自动同步 compose 文件——这是有意为之。生产用的是 `docker-compose.traefik.yaml`
> 那套卷名（`pg-data` 等），而 `docker-compose.yaml` 用的是 `*-prod` 卷名；
> 拿后者覆盖服务器会挂载一组空卷，看起来就像数据全没了。同步前务必先 diff。

需要的 GitHub Secrets：`DOCKERHUB_USERNAME` `DOCKERHUB_TOKEN` `ACR_URL` `ACR_USERNAME` `ACR_PASSWORD`
`DEPLOY_HOST` `DEPLOY_USER` `DEPLOY_SSH_KEY` `DEPLOY_KNOWN_HOSTS` `DEPLOY_PUBLIC_URL`。

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

## 当前进度

- [x] P0 骨架 + docker compose 一键起
- [x] P1 认证(better-auth + 服务端 Session/Redis) + RBAC + 用户/队列管理
- [x] P2 工单核心(建单/列表/详情/编辑) + 状态机 + 指派 + 消息时间线(public/internal) + 审计
- [x] P3 富文本(Tiptap+Markdown) + 附件(RustFS) + 双端 XSS 消毒 + 操作历史时间线
- [x] P4 站内通知(铃铛/未读) + SLA 超时提醒(BullMQ) + 优先级升级 + SLA 倒计时徽章
- [x] P5 仪表盘统计 + 保存筛选视图 + 深色模式 + 管理员删除工单
- [x] P6 生产打包:多阶段镜像 + Nginx 单域名反代 + Prisma 迁移 + 备份脚本
