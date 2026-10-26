# 本地 CI / 发布备用流程

GitHub Actions 免费额度耗尽时，使用仓库根目录 `Taskfile.yml`。测试、构建、Docker Hub
推送、GitHub Release 和生产部署相互独立；`task ci` 和 `task publish` 均不部署生产。

## 安装与前置条件

主运行环境为 Linux x86_64：Python 3.11+、Docker（Compose v2 / Buildx）、Git、GitHub CLI、
Rust stable（包含 rustfmt、clippy）、Node.js（部署工具契约测试）。API/Web 的依赖安装和构建
在 Docker 中执行，不要求主机额外安装 pnpm/Bun。CLI 的 Linux musl 和 Windows MSVC
发布包也通过 Docker 交叉构建。

安装 Task v3.54.0 时，从 [官方 Release](https://github.com/go-task/task/releases/tag/v3.54.0)
下载对应平台的压缩包与 `task_checksums.txt`，验证 SHA256 后将 `task` 放到 PATH。
执行 `task --version` 和 `task --list` 检查安装。

按需复制 `.env.local-ci.example` 为 `.env.local-ci`。该文件、`.local-ci/`、`.task/` 均被 Git 忽略。
使用正常的 `gh auth login` 和 `docker login` 配置账号，不把令牌放进 Taskfile 或命令参数。
受代理控制的环境可以设置 `LOCAL_CI_PROXY_CA`，构建会通过 BuildKit secret 挂载 CA，
不关闭 TLS 验证，不将会话证书写入发布镜像。

## 完整执行

```bash
task doctor
task ci VERSION=1.3.11
task status VERSION=1.3.11
# 所有测试与构建均通过，且源代码已提交后：
task publish VERSION=1.3.11
```

`VERSION` 默认取根 `package.json`，必须与 API、Web、CLI、Samba Agent 一致。
`DOCKERHUB_NAMESPACE` 默认 `willdockerhub`，`GITHUB_REPOSITORY` 默认 `weironz/assay`，
都可通过 Task 参数覆盖。输出默认在 `.local-ci/<版本>/`，可用 `LOCAL_CI_STATE_DIR` 指定专用目录。
本工具不切换分支、不自动提交源代码；源代码变化会使已有测试、构建和发布凭据失效，需重新验证。

## 任务

| 命令 | 行为 |
| --- | --- |
| `task test` | 部署/备份工具契约、前端测试、后端测试、CLI 测试、Agent fmt/clippy/test |
| `task build` | API/Web/Agent 三个镜像，以及 Linux/Windows CLI 发布包 |
| `task test:smoke` | 独立整栈的首页、Logo、路由、登录、角色、工单、MFA、限流验证 |
| `task ci` | 按顺序执行全部检查与构建，记录对应提交号和源码摘要 |
| `task push:images` | 仅推送通过验证的版本标签，拒绝覆盖已有发布标签，不更新 latest |
| `task release` | 发布二进制、SHA256SUMS 和包含镜像 digest 的发布清单 |
| `task publish` | 依次推送镜像、创建 Release，**不部署生产** |
| `task deploy:production` | 使用明确配置的 SSH 目标，备份后只更新生产 API/Web |

测试数据库、缓存、附件存储使用每次独立的 `assay-local-ci-*` 项目；端口仅绑定回环地址，
不会读取生产 `.env`、连接生产数据库、使用生产卷或停止其他容器。测试结束仅清理本次项目。
同一个输出目录同时只允许运行一个任务，防止并发发布或覆盖验证结果。

## 发布产物

- `assay-x86_64-unknown-linux-musl`：Linux x86_64 静态 CLI，构建后执行 `--version` 验证。
- `assay-x86_64-pc-windows-msvc.exe`：Windows x86_64 CLI，交叉构建并检查 PE 格式。
- `assay-samba-agent-x86_64-unknown-linux-musl`：从已验证 Agent 镜像提取的 Linux Agent。
  单独运行时仍需安装 Agent 使用的 Samba 配置校验工具；常规部署建议使用 Agent 镜像。
- `SHA256SUMS`、`release-manifest.json`：二进制校验值、源码提交、测试记录、镜像 digest。

镜像为 `willdockerhub/assay-api:<版本>`、`willdockerhub/assay-web:<版本>`、
`willdockerhub/assay-samba-agent:<版本>`。Release 先作为草稿上传并下载校验文件，再发布为
`v<版本>` 正式 Release。重复发布不覆盖已有正式 Release；同一提交的未完成草稿可以继续上传。
Windows 包在 Linux 交叉编译，本机不执行 Windows 程序。

## 单独部署生产

本次只构建和发布；下列流程为之后明确执行生产部署时使用。
在 `.env.local-ci` 设置 `LOCAL_CI_DEPLOY_HOST`、`LOCAL_CI_DEPLOY_USER`、
`LOCAL_CI_DEPLOY_DIR`，按需设置端口和 SSH 配置路径。SSH 使用严格主机指纹检查和现有授权，
不会关闭主机验证。然后显式执行：

```bash
task deploy:production VERSION=1.3.11
```

部署要求本地验证和 Release 已完成，沿用当前提交，按发布清单的不可变 digest 拉取镜像。
服务器先运行现有备份工具，再保留原 `.env` / Compose / 镜像引用，更新 `REGISTRY` 和
`IMAGE_TAG` 后只重建 API/Web。数据库、Redis、对象存储容器和数据卷保留。
API 使用生产的无 seed 启动命令；健康、镜像和公网检查失败时恢复原 `.env` 与 API/Web 镜像。

镜像回退不会自动撤销数据库迁移，也不会覆盖部署后新增的工单。数据库恢复需要根据备份单独操作；
发布前应核对迁移的兼容性和恢复演练结果。生产部署默认不更新 Samba Agent，文件服务器上的
Agent 升级仍按该环境的现有流程单独执行。
