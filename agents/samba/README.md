# Assay Samba Agent

原生 Rust 统一服务，独立于 Assay API 部署。一个镜像、一个容器、一个 Rust 进程提供管理接口和可选员工文件接口。LDAP、SMB、Windows 安全描述符、任务执行与本地共享操作均由 Rust 实现，运行时不调用 Python、Shell、`samba-tool` 或旧管理脚本。镜像为静态二进制，不包含操作系统工具。

## 连接与职责

浏览器只访问 Assay。Assay API 通过固定地址与机器令牌调用 Agent；测试 Compose 的 Agent 无宿主机端口，仅接入内部 Docker 网络。跨主机部署须为 Agent 配置 TLS 入口和 API 源地址限制，不能把明文接口开放到公司网络。

测试 Compose 使用 UID 0，drop ALL capabilities 后仅授予 `KILL` 和 `DAC_OVERRIDE`，根文件系统只读，仅受管共享、配置及操作记录目录可写；不挂载 Docker socket，不使用 host PID namespace。Agent 与目标 AD 容器共享 PID namespace，以验证固定 smbd PID 并发送 SIGHUP。本地共享配置操作在进程内串行执行，阻塞文件操作放在 blocking task，不再启动 helper 或文件网关子进程。目录创建/删除与 Windows DACL 仍通过 SMB 执行。

合并后管理凭据、受管本地目录与员工文件模块位于同一进程，这是部署简化带来的权限边界变化。两类 API 继续使用不同的服务密钥，拒绝复用同一密钥。员工文件内容只经本人 SMB 会话读取和写入，没有管理员身份或本地文件系统回退；代码级隔离不等于进程级隔离。

## 构建

```sh
cargo test --locked --manifest-path agents/samba/Cargo.toml
cargo clippy --locked --manifest-path agents/samba/Cargo.toml --all-targets -- -D warnings
docker build -t assay-samba-agent:0.1.0 agents/samba
```

标准 Dockerfile 使用 Rust 1.99 / musl。云环境可用 BuildKit `proxy_ca` secret 提供构建 CA，不写入镜像。`BUILDER_IMAGE` 可指定同版本的本地编译缓存镜像；默认仍为官方 Rust 镜像。

员工文件访问现为同一程序的内部模块，挂载在 `/files/v1/...`；管理接口保持 `/v1/...`。在管理 JSON 中增加 `files` 对象开启，不配置则不注册文件路由；Assay API 的 `FILES_ENABLED` 仍独立控制员工入口。使用同一个 `agents/samba/Dockerfile` 构建，不再发布第二个文件网关镜像，详见 [员工文件模块](../../docs/samba/05-员工文件模块.md)。

## 配置

挂载 `/config/agent.json`，字段见 `src/config.rs` 和隔离测试的 `deploy/samba-test/setup.py`。生产凭据自行以文件挂载，不提交版本控制。

- `ldap_url` 必须为 `ldaps://`，CA 与服务器名称/IP 必须匹配，不支持跳过校验。
- `users_dn` 为员工 OU，`groups_dn` 为受管组 OU，均限定在 `base_dn` 内。
- 若现有部门组位于 `CN=Users`，可配置 `groups_dn` 为该容器，并明确设置 `group_prefix`，例如 `dept_`，无需移动原组。其他前缀及内置/高权限对象不可管理。
- `primary_gid` 按现有文件服务器的 RFC2307 规则配置。已有用户 UID/GID 不被修改；新用户 UID 由域内已有值扫描后分配。每个域使用一个写入 Agent，避免多个独立分配器竞争。
- `shares_root` 是 Agent 本地共享挂载根；`samba_shares_root` 是同一存储在 Samba 内的绝对路径，默认 `/shares`，两者可不同。
- `shares_file_name`、`samba_config_file_name` 分别指定 Agent 注册表和生成的 Samba 配置文件名，默认 `assay-shares.json`、`assay-shares.conf`。均为 `config_dir` 内的简单文件名，不接受目录或路径穿越。
- 已有共享可通过部署维护的 `external_shares_file` JSON 显式登记，并配置只读挂载的 `external_samba_config_file`。JSON 格式为 `{ "config_sha256": "源配置文件的 SHA256", "shares": [{ "name": "scan", "comment": "扫描", "groups": ["dept_scan", "Domain Admins"], "read_only": false, "ready": true, "active": true, "path": "common/scans", "browseable": false }] }`。`path` 是 `shares_root` 内的真实相对路径，逐段拒绝符号链接；源配置变化后先更新清单，防止继续使用过期准入信息。
- 登记不会修改原配置、移动文件、初始化 ACL 或重新分配 SID；已有共享的定义继续由服务器配置维护，Web 禁止覆盖/移除其定义，但可按既有权限管理组成员、子目录和 Windows ACL。隐藏共享不会进入员工根目录列表。新共享仍由 Agent 独立生成，不接管已有目录。
- `smb_pid_file` 指向只读挂载的 smbd PID 文件，统一 Agent 与目标容器共享 PID namespace。
- 接入未挂载 PID 目录的既有 AD 容器时，可设置 `reload_via_proc: true`。程序在共享的容器 PID namespace 中识别父进程不是 smbd 的唯一 smbd 主进程，多目标或目标消失则拒绝重载；不扫描 host PID，不需要固化容器 PID。
- `read_only: true` 限制管理写操作；员工文件写权限仍由本人 SMB 会话和 Samba ACL 决定。

## API

健康检查 `GET /health` 与可选 `GET /files/health` 不含凭据或资源数据。管理接口需要管理机器令牌；文件接口需要独立文件服务令牌，已连接员工的文件操作还校验会话能力凭证和 owner。

失败结果包含安全说明 `error`，以及可选的稳定分类 `error_code`。密码策略拒绝分为 `AD_PASSWORD_COMPLEXITY`、`AD_PASSWORD_HISTORY`、`AD_PASSWORD_TOO_SHORT`、`AD_PASSWORD_TOO_RECENT`；域控仅说明一般密码限制时为 `AD_PASSWORD_POLICY`，无法确认原因的密码更改拒绝为 `AD_PASSWORD_REJECTED`。LDAP 53 本身不被当作复杂度证明。权限、服务身份验证和连接故障分别分类；原始 LDAP 诊断不写入操作结果或返回 Web。Assay 轮询后按分类显示固定中文说明，失败不自动重放。

| 接口 | 功能 |
|---|---|
| `GET /v1/snapshot` | 员工、组、受管共享及只读状态 |
| `GET /v1/directories?share=...&path=...` | 受管目录列表 |
| `GET /v1/acl?share=...&path=...` | Windows DACL 和变更版本 |
| `POST /v1/commands` | 提交 `{request_id, action, args}` |
| `GET /v1/operations/:id` | 查询执行结果 |

动作包含 `user.create/update/password/change_password`、`group.create/update/delete/member/members`、`share.save/remove`、`directory.create/delete`、`acl.grant`。员工创建/编辑接受选填 `profile`，对应工号、邮箱、部门、岗位、电话、公司、办公地点的标准 AD 属性；省略保留已有值，空字符串清除。`group.members` 接受 `group_id`、唯一 `user_ids` 列表（1–100 个 GUID）和 `add`，先核验全部员工再一次 LDAP Modify，只增删选中的成员关系。字段和未知参数检查见 `main.rs` 与 Assay 的 `samba/contracts.ts`。没有任意命令或任意文件内容接口。

写任务异步执行，返回 queued/running 后必须轮询，不能把接受请求当作完成。最多 20 个排队/执行任务，任务截止时间 300 秒。SQLite WAL 持久化请求的 HMAC 和结果，密码只存在工作任务内存中。请求 ID 相同但内容不同会被拒绝。进程重启后未完成任务标记 uncertain，不自动重放外部写入；操作人核对资源后重新提交明确动作。

## 权限与数据语义

- 账号停用代替硬删除，保留 SID、文件所有者及历史引用。
- 删除组前必须移空成员，并从受管目录的共享准入组中解除引用。
- 新共享发布给员工前先安装限制性的 Windows DACL；初始化失败的共享只允许管理服务访问。
- 移除共享只停用配置，保留文件与 ACL；可通过 Web 恢复。
- 目录删除经 SMB 执行，只允许空目录，禁止删除共享根目录。
- DACL 修改仅替换指定受管主体的显式允许项，保留 owner/group/SACL、拒绝和高级条目。
- 同时发送 DACL AUTO_INHERITED 与 AUTO_INHERIT_REQ，避免 Samba 将继承项变成显式项。修改后对已有子项传播该主体的继承允许项，保留显式子项授权和受保护分支。
- 传播先检查目录、权限和资源版本，拒绝 reparse point；单次最多 10000 个子项，超出需选取较小目录。遇到并发变更、部分执行失败或超时，必须人工核对，不盲目重试。
- 用户可能仍从其他组、显式条目或受保护分支获得权限；旧 SMB 登录令牌需重新连接才能反映成员变化。

生产接入须先备份 AD、Assay 数据库、附件及共享（含 ACL/xattr），并在隔离环境验证恢复。共享登记与目录身份切换是部署步骤，不自动按同名账号合并身份。

既有公司 AD 的参数化 Compose、备份/恢复验证与服务身份委派见 [生产部署](../../deploy/samba-production/README.md)。

## 从分离部署升级

已有隔离测试部署使用 `deploy/samba-test/migrate-unified.py --apply`；先准备统一 Agent 镜像及支持 `http://agent:8080/files` 的 API 镜像。脚本保留原配置、SQLite 备份和镜像引用，将旧 `files.json` 嵌入 `agent.json.files`，移除 `helper_socket`，只重建 Agent/API，并移除停止的 helper/file-gateway 容器。健康检查失败自动恢复旧配置。不会运行域 bootstrap 或移除数据卷。

升级将丢弃内存中的旧 SMB 连接，员工需通过正常公司登录重新建立；AD 密码不保留用于重连。旧 `helper_socket` / `--helper` 和单程序 `--files-only /config/files.json` 仅为过渡兼容与隔离测试保留，默认部署均不使用。旧镜像、旧 JSON 与 SQLite 备份留在私有升级备份目录；回退旧 UID 10001 布局前须恢复 `agent-state` 文件归属。
