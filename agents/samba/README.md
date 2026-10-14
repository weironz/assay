# Assay Samba Agent

原生 Rust 管理服务，独立于 Assay API 部署。LDAP、SMB、Windows 安全描述符、任务执行与受限本地 helper 均由 Rust 实现，运行时不调用 Python、Shell、`samba-tool` 或旧管理脚本。镜像为静态二进制，不包含操作系统工具。

## 连接与职责

浏览器只访问 Assay。Assay API 通过固定地址与机器令牌调用 Agent；测试 Compose 的 Agent 无宿主机端口，仅接入内部 Docker 网络。跨主机部署须为 Agent 配置 TLS 入口和 API 源地址限制，不能把明文接口开放到公司网络。

Agent 以 UID 10001 运行，读取 LDAPS CA 和独立凭据文件。文件配置 helper 使用同一二进制的 `--helper` 模式，只接受 Unix socket 上 UID 10001 的类型化请求，不接入网络，仅具备向配置的 smbd 进程发送 SIGHUP 的能力。两者均无 Docker socket。共享配置和根目录创建由 helper 完成；目录创建/删除与 Windows DACL 由 SMB 完成，确保 Samba 执行权限继承。

## 构建

```sh
cargo test --locked --manifest-path agents/samba/Cargo.toml
cargo clippy --locked --manifest-path agents/samba/Cargo.toml --all-targets -- -D warnings
docker build -t assay-samba-agent:0.1.0 agents/samba
```

标准 Dockerfile 使用 Rust 1.99 / musl。云环境可用 BuildKit `proxy_ca` secret 提供构建 CA，不写入镜像。`BUILDER_IMAGE` 可指定同版本的本地编译缓存镜像；默认仍为官方 Rust 镜像。

## 配置

挂载 `/config/agent.json`，字段见 `src/config.rs` 和隔离测试的 `deploy/samba-test/setup.py`。生产凭据自行以文件挂载，不提交版本控制。

- `ldap_url` 必须为 `ldaps://`，CA 与服务器名称/IP 必须匹配，不支持跳过校验。
- `users_dn` 为员工 OU，`groups_dn` 为受管组 OU，均限定在 `base_dn` 内。
- 若现有部门组位于 `CN=Users`，可配置 `groups_dn` 为该容器，并明确设置 `group_prefix`，例如 `dept_`，无需移动原组。其他前缀及内置/高权限对象不可管理。
- `primary_gid` 按现有文件服务器的 RFC2307 规则配置。已有用户 UID/GID 不被修改；新用户 UID 由域内已有值扫描后分配。每个域使用一个写入 Agent，避免多个独立分配器竞争。
- `shares_root` 与 Samba 的 `/shares` 挂载保持一致；只允许管理 Agent 自己创建的共享，不覆盖其他配置或接管现有文件夹。
- `smb_pid_file` 指向只读挂载的 smbd PID 文件，helper 与目标容器共享 PID namespace。
- `read_only: true` 同时限制网络 Agent 和 helper 写操作。

## API

健康检查 `GET /health` 不含凭据或资源数据。其余接口需要 `Authorization: Bearer <machine-token>`。

| 接口 | 功能 |
|---|---|
| `GET /v1/snapshot` | 员工、组、受管共享及只读状态 |
| `GET /v1/directories?share=...&path=...` | 受管目录列表 |
| `GET /v1/acl?share=...&path=...` | Windows DACL 和变更版本 |
| `POST /v1/commands` | 提交 `{request_id, action, args}` |
| `GET /v1/operations/:id` | 查询执行结果 |

动作包含 `user.create/update/password/change_password`、`group.create/update/delete/member`、`share.save/remove`、`directory.create/delete`、`acl.grant`。字段和未知参数检查见 `main.rs` 与 Assay 的 `samba/contracts.ts`。没有任意命令或任意文件内容接口。

写任务异步执行，返回 queued/running 后必须轮询，不能把接受请求当作完成。最多 20 个排队/执行任务，任务截止时间 300 秒。SQLite WAL 持久化请求的 HMAC 和结果，密码只存在工作任务内存中。请求 ID 相同但内容不同会被拒绝。进程重启后未完成任务标记 uncertain，不自动重放外部写入；操作人核对资源后重新提交明确动作。

## 权限与数据语义

- 账号停用代替硬删除，保留 SID、文件所有者及历史引用。
- 新共享发布给员工前先安装限制性的 Windows DACL；初始化失败的共享只允许管理服务访问。
- 移除共享只停用配置，保留文件与 ACL；可通过 Web 恢复。
- 目录删除经 SMB 执行，只允许空目录，禁止删除共享根目录。
- DACL 修改仅替换指定受管主体的显式允许项，保留 owner/group/SACL、拒绝和高级条目。
- 同时发送 DACL AUTO_INHERITED 与 AUTO_INHERIT_REQ，避免 Samba 将继承项变成显式项。修改后对已有子项传播该主体的继承允许项，保留显式子项授权和受保护分支。
- 传播先检查目录、权限和资源版本，拒绝 reparse point；单次最多 10000 个子项，超出需选取较小目录。遇到并发变更、部分执行失败或超时，必须人工核对，不盲目重试。
- 用户可能仍从其他组、显式条目或受保护分支获得权限；旧 SMB 登录令牌需重新连接才能反映成员变化。

生产接入与现有共享的显式接管是独立部署步骤。本次测试不修改公司原域或原共享。
