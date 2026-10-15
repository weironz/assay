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
- `ad_tree`、`ad_container`、`ad_restore_mounts`：恢复副本的 AD 根、镜像来源和相对目录到容器内路径的映射。
- `sqlite_files`：备份根目录内需要完整性检查的 Agent SQLite 相对路径。

备份要求同文件系统 reflink；不支持时直接中止，防止长时间冻结服务。备份与源目录不能重叠。备份包含敏感数据，父目录为 root 0700，不提交仓库或传输到构建流水线。

```bash
sudo python3 backup.py backup --config /private/backup.json --destination /data/backups/cutover-UTC
sudo python3 backup.py verify --config /private/backup.json --destination /data/backups/cutover-UTC
```

验证会将 PostgreSQL dump 实际恢复到临时、无网络的容器，逐表核对数量和内容指纹；将文件恢复到独立 reflink 副本，检查内容、mode、uid/gid、mtime、ACL/xattr；在隔离 AD 副本上执行 `samba-tool dbcheck --cross-ncs`，并检查 Agent SQLite。只有成功后才生成 `RESTORE_VERIFIED.json`。这验证了切换回滚能力；同盘 reflink 不代替异盘或异地灾备。

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

Agent 为兼容仅允许宿主机/公司 LAN 来源的既有 Samba，使用 host 网络连接本机 SMB，但 HTTP 仅绑定独立管理桥的网关地址，不绑定 LAN/VPN 或 `0.0.0.0`。API 通过该桥调用，Agent 两类接口分别验证密钥。Agent 与现有 AD 容器共享 PID namespace，`reload_via_proc=true` 只在找到唯一 smbd 主进程时重载，不使用 host PID 或 Docker socket。LDAPS 始终验证 CA 与 DNS 名。

先检查 API/Agent 健康、LDAPS、目录只读快照、管理员登录、员工登录后自动建立本人 SMB 会话和共享准入。通过后才停旧 Web，启动新 Web 接管相同 HTTPS 端口。浏览器确认原员工没有多余业务角色，文件显示正确，再停用测试栈；保留其配置、镜像、卷用于回退。禁止对公司 AD 运行 `deploy/samba-test/setup.py`。

失败时先保留日志，恢复旧 Web 和原 Assay 配置即可退回测试入口；如果撤销 AD 接入，还须恢复 `rollback` 中原 Samba 配置、核对并撤销本次服务账号委派。已有业务的正式实例不能用旧数据库快照直接覆盖，否则会丢失备份后的新写入。任何数据库恢复必须先停写、保存当前库并核对恢复点。
