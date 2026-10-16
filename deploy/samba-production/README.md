# 既有公司 AD 的生产接入

这是部署工具，不是 Agent 的运行时依赖。Rust Agent 始终为一个镜像、一个容器、一个进程；部署工具可使用 Samba 官方工具和库完成备份验证及委派。

## 发布与参数

`ci-cd.yml` 手动发布同时构建 API、Web、统一 Samba Agent，全部通过检查后分发到 Docker Hub 和 ACR。`skip_deploy=true` 只发布镜像；现有默认部署目标不会因此改变。候选发布默认不更新 `latest`，正式版本也须显式设置 `publish_latest=true` 才更新该标签。生产 Compose 使用三镜像的 digest，回退不依赖可变标签。

```bash
gh workflow run ci-cd.yml --ref main -f skip_deploy=true -f image_tag=sha-COMMIT
```

复制 `config.example.json` 到服务器上的私有配置文件后填写实际参数。域名、证书 DNS 名、OU、容器名、网络、端口、文件名、目录、镜像均从配置读取；密码引用本地私有文件。示例地址与路径仅为占位值。主配置文件须有明确的公司共享 include，复杂的动态 include、宏、复制模板或目录越界必须先人工核对，不能猜测后导入。

已有数据的 Assay 身份迁移需另行制定明确的 GUID 映射，不按账号名或邮箱合并。本工具建立**全新 Assay 数据库**，适用于明确不保留测试业务数据的切换；原 Samba 员工、SID、密码和文件保留。

## 备份与恢复验证

`backup.py --config PRIVATE.json --destination /PRIVATE/BACKUP backup` 在宿主机以 root 执行。配置包含：

- `containers`：记录镜像和原运行配置的容器列表。
- `stop_for_backup`：快照期间停止并在 finally 恢复的 Assay 写服务。
- `pause_for_snapshot`：短暂停顿的 Samba 容器，冻结期间只做 XFS reflink 克隆。
- `postgres_container`、`postgres_user`、`postgres_database`：数据库来源。
- `trees`：备份标签到源绝对目录的映射，包含 AD 部署、Assay 配置/Agent 状态、附件。
- `content_verify_trees`：恢复时逐文件验证内容的树标签。
- `content_verify_mode`：默认 `bytes` 逐字节读取并计算 SHA256；同盘 reflink 可选 `reflink`，逐文件用 Linux FIEMAP 确认逻辑区间映射到同一物理数据块（包括稀疏区间），不一致或不支持时回退到该文件的 SHA256。后者避免反复读取大文件，仍核对每个文件的数据对应关系；不能检测源与备份共享的数据块本身发生的磁盘损坏。
- `ad_tree`、`ad_container`、`ad_restore_mounts`：恢复副本的 AD 根、镜像来源和相对目录到容器内路径的映射。
- `sqlite_files`：备份根目录内需要完整性检查的 Agent SQLite 相对路径。

备份要求同文件系统 reflink；不支持时直接中止，防止长时间冻结服务。备份与源目录不能重叠。备份包含敏感数据，父目录为 root 0700，不提交仓库或传输到构建流水线。

```bash
sudo python3 backup.py backup --config /private/backup.json --destination /data/backups/cutover-UTC
sudo python3 backup.py verify --config /private/backup.json --destination /data/backups/cutover-UTC
```

验证会将 PostgreSQL dump 实际恢复到临时、无网络的容器，逐表核对数量和内容指纹；将文件恢复到独立 reflink 副本，检查内容、mode、uid/gid、mtime、ACL/xattr；在隔离 AD 副本上执行 `samba-tool dbcheck --cross-ncs`，并检查 Agent SQLite。只有成功后才生成 `RESTORE_VERIFIED.json`。这验证了切换回滚能力；同盘 reflink 不代替异盘或异地灾备。

恢复验证将数据库及每棵目录树的结果分步写入私有验证目录，可在工作区断线后重跑；已完成的数据库恢复会核对记录，文件树仍重新核验。长任务应在服务器后台执行并将 stdout/stderr 重定向到私有日志，避免 SSH 断线影响结果保存。

## 准备与验收

将本目录的脚本、Compose、Nginx 模板放到服务器的运维目录，先执行无副作用检查，再 apply：

```bash
sudo python3 prepare.py --config /private/company.json
sudo python3 prepare.py --config /private/company.json --apply
cd /data/assay-company
sudo docker compose pull
sudo docker compose up -d postgres redis agent api
```

准备会校验恢复证明属于同一个 AD，为管理账号仅委派员工 OU、受管组 OU 的权限，为查询账号保留普通只读权限。两个随机服务密码仅写私有文件，经 stdin 交给 Samba 库；不创建域管理员成员。配置候选在无网络容器中经过 `testparm` 后才执行目录写入。已有共享的 `valid users` 与 `admin users` 仅追加管理服务身份，其余行保持，文件 ACL 不初始化。原始配置和 OU 安全描述符保存在私有 `rollback` 目录。

新共享由单独受管配置文件发布；原公司共享继续保留实际路径和现有配置语义，Web 可管理组成员、子目录及 ACL，禁止把原共享定义覆盖成简化模板。原配置有改动时，须重新生成带 SHA256 的外部登记清单后再重建 Agent 挂载；禁止忽略漂移告警。隐藏共享不出现在员工根目录中。

`managed_include_name` 指定静态 include 桥接文件：先加载原公司共享，再加载 Agent 生成的配置。主 `smb.conf` 保持单个 `[global]`，兼容现有严格 INI 启动检查。切换前除了 `testparm`，还应在隔离副本验证原容器启动入口；仅热重载不能证明下次启动成功。

Agent 为兼容仅允许宿主机/公司 LAN 来源的既有 Samba，使用 host 网络连接本机 SMB，但 HTTP 仅绑定独立管理桥的网关地址，不绑定 LAN/VPN 或 `0.0.0.0`。API 通过该桥调用，Agent 两类接口分别验证密钥。Agent 与现有 AD 容器共享 PID namespace，`reload_via_proc=true` 只在找到唯一 smbd 主进程时重载，不使用 host PID 或 Docker socket。LDAPS 始终验证 CA 与 DNS 名。

`application_subnet` 与 `api_directory_source_ip` 固定 API 访问 AD 的来源。Samba 的 `hosts allow` 也会影响 LDAP 接入，因此准备步骤只追加这一个 API IP，保留原白名单；不放行整个 Docker 网段。API 出站优先使用此网络，重建容器后地址保持。两个配置子网必须互不重叠，也须在部署前与宿主机、VPN 及既有 Docker 网络核对。

可选 `samba_allowed_networks` 显式指定公司 LAN 和远程员工 VPN 的来源 CIDR；设置后替换原 `hosts allow`（包括原先的 `ALL`），自动保留 `LOCAL`、回环网段和固定 API 地址。不设置时沿用原白名单，仅追加 API IP。示例中的公司网段须替换为实际值。2026-10-16 公司确认的生产策略为 `192.168.10.0/24` 与 `100.70.0.0/16`；私有部署配置保存在服务器，不提交凭据或完整站点配置。

来源白名单与监听地址、账号验证、文件 ACL 相互独立：客户端通过 VPN 访问 LAN 地址时，服务端可能看到 `100.70.x.x` 源地址，而非 LAN 地址。TCP 445 连通后仍可能在认证前被拒绝；先核对 Samba 日志中的 `Denied connection`。只调整全局 `hosts allow` 不会改变公司共享定义清单的摘要。已有部署须备份 `smb.conf`、用 `testparm` 检查候选、原子替换并执行 `smbcontrol all reload-config`，随后从实际客户端重新建立 SMB 连接验证；不要为更新网络白名单重跑新部署的 `prepare.py --apply`。LDAP 工作进程的热更新限制见下文。

部分 Samba AD 版本不会对 LDAP 工作进程热更新来源规则。若 `testparm` 已显示新地址，而 LDAP 仍记录拒绝该来源，须安排一次原 AD 容器的正常重启：先核对 `smbstatus --json` 没有活动会话或打开文件，确认备份恢复验证通过、原启动入口在隔离副本可启动；保留原容器、镜像和数据卷。重启后重建 Agent，使其加入新的 AD PID namespace，再用实际 LDAPS 查询和登录验证就绪，不能只依赖进程 ping。

先检查 API/Agent 健康、LDAPS、目录只读快照、管理员登录、员工登录后自动建立本人 SMB 会话和共享准入。通过后才停旧 Web，启动新 Web 接管相同 HTTPS 端口。浏览器确认原员工没有多余业务角色，文件显示正确，再停用测试栈；保留其配置、镜像、卷用于回退。禁止对公司 AD 运行 `deploy/samba-test/setup.py`。

隔离测试脚本必须显式设置 `SAMBA_E2E_ORIGIN`，不再默认指向某台远程服务器；同一地址可能已由测试切换为生产。现有测试域校验仍保留，禁止用旧 QA 脚本对正式员工执行密码、组或 ACL 测试。

## 宿主机重启与网络就绪

Web 默认只发布一个 HTTPS 端口，`WEB_BIND_IP` / `web_bind_ip` 默认 `0.0.0.0`，不绑定 LAN 或 VPN 的具体地址，避免开机时网卡地址尚未分配导致 Docker 端口发布失败。Assay、Agent 和既有 Samba 均不依赖 NetBird；没有 VPN 时可正常从公司 LAN 使用。仅 Web 发布业务端口，API、数据库和 Agent 管理端口保持内部访问。

`lan_ip` 用于浏览器主访问地址；可选的 `vpn_ip` 仅增加可信浏览器来源，不生成额外监听、不参与启动检查。若明确设置 `web_bind_ip` 为某个具体地址，启动器会等待该地址就绪；请使用长期可用的公司内网地址，不要配置成维护用 VPN 地址。既有 Samba 的监听、来源白名单和启动方式均保持。

将 `startup.py` 保存到稳定的 root 管理目录，安装并立即验证（路径和 unit 名按实际部署填写）：

```bash
sudo python3 /data/assay-operations/startup.py --project-directory /data/assay-company --install --unit-name assay-company-startup.service
sudo systemctl start assay-company-startup.service
sudo systemctl status assay-company-startup.service
```

启动器从实际 Compose 读取绑定地址和 AD 容器名，不复制密码或硬编码域、IP；默认通配监听无需等待任何宿主机地址，更不会等待 VPN。等待超时或启动失败时 systemd 每 15 秒重试；AD 必须有健康检查。先等待 API/数据库等依赖健康，再只重建无状态 Web 以修复失败的网络端点。不会重启既有 AD、删除卷或恢复数据库。该 unit 只负责开机启动，运行期间的容器退出继续由 Docker restart 策略处理；停止 unit 不停止容器。`--timeout` 可调整每轮等待秒数。

失败时先保留日志，恢复旧 Web 和原 Assay 配置即可退回测试入口；如果撤销 AD 接入，还须恢复 `rollback` 中原 Samba 配置、核对并撤销本次服务账号委派。已有业务的正式实例不能用旧数据库快照直接覆盖，否则会丢失备份后的新写入。任何数据库恢复必须先停写、保存当前库并核对恢复点。
