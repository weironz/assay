# Issue #22 配置集中化：方案对比与实施记录

> 本文是实施前的设计记录（工单评论草稿）。仓库内不提交 `.env` 或任何凭据。

## 现状

- `apps/api/src` 约 33 个文件、100+ 处直接读 `process.env`；
- `ConfigModule.forRoot({ isGlobal: true })` 只加载 `.env`，没有 `validate`；
- `AUTH_TRUST_ORIGINS` 的 `http://localhost:5173` 默认值在 8 处重复；
- S3 凭据在 `s3.storage.ts` 与 `health.controller.ts` 各自回退公开的
  `rustfsadmin/rustfsadmin`；
- 同一批环境变量在业务代码、健康检查、模块初始化之间各自解析，配置漂移
  无法在启动期暴露。

## 方案 A：全面改用 Nest `ConfigService` + zod `validate` + DI

做法：`ConfigModule.forRoot({ validate })` 解析 zod，所有 service 构造函数注入
`ConfigService`，控制器/模块全部改 DI。

优点：

- 最符合 Nest 惯例，便于未来替换配置源（Vault/K8s ConfigMap）；
- 天然单例、可测试（TestingModule 可覆盖 provider）。

缺点：

- 改动面过大：`auth.ts`、`mailer.ts`、`auth-redis.ts` 等在模块加载期就要用配置，
  不在 DI 容器内，必须额外包一层工厂，容易改变初始化顺序；
- 现有测试大量直接 import 函数并运行中改 `process.env`，`ConfigService` 快照
  在构造期固定，会让这些测试失效或需要大规模重写；
- 工单明确要求行为等价、小步可编译，方案 A 的风险/收益比不合适。

## 方案 B（采用）：`src/config` 集中 schema + 惰性访问器，Nest 只做启动校验

做法：

1. `src/config/schema.ts`：用仓库已有的 **zod**（`apps/api/package.json`
   已依赖 `zod@4.5.4`）定义全部环境变量的 schema，给出与旧代码一致的默认值；
   产出结构化的 `AppConfig`（api/auth/storage/mail/... 分段）。
2. `src/config/index.ts`：`getConfig()` 惰性解析并按环境变量指纹缓存，
   `validateEnv()` 供 `ConfigModule.forRoot({ validate })` 在启动期做 schema
   校验和生产敏感默认值检查；`currentEnv()` 仅作为 directory/oidc 这类
   「接收 env 便于单测」的领域解析器的默认参数。
3. 业务代码统一 `getConfig()`，不再出现 `process.env`；`app.module.ts`
   增加 `validate`：启动期做 schema 校验，生产环境缺少 `AUTH_TRUST_ORIGINS`
   或（S3 驱动下）S3 凭据时启动失败。
4. S3：非生产保留 `rustfsadmin`（本地 RustFS 兼容），生产返回 `undefined`，
   由启动校验和 `S3Storage.fromEnv()` 明确报错；健康检查复用同一份配置。

优点：

- 不改变模块加载顺序和函数签名，现有单测运行中修改 `process.env` 仍然生效
  （指纹变化会重新解析）；
- 启动期仍有 fail-fast（`ConfigModule.validate`）；
- 改动可以按文件小步迁移，每步 `tsc` 可编译；
- 无新增依赖。

缺点：

- 仍是模块内直接 import，不是 Nest DI；未来若要接远程配置源，需要再把
  `getConfig()` 换成 provider（可在后续工单做）；
- 指纹缓存需要维护 schema key 列表（已在 schema 内集中导出）。

## 结论

采用方案 B。理由：在满足「集中 schema 校验 + 单一读取入口 + 生产默认值消除 +
`.env` 兼容」的前提下，改动面最小、对现有测试和初始化顺序最友好，符合
「行为等价、小步走」的约束。

## 实施记录

1. **唯一入口**：`apps/api/src/config/schema.ts` 用 zod 4 定义全部核心环境变量，
   产出 `AppConfig`（api/app/auth/directory/samba/files/redis/storage/mail/admin/netbox）；
   `apps/api/src/config/index.ts` 提供 `getConfig()`、`validateEnv()`、`currentEnv()`，
   并按 `CONFIG_ENV_KEYS` 的值指纹缓存——运行中改 `process.env` 会重新校验，
   现有单测/热重载行为不变。
2. **启动期校验**：`AppModule` 的 `ConfigModule.forRoot({ isGlobal: true, validate: validateEnv })`
   在启动时执行 schema 校验与 `assertProductionConfig`；失败直接拒绝启动。
3. **全部读取点迁移**：业务代码不再出现 `process.env`（tickets 域除外，见下），
   统一使用 `getConfig()`；需要保持 `(env)` 参数签名的领域解析器使用
   `currentEnv()` 作为默认值。
4. **生产敏感默认值**：
   - S3 凭据：非生产保留 `rustfsadmin` 以兼容本地 RustFS；生产返回 `undefined`，
     由 `assertProductionConfig` 与 `S3Storage.fromEnv()` 双重拒绝；
   - `AUTH_TRUST_ORIGINS`：生产必须显式配置，禁止静默回退 localhost；
   - `AUTH_SECRET`：生产缺失、过短、命中公开占位值或明显低熵时拒绝启动；
     非生产保留重构前的 `dev_secret_change_me` 兜底，本地会话不因升级失效。
5. **`.env` 兼容**：`ConfigModule` 仍负责加载 `.env`；schema 的默认值与旧代码
   逐项对齐（空串按「未配置」处理、开关只认 `'true'`、端口/时长非法值退回默认）。
6. **测试**：新增 `test/config.spec.ts`（默认值、生产校验、来源规范化、热重载）
   与 `test/auth-secret.spec.ts`（生产密钥强度）。

## 未纳入 zod schema 的领域解析器（保持原签名）

`directory-config.ts`、`oidc-config.ts`、`login-policy.ts` 的入参是
`env: NodeJS.ProcessEnv = currentEnv()`：现有测试会直接传入构造出来的 env 对象
（如 `readOidcSettings({...})`），并入 `getConfig()` 会破坏这些签名。这些变量
仍由各自的 fail-closed 校验处理（`required()`、LDAPS/HTTPS 限制等），只是读取
入口统一走 `currentEnv()`，不再直接出现 `process.env`。第二批可将其收编进
schema，并同步调整单测。

## 并行车道避让

`tickets.service.ts` 及其可见性相关文件正在另一车道重构。本次跳过：

- `src/tickets/tickets.service.ts`（当前无 `process.env`）
- `src/tickets/meta.controller.ts`（`DIRECTORY_AUTH_ENABLED` 读取点保留）
- `src/stats/stats.module.ts`（可见性注释）
- `src/attachments/visibility.ts`
- `src/ticket-shares/ticket-shares.service.ts`

待第二波把这几个文件并入统一配置入口。

## 验证方式

```bash
cd apps/api
npx tsc --noEmit          # 类型检查（等价于 nest build 的 tsc 阶段）
pnpm test                 # node --test + ts-node/transpile-only 全量单测
```

重点回归：`test/config.spec.ts`、`test/auth-secret.spec.ts`、`test/health.spec.ts`
（健康检查复用集中配置）、`test/storage-init.spec.ts`、`test/files-session.test.cjs`
（运行中改 `process.env` 后配置重新生效）。

