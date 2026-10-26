# 本地 CI / 发布备用流程

GitHub Actions 免费额度耗尽时，使用仓库根目录 `Taskfile.yml`。测试、构建、Docker Hub
推送、GitHub Release 和生产部署相互独立；`task ci` 和 `task publish` 均不部署生产。

## 安装与前置条件

主运行环境为 Linux x86_64：Python 3.11+、Docker（Compose v2 / Buildx）、Git、GitHub CLI、
Rust stable（包含 rustfmt、clippy）、Node.js（部署工具契约测试）。API/Web 的依赖安装和构建
在 Docker 中执行，不要求主机额外安装 pnpm/Bun。CLI 的 Linux musl 和 Windows MSVC
发布包分别通过一次性 Rust 容器和主机 cargo-xwin 交叉构建。Linux 的编译输出和依赖缓存
绑定到 `.local-ci/cache`，源码只读，不把完整编译目录保存成镜像层；Agent 镜像复用同一次
编译的二进制并校验提取文件的 SHA256。主机还需安装 cargo-xwin v0.23.1、
LLVM（clang-cl、lld-link、llvm-lib、llvm-dlltool）以及 Rust 的 Windows 目标：

```bash
rustup target add x86_64-pc-windows-msvc
cargo install cargo-xwin --version 0.23.1 --locked
# Debian/Ubuntu：apt install clang lld llvm
```

也可从 cargo-xwin 官方 Release 下载并校验预编译工具。Windows SDK 首次构建时由
cargo-xwin 下载并缓存到本地 CI 输出目录，请遵守该工具及 Microsoft SDK 的许可条款。
此方式避免下载和展开完整的 Windows 编译器容器镜像，适合磁盘有限的备用构建主机。

安装 Task v3.54.0 时，从 [官方 Release](https://github.com/go-task/task/releases/tag/v3.54.0)
下载对应平台的压缩包与 `task_checksums.txt`，验证 SHA256 后将 `task` 放到 PATH。
执行 `task --version` 和 `task --list` 检查安装。

按需复制 `.env.local-ci.example` 为 `.env.local-ci`。该文件、`.local-ci/`、`.task/` 均被 Git 忽略。
使用正常的 `gh auth login` 和 `docker login` 配置账号，不把令牌放进 Taskfile 或命令参数。
受代理控制的环境可以设置 `LOCAL_CI_PROXY_CA`，构建会通过 BuildKit secret 挂载 CA，
不关闭 TLS 验证，不将会话证书写入发布镜像。

## 云环境中的发布凭据

在云环境配置界面创建机密并绑定为以下环境变量；不要把令牌填入仓库、Taskfile、
`.env.local-ci.example` 或命令行参数。机密通过环境配置保存和应用后，可供后续环境使用，
无需每次在聊天中提供。Cloud Environment 状态工具只查询绑定状态，不能代替配置界面写入机密。

| 环境变量 | 配置类型 | 用途 |
| --- | --- | --- |
| `ASSAY_RELEASE_GITHUB_TOKEN` | 机密 | GitHub 发布凭据，需有 `weironz/assay` 的 Contents 读写权限 |
| `DOCKERHUB_TOKEN` | 机密 | Docker Hub 访问令牌，需能读写三个 `assay-*` 镜像仓库 |
| `DOCKERHUB_USERNAME` | 普通变量 | 登录账号，本项目为 `willdockerhub` |

GitHub 使用独立变量，避免与构建环境自带的 `GH_TOKEN` 混淆。只有 GitHub CLI 子进程
会选用该发布令牌，继承的代理、认证配置保持不变。Docker Hub 的令牌通过标准输入传入
`docker login --password-stdin`；登录账号可以与镜像的组织命名空间不同。
这两个专用令牌不会传给编译器、Docker build 命令或写入发布记录。

配置后执行：

```bash
task auth:check
```

该检查只验证 Docker 登录及 GitHub 身份、仓库访问，不推送镜像、不创建 Release，也不部署。
实际镜像写权限和 Release 附件上传权限仍由 `task publish` 验证。
未绑定专用令牌时，继续使用现有 Docker 客户端登录及 GitHub CLI 的默认认证。

### 环境配置入口暂不可用时

也可在当前构建主机保存专用 GitHub CLI 登录，再在被忽略的 `.env.local-ci` 中设置
`ASSAY_RELEASE_GH_CONFIG_DIR=/绝对路径/专用凭据目录`。目录放在仓库外并设为 `0700`，
凭据文件仅当前用户可读写；通过 `gh auth login --with-token` 的标准输入完成登录，
不要把令牌写进命令行参数。Docker Hub 继续使用正常 `docker login` 保存的客户端认证。

发布命令优先使用 `ASSAY_RELEASE_GITHUB_TOKEN`；未绑定时，才使用明确选定的本地
GitHub CLI 凭据目录。仅这些 GitHub 子进程会去掉默认的 `GH_TOKEN` / `GITHUB_TOKEN`，
让 CLI 读取专用登录；其他构建命令和平台认证保持原样。选定目录未就绪时会报错，
不会静默换回其他身份。

这是当前主机的本地保存方式，不会登记成托管机密，也不保证云环境重建后保留。
配置入口恢复后，可改用前述托管机密绑定；原有发布版本不受影响。

## 完整执行

```bash
task doctor
task ci VERSION=1.3.12
task status VERSION=1.3.12
# 所有测试与构建均通过，且源代码已提交后：
task publish VERSION=1.3.12
```

`VERSION` 默认取根 `package.json`，必须与 API、Web、CLI、Samba Agent 一致。
`DOCKERHUB_NAMESPACE` 默认 `willdockerhub`，`GITHUB_REPOSITORY` 默认 `weironz/assay`，
都可通过 Task 参数覆盖。输出默认在 `.local-ci/<版本>/`，可用 `LOCAL_CI_STATE_DIR` 指定专用目录。
本工具不切换分支、不自动提交源代码；源代码变化会使已有测试、构建和发布凭据失效，需重新验证。

## 任务

| 命令 | 行为 |
| --- | --- |
| `task auth:check` | 检查发布登录及仓库访问，不发布、不部署 |
| `task test` | 部署/备份工具契约、前端测试、后端测试、CLI 测试、Agent fmt/clippy/test |
| `task build` | API/Web/Agent 三个镜像，以及 Linux/Windows CLI 发布包 |
| `task test:smoke` | 独立整栈的首页、Logo、路由、登录、角色、工单、MFA、限流验证 |
| `task test:upgrade` | 在隔离服务中恢复指定生产备份，验证迁移、原记录、附件下载和旧版本回退 |
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

先阅读 [v1.3.10 升级说明](upgrade-v1.3.12.md)。在 `.env.local-ci` 设置 `LOCAL_CI_DEPLOY_HOST`、`LOCAL_CI_DEPLOY_USER`、
`LOCAL_CI_DEPLOY_DIR`，按需设置端口和 SSH 配置路径。SSH 使用严格主机指纹检查和现有授权，
不会关闭主机验证。然后显式执行：

```bash
task deploy:production VERSION=1.3.12
```

部署要求当前提交的本地验证、生产副本升级/回退演练和 Release 全部完成。
按发布清单的不可变 digest 拉取镜像；设置 `LOCAL_CI_DEPLOY_OFFLINE=true` 时，在构建机
导出已发布且镜像 ID 相符的 API/Web，校验传输文件后在目标机导入，不依赖生产 Docker Hub 连通性。
两种模式均验证最终镜像 ID，不修改 `latest`。

服务器在原站服务期间完成镜像准备、配置预检查。进入维护窗口后暂停 Web/API 写入，
使用当前 API 镜像内已有的 S3 SDK 备份 PostgreSQL、全部对象及恢复配置，不下载备份工具镜像。
校验备份后只重建 API/Web，沿用生产的无 seed 启动命令。开启 Web 前逐条核对旧数据，
允许新记录和空附件关联回填，禁止原工单、正文、账号密码哈希、角色分配或既有附件绑定丢失/改变。
数据库、Redis、对象存储容器和数据卷保留；域名、密钥、代理配置不随环境模板替换。
检查失败会尝试恢复原 `.env`、Compose 和 API/Web 镜像，并明确报告恢复是否成功。

镜像回退不会自动撤销数据库迁移，也不会覆盖部署后新增的工单。数据库恢复需要根据备份单独操作；
发布前应核对迁移的兼容性和恢复演练结果。生产部署默认不更新 Samba Agent，文件服务器上的
Agent 升级仍按该环境的现有流程单独执行。
