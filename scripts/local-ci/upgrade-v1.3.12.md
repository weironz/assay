# v1.3.10 → v1.3.12：保留工单的升级与回退

v1.3.12 包含 v1.3.11 的功能，并修复旧数据库直接升级时的权限基线缺失、历史草稿附件
启动即清理和生产代理地址不匹配问题。已发布的 v1.3.11 不覆盖重发。

## 部署前准备

1. 记录实际 API/Web 镜像 ID、数据库迁移清单、工单/正文/历史/附件/分享/用户数量。
   核对既有迁移 checksum；不要对生产执行 `db push`、`migrate reset` 或通用 seed。
2. 对实际运行的 Compose 项目执行完整备份。生产不能访问镜像仓库时可用：

   ```bash
   BACKUP_S3_CLIENT=api-sdk bash scripts/backup.sh /受保护的备份目录 /实际部署目录/docker-compose.yaml
   ```

   该模式要求同目录的 `backup-s3.cjs`，使用已在生产运行的 API 镜像内的 SDK。
   数据库、所有 S3 当前对象、对象内容 SHA256/元数据、Compose、环境文件和 AUTH_SECRET
   均纳入备份。检查 `INCOMPLETE` 不存在并执行 `sha256sum -c SHA256SUMS`。
   未配置 age 加密时，备份包含凭据，只能保存在管理员可访问的目录，不能上传 GitHub。
3. 将 `db.sql.gz`、`objects.tar.gz`、`objects-manifest.json`、`backup-info.txt` 复制到仓库外的
   `0700` 目录，文件 `0600`。另建私有 `source.json`：

   ```json
   {
     "version": "1.3.10",
     "apiImageId": "sha256:<实际旧 API 镜像 ID>",
     "webImageId": "sha256:<实际旧 Web 镜像 ID>",
     "adminEmail": "<生产 ADMIN_EMAIL>",
     "fileSha256": {
       "db.sql.gz": "<SHA256>",
       "objects.tar.gz": "<SHA256>",
       "objects-manifest.json": "<SHA256>"
     },
     "trustedProxyContainers": ["<确实可信并与 Web 共享网络的代理容器名>"],
     "rollbackImages": {"api": "<本地旧 API 镜像引用>", "web": "<本地旧 Web 镜像引用>"}
   }
   ```

   首选原镜像，演练会核对镜像 ID。受磁盘限制时可以从原镜像创建**从未启动且没有挂载**的
   临时容器导出只读根文件系统，再导入演练机并恢复原 image config 的工作目录、用户、
   entrypoint、CMD 及必要的公开环境项。导入镜像需要标注 `assay.upgrade.source-image-id`、
   `assay.upgrade.archive-sha256`，备份目录保留 `rollback-api.tar.gz`/`rollback-web.tar.gz`，
   `source.json.rollbackArchiveSha256` 记录两者 SHA256。工具同时核对标签和文件校验值。
   此方法验证旧运行程序与新 schema 的兼容性；导入镜像 ID 会改变，不能冒充原镜像 ID，
   也不能把这些私人演练镜像作为正式发行物推送。
4. 设置 `LOCAL_CI_UPGRADE_BACKUP_DIR`，完成当前提交的 `task ci` 和 `task test:upgrade`。
   演练只连接随机命名的隔离 PostgreSQL/Redis/RustFS，禁用邮件、AD、Agent 和员工文件连接。
   使用新建的临时账号验证登录、角色、工单及原附件下载；不更改真实员工的密码。
   还会用旧程序访问已迁移数据库，证明应用回退可用。生产数据指纹及日志仅留在私有本地目录，
   不加入公开 Release 附件。

## 正式部署

先执行 `task publish VERSION=1.3.12`。在被忽略的本地配置中设置明确的 SSH 目标和部署目录，
必要时启用离线镜像传输，再运行 `task deploy:production VERSION=1.3.12`。

部署检查当前旧镜像仍与演练来源一致。它仅调整 API/Web 镜像及本次必要的两项设置：
`ASSAY_TRUSTED_PROXY_IPS` 从明确指定的可信代理当前 IPv4 地址解析；
`ATTACHMENT_DRAFT_CLEANUP_ENABLED=false` 保留历史草稿。其他服务配置、卷、网络、
密码密钥和域名必须保持指纹一致。代理容器后续重建可能改变动态地址，应重新解析并更新 Web，
不要通过信任整个 Docker 子网解决。

最终备份期间会暂停 Web/API，因此有短暂维护窗口。数据库新迁移为增量操作，新增可选
Samba 角色和权限，不重新分配员工角色。API 启动后检查每条旧记录和原附件绑定，检查通过
才开放 Web。最后验证健康状态、公开 HTTPS 首页和匿名 API 拒绝访问，并核对数据服务
容器 ID 未变化。自动草稿清理以后如要启用，需先审核旧草稿并显式设为 `true`；删除 outbox
重试仍独立运行，不受此开关影响。

## 回退与恢复

每次部署的 `backups/local-ci-<版本>-<时间>-<随机值>/` 保存原环境/Compose、完整最终备份、
数据指纹和校验结果。故障时自动尝试恢复原配置和 API/Web，**不覆盖数据库**。增量迁移保留，
与旧程序的兼容性必须在部署前的演练中通过；失败时保留日志并报告人工恢复需求。

需要手动回退时，先暂停 API/Web 写入，把该次操作的 `before.env`、`before-compose.yaml`
恢复到实际部署目录，确认旧镜像仍在，再仅启动 API/Web。不要执行 `down -v` 或直接还原
旧数据库，否则会丢掉升级后的新增工单。数据库灾难恢复需要另外确定恢复时间点、保存
升级后数据并演练导入；不属于普通镜像回退步骤。
