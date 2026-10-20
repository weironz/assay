# Assay / GreenStor COP 企业 OIDC 登录

支持一个由运维配置的标准 OIDC 身份提供方，包括 Keycloak。后端使用 `openid-client` 6.8.8 的 Authorization Code Flow，启用 S256 PKCE、浏览器绑定的 state、nonce、ID Token 签名/JWKS、issuer、audience 和有效期校验。浏览器只获得现有 Better Auth httpOnly 会话 Cookie，会话继续保存在 Redis；不向前端返回、也不在 accounts 表保留 IdP access/refresh/ID token。

## 配置

默认关闭，未配置时登录页不显示企业登录按钮，本地账号登录照常工作。仅在后端 `.env` 设置，不使用 `VITE_` 变量保存任何密钥：

```dotenv
AUTH_BASE_URL=https://assay.example.com
AUTH_TRUST_ORIGINS=https://assay.example.com
OIDC_ENABLED=true
OIDC_ISSUER_URL=https://sso.example.com/realms/company
OIDC_CLIENT_ID=assay
OIDC_CLIENT_SECRET=<在本地配置客户端密钥，不提交>
OIDC_DISPLAY_NAME=企业账号
OIDC_AUTO_PROVISION=true
OIDC_EMAIL_DOMAINS=example.com
OIDC_TOKEN_AUTH_METHOD=client_secret_basic
```

`AUTH_BASE_URL` 是浏览器可访问的 API 根源站，不带 `/api/auth`。前后端同域时使用站点的 HTTPS 地址；开发前后端分离时使用实际 API 地址，并将 Web 源站列入 `AUTH_TRUST_ORIGINS`。可信源必须是精确 origin，不接受通配符、路径或 query。反向代理须保留 `/api/auth/*` 路由及原有安全 Cookie/CORS 配置。

`OIDC_ISSUER_URL` 填 realm 的 issuer，不是 discovery、授权或 token endpoint URL。Discovery 自动取得端点。开启但缺少必需配置会阻止启动；身份服务临时不可达时只拒绝企业登录，已运行的本地登录保持可用，并可重试 discovery。

生产必须使用 HTTPS。仅本机开发/测试可同时设置 `NODE_ENV=development` 和 `OIDC_ALLOW_HTTP=true`，使用 localhost/127.0.0.1/[::1] 的 HTTP IdP；生产和非 loopback HTTP IdP 不接受此开关。客户端使用服务端 confidential client，支持 `client_secret_basic`（默认）或 `client_secret_post`。

## Keycloak 设置

1. 在目标 realm 创建 OpenID Connect client，Client ID 与 `OIDC_CLIENT_ID` 一致，开启 Client authentication 和 Standard flow。
2. 使用 Authorization Code Flow，配置 PKCE S256；不需要 Implicit flow、Direct access grants 或 service account。
3. Valid redirect URIs 只填写精确地址：`https://assay.example.com/api/auth/oidc/callback`。开发使用实际 `AUTH_BASE_URL` 对应的同一路径，不使用 `*`。
4. 保留 `openid`、`email`、`profile` scopes。用户须有 email，且 `email_verified` 为布尔值 true；LDAP 联邦用户须由企业流程确认邮箱归属，再配置相应验证状态，不盲目将任意来源邮箱标为可信。
5. 若只允许公司邮箱，配置 `OIDC_EMAIL_DOMAINS`；多个域逗号分隔，匹配完整域名。留空代表接受该 IdP 返回的所有已验证邮箱。
6. Client secret 放入后端配置，并重建/重启 API。企业登录成功后返回 `/dashboard`。

后端与浏览器均需能解析和访问 IdP 公网/内网域名，后端还需访问 discovery、token、JWKS 和 UserInfo。配置完成后用真实账号复测。

## 账号、关联和权限

- 身份主键为 issuer 对应的 providerId + IdP 的稳定 `sub`，不会因为邮箱或显示名变动创建第二个用户。更换 issuer（包括 realm）属于新的身份来源，不复用旧关联；不要随意重命名 issuer URL。
- 首次新身份登录在一个数据库事务中创建本地用户、OIDC 关联和固定 `requester` 角色。忽略 IdP 的组/角色 claims；管理员继续在 Assay 分配业务权限。
- `OIDC_AUTO_PROVISION=false` 时不创建用户，只允许已关联身份登录。
- 同邮箱本地账号不会自动合并。先使用本地账号登录并完成邮箱验证，在“个人设置 → 安全 → 企业账号”点击“关联企业账号”，通过现有密码/TOTP 安全验证，再登录同邮箱企业账号。
- 关联操作使用有效 Web 会话和受信 Origin，不再额外弹出密码/TOTP 验证（2026-10-20 更新）。旧客户端显式传 step-up ticket 时仍只能使用一次。回调同时校验原网页登录会话、用户状态与撤销版本；邮箱不一致、身份已关联他人、会话过期或账号停用都会拒绝。
- 已开启本地 TOTP/恢复码的账号，在 OIDC 验证后仍需完成本地 MFA，再获得 Assay 会话。IdP 的 MFA 策略由 Keycloak 配置，本期不会用未经策略约定的 `amr`/`acr` 自动替代本地 MFA。
- 纯 OIDC 新账号没有本地密码。权限内的业务操作依赖已认证会话和实时 RBAC，无需为了额外操作验证另设本地密码；登录 MFA 和可选特权 MFA 准入策略不变。账号设置中 Better Auth 本身要求的密码输入不应通过伪造密码绕过。

## 会话和当前范围

本地停用、密码变更/重置与 Redis/持久化 session epoch 撤销机制继续生效。OAuth state 在服务端保存、绑定浏览器 Cookie、限时有效；回调有额外原子防重放保护。错误跳转只带固定错误标志，不携带 IdP 原始错误、令牌或用户资料。登录落地地址仅允许可信 Web origin 的 `/dashboard`；关联回到 `/settings`。

退出登录只注销 Assay 会话，不注销 IdP 的全局 SSO 会话；再次企业登录可能直接登录，符合本期本地退出语义。本期未实现 RP/back-channel logout、AD/LDAP 用户同步、IdP 停用事件导致的即时本地会话撤销、用户组到业务角色映射或 AD/文件 ACL 管理。仅在 IdP 停用账号不会自动撤销已存在的 Assay 会话；需同时在 Assay 停用，后续可增加生命周期联动。

## 升级和验证

先备份数据库，再执行 `prisma migrate deploy`。新迁移为 accounts 的 `(providerId, accountId)` 增加唯一索引，防止并发首次登录产生重复身份。若旧数据存在重复身份，迁移会明确失败，应调查、确认归属后处理；迁移不自动删除或合并账号。

OIDC 集成测试使用独立 PostgreSQL 库，名字必须以 `_oidc_test` 结尾，禁止配置成真实业务库。部署全部迁移、生成 Prisma Client 后执行：

```bash
cd apps/api
OIDC_TEST_DATABASE_URL=<隔离测试库连接串> pnpm test:oidc
```

测试启动本机模拟 OIDC 服务，实际完成 discovery、签名 ID Token、JWKS、PKCE、nonce、UserInfo、账号关联和 Redis 会话，覆盖错误签名/issuer/audience/有效期/nonce、缺少 ID Token、邮箱未验证、UserInfo sub 不匹配、state/Cookie 错误、并发重放、同邮箱账号保护、step-up、账号停用、会话撤销与本地 MFA。本机测试不能代替公司 Keycloak/Samba AD 的真实联调。

2026-10-14 验证：全部 106 项 API 测试通过，零失败、零跳过；单独 `test:oidc` 的 21 项测试通过；32 项 Web 测试及前后端编译、Web 生产构建通过。使用本地构建产物、隔离数据库和模拟 IdP 做 Chromium 验证，企业入口成功落地会话、失败返回通用提示，零页面脚本错误；浏览器页面与跳转通过测试路由模拟，不访问公司的真实 IdP。开发服务健康检查正常，OIDC 默认保持关闭，待实际客户端配置后联调。

## 真实 Keycloak Compose 联调

提供独立的 `docker-compose.oidc-test.yml`，固定使用官方 Keycloak 26.8.1 镜像及 digest。它启动 Keycloak、专用 Keycloak PostgreSQL、独立 Assay PostgreSQL 和 Redis，不共享原开发环境的数据库或卷。仅绑定本机端口：8180（Keycloak）、5434（测试库）、6382（测试 Redis）。这是使用 `start-dev` 的本机联调环境，不是生产部署。

先在 Linux 主机安装 API/Web 依赖，要求支持 ESM require 的 Node 22.12+、pnpm、Bun 和 Docker Compose。从仓库根目录执行：

```bash
node apps/api/scripts/setup-keycloak-test.cjs .oidc-test
docker compose --env-file .oidc-test/compose.env -f docker-compose.oidc-test.yml up -d
node --env-file=.oidc-test/assay.env apps/api/scripts/start-keycloak-test.cjs .oidc-test
node --env-file=.oidc-test/assay.env apps/api/scripts/test-keycloak.cjs .oidc-test
```

配置生成器随机生成客户端密钥、管理员与测试账号密码，保存在被 Git 忽略的 `.oidc-test/`，文件权限 0600；不会打印凭据。不要提交 `realm.json`、env 文件或 `fixtures.json`。realm 挂载文件须能被 Keycloak 容器的 UID 1000 读取。重复运行配置生成器保留已有凭据，避免 realm 导入跳过已存在 realm 后客户端密钥不一致。

启动脚本在私有目录编译隔离的 API，执行测试库迁移与 seed，API 使用 3190，独立 Web 使用 5190；不覆盖正常开发服务的 dist 或 `.env`。等待 Keycloak discovery、API `http://localhost:3190/health` 和 Web `http://localhost:5190/api/auth/oidc/provider` 就绪后运行测试。Web 页为 `http://localhost:5190`，Keycloak 为 `http://localhost:8180`。远程云环境需要将两个端口一起转发到本机，保持 localhost issuer 与回调地址一致；不要仅更换浏览器 URL。

联调脚本通过真实 HTTP 请求提交 Keycloak 登录表单，再经真实 API 完成回调、签名/JWKS/UserInfo 校验、账号关联和 MFA。没有模拟身份服务、授权码或令牌。脚本只操作生成的 `assay-test` realm 和以 `_oidc_test` 结尾的隔离数据库；会重新建立隔离库中的生成账号，不用于真实业务数据。它保留原登录限流，触发 429 时遵守正常重试窗口，并在测试管理员 token 过期后重新认证。

使用停止脚本终止自己创建的 API/Web 进程；它会核对 PID 对应的进程，拒绝停止无关进程。再关闭独立 Compose 服务，默认保留测试数据库卷：

```bash
node apps/api/scripts/stop-keycloak-test.cjs .oidc-test
docker compose --env-file .oidc-test/compose.env -f docker-compose.oidc-test.yml down
```

Keycloak 的版本和容器参数参考 [官方镜像文档](https://www.keycloak.org/server/containers) 与 [官方下载页](https://www.keycloak.org/downloads)。

2026-10-14 真实联调：15 项检查全部通过，覆盖实际登录表单、授权码/token/JWKS/UserInfo、Redis/httpOnly 会话、外部角色不能提升本地权限、Keycloak SSO 会话复用、state/Cookie/回调重放保护、同邮箱本地账号保护、真实密码 step-up 关联、TOTP 绑定与 OIDC 后本地 MFA、恢复码不可复用、未验证/域外邮箱拒绝、本地停用即时撤销、IdP 停用拒绝新登录、强制 PKCE、错误客户端密钥拒绝以及本地退出后的 IdP SSO 语义。Keycloak 缺少 PKCE 时可以通过带 error 的 302 回调拒绝请求，测试同时校验没有返回 code 且 Assay 拒绝登录。

启动、停止、重新启动及重复迁移/seed 已验证；原开发服务继续使用原数据库、端口和配置，OIDC 仍为关闭状态。私有测试配置、结果和日志位于当前云工作区 `/workspace/assay-cloud/keycloak-test`，不随代码提交。**在 Keycloak 停用账号不会立即注销已存在的 Assay 会话**，本期尚未实现停用事件/back-channel logout；需在 Assay 同时停用或撤销会话。该边界已通过真实 Keycloak 验证。
