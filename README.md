# 工单管理系统 (Assay Ticket System)

前后端分离的工单管理系统。前端 React + Vite，后端 NestJS + Prisma + PostgreSQL，附件走 RustFS（S3 兼容），会话用 better-auth + Redis。

- 设计文档：[docs/01-设计文档.md](docs/01-设计文档.md)
- 开发计划：[docs/02-开发计划.md](docs/02-开发计划.md)
- 技术调研：[docs/03-技术调研结论.md](docs/03-技术调研结论.md)

## 目录结构

```
apps/api   NestJS 后端（Prisma / 存储抽象 / 健康检查）
apps/web   React 前端（Vite / Tailwind v4 / TanStack Query）
docker-compose.dev.yml   开发环境：pg + redis + rustfs + adminer + api + web（本地构建、热更新）
docker-compose.yaml      生产环境：拉取 Docker Hub 镜像 + Nginx 单域名
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
- 镜像版本可用 `IMAGE_TAG` 覆盖（默认 `latest`，另有 `0.1.3`）
- 备份：`bash scripts/backup.sh`（导出数据库 + 打包附件卷）

### 更新镜像（在开发机构建并推送）

```bash
docker build -t willdockerhub/assay-api:latest ./apps/api
docker build -t willdockerhub/assay-web:latest --build-arg VITE_API_BASE_URL="" ./apps/web
docker push willdockerhub/assay-api:latest && docker push willdockerhub/assay-web:latest
# 服务器上： docker compose pull && docker compose up -d
```

生产环境务必修改：`POSTGRES_PASSWORD`、`S3_ACCESS_KEY/SECRET_KEY`、`AUTH_SECRET`、`ADMIN_PASSWORD`。

## 当前进度

- [x] P0 骨架 + docker compose 一键起
- [x] P1 认证(better-auth + 服务端 Session/Redis) + RBAC + 用户/队列管理
- [x] P2 工单核心(建单/列表/详情/编辑) + 状态机 + 指派 + 消息时间线(public/internal) + 审计
- [x] P3 富文本(Tiptap+Markdown) + 附件(RustFS) + 双端 XSS 消毒 + 操作历史时间线
- [x] P4 站内通知(铃铛/未读) + SLA 超时提醒(BullMQ) + 优先级升级 + SLA 倒计时徽章
- [x] P5 仪表盘统计 + 保存筛选视图 + 深色模式 + 管理员删除工单
- [x] P6 生产打包:多阶段镜像 + Nginx 单域名反代 + Prisma 迁移 + 备份脚本
