# Taskfile 统一 CI、发布与 Ansible 部署

根目录 `Taskfile.yml` 是统一触发入口。本地与 GitHub 两条路线执行相同的 Python 管线；
生产部署统一进入 `deploy/ansible/deploy.yml`，由 Ansible 传送并执行已有的备份、部署、
数据保留校验与恢复脚本。参考 Cormex 的环境变量 inventory 模式，未复制其应用配置。

| 阶段 | 当前机器执行 | 提交 GitHub Actions |
| --- | --- | --- |
| 测试、构建、隔离整栈验证 | `task local:ci` | `task github:ci` |
| 测试通过的版本镜像和 GitHub Release | `task local:publish` | `task github:publish` |
| 已发布且已演练版本的生产部署 | `task local:deploy` | `task github:deploy` |

`github:*` 只提交任务，终端显示成功不代表构建或部署已完成。到输出的 Actions 地址查看结果。
`local:publish` 复用本机已验证产物；`github:publish` 在 runner 上先运行完整 CI 再发布。
发布任务不会连生产 SSH，也不更新 Docker `latest`。默认任务只列出帮助。
原 `ci`、`publish`、`deploy:production` 等入口保留，与 `local:*` 使用同一实现。

## 控制机安装

控制机使用 Linux x86_64 或 Linux WSL。要求 Python **3.12+**、Docker（Compose v2、Buildx）、
Git、GitHub CLI、Node.js、Rust stable（rustfmt、clippy）。API/Web 在 Docker 内安装依赖并测试。
Windows 原生不是 Ansible 控制机，请在 WSL 内执行以下流程。

Task 固定使用 v3.54.0。从 [官方 Release](https://github.com/go-task/task/releases/tag/v3.54.0)
下载对应平台压缩包及 `task_checksums.txt`，校验 SHA256 后把 `task` 放到 PATH。

```bash
task --version
task --list
task tools:ansible
task deploy:check
rustup target add x86_64-pc-windows-msvc
cargo install cargo-xwin --version 0.23.1 --locked
# Debian/Ubuntu 的 Windows 交叉编译工具：apt install clang lld llvm
task doctor
```

`tools:ansible` 在被忽略的 `.local-ci/tools/ansible` 创建 venv，安装固定的 ansible-core 2.21.6。
可以使用 PATH 中已安装的 Ansible；团队控制机应保持同一版本。
`deploy:check` 仅做语法检查，不读取生产凭据、不连接服务器。
LLVM 的 clang-cl、lld-link、llvm-lib、llvm-dlltool 必须都在 PATH。
cargo-xwin 首次下载 Windows SDK 并缓存，请遵守其许可。

Linux musl CLI/Agent 通过一次性 Rust 容器构建，输出缓存绑定到 CI 状态目录，源码只读。
Agent 镜像复用同一二进制并校验 SHA256。受代理控制时设置 `LOCAL_CI_PROXY_CA`；CA 通过
BuildKit secret 挂载，不关闭 TLS 验证，不写进正式镜像。

## 本地环境变量和凭据

Taskfile **不再自动加载 `.env.local-ci`**，也不读取保存的 `gh auth login`、Docker 登录作为发布凭据。
原文件不会被删除；迁移时请由受控 shell/机密管理器显式导出所需变量。
`.env.local-ci.example` 仅列变量，不是自动加载入口。

| 变量 | 要求及用途 |
| --- | --- |
| `ASSAY_RELEASE_GITHUB_TOKEN` | GitHub 发布需 Contents 读写；触发 Actions 另需 Actions 写权限。可使用环境中的 `GH_TOKEN` / `GITHUB_TOKEN` |
| `DOCKERHUB_TOKEN` | Docker Hub 读写令牌，仅推送或认证检查时读取 |
| `DOCKERHUB_USERNAME` | Docker Hub 登录账号，与组织命名空间可以不同 |
| `DOCKERHUB_NAMESPACE` | 默认 `willdockerhub` |
| `GITHUB_REPOSITORY` | 默认 `weironz/assay` |
| `LOCAL_CI_STATE_DIR` | 构建输出、缓存与校验记录目录；默认 `.local-ci`，runner 必须显式设置到 checkout 外 |
| `CARGO`、`CARGO_HOME`、`RUSTUP_HOME` | 按需选择编译器和缓存位置 |

请从系统机密管理器注入令牌，或通过终端隐藏输入设置变量，不把值写在命令历史、Git 或聊天中。
GitHub 令牌仅传给相应 GitHub CLI 子进程；SSH 密码、GitHub 和 Docker Hub 令牌不会进入编译器。
Docker 登录使用临时 `0700` 目录和 `--password-stdin`，保留客户端代理设置，成功或失败退出均清理，
不覆盖机器上原来的 Docker 登录。

```bash
export DOCKERHUB_USERNAME=willdockerhub
export LOCAL_CI_STATE_DIR=/private/assay-ci
task auth:check
task local:ci
task status
task local:publish
```

`VERSION` 默认取 `package.json`，也可显式 `task local:ci VERSION=X.Y.Z`，必须与 API/Web/CLI/Agent
版本一致。已发布版本不可覆盖：新代码应先按版本管理流程统一升版，再运行 CI/发布。
任务不自动改版本、切分支或提交源码；源码或镜像/二进制变化会使原校验记录失效。
`auth:check` 不发布、不部署，真实写权限仍由发布操作验证。

## 生产 Ansible 配置

所有连接参数从环境变量读取，inventory 没有硬编码主机、账号或部署目录。
与 Cormex 可共用主机、端口、密钥和 verified known_hosts；**`DEPLOY_DIR` 必须重新指向 Assay**，
不能沿用 Cormex 的目录。现有 `.env`、Compose 和生产卷是部署依据，不用模板覆盖。

| 变量 | 含义 |
| --- | --- |
| `DEPLOY_HOST`、`DEPLOY_USER`、`DEPLOY_DIR` | 必填；目标地址、SSH 用户、现有 Assay 的绝对目录 |
| `DEPLOY_PORT` | 默认 `22` |
| `DEPLOY_KNOWN_HOSTS` | 必填；已由可信渠道验证的 known_hosts 文件路径，不做首次连接自动信任 |
| `DEPLOY_SSH_KEY` | 可选；本机私钥路径，也支持已有 SSH agent |
| `DEPLOY_SSH_CONFIG` | 可选；本机 SSH 配置文件路径 |
| `DEPLOY_PASSWORD` | 可选 SSH 密码，环境注入，不写参数文件或命令行；推荐密钥 |
| `DEPLOY_BECOME` | 默认 `false`；非 root 用户需要提权时设置 `true` |
| `DEPLOY_BECOME_PASSWORD` | 可选提权密码；仅 Ansible 子进程可见 |
| `DEPLOY_OFFLINE` | `true` 导出并传输已经发布的本地镜像；默认 `false` 按 digest 拉取 |
| `LOCAL_CI_UPGRADE_BACKUP_DIR` | 仓库外的受保护生产副本，用于独立升级/回退演练 |

旧 `LOCAL_CI_DEPLOY_*` / `LOCAL_CI_SSH_CONFIG` 不再选择目标，避免两套参数意外连错机器。
严格主机指纹检查强制开启，不能通过继承的 `ANSIBLE_*` 环境变量关闭。
密码方式要求控制机上的 OpenSSH 支持 Ansible 的密码机制；优先使用密钥或 SSH agent。
目标用户须具备 Docker、现有目录及 `/run/lock` 的所需权限，或通过 become 提权。

```bash
# 设置以上目标变量，并取得符合 upgrade.py 格式的完整私有生产副本后：
task test:upgrade
task local:deploy
```

部署必须同时具备当前源码的完整验证、正式发布、生产副本升级及旧版本兼容演练记录。
不会因缺少记录降级为直接 `docker compose up`。原生产镜像 ID 与演练来源不同也会拒绝。
演练副本须含 PostgreSQL、对象归档/清单、来源与原运行镜像证明，详见
[升级说明](upgrade-v1.3.12.md) 及 `upgrade.py`。

Ansible 在目标创建独立 `0700` 操作目录，传送脚本后按 argv 执行，避免 stdin 被备份子进程消费。
镜像准备和配置预检后暂停 Web/API 写入，备份 PostgreSQL、全部 S3 对象及恢复配置，验证备份；
仅升级 API/Web，逐条检查原工单、正文、密码哈希、角色、附件绑定，检查通过才开放 Web。
数据库/Redis/RustFS 容器和数据卷必须保持。Samba Agent 不在此工单站点升级流程内。
成功后还必须取回精确匹配版本、镜像 ID、`dataPreserved=true` 的完成证明，才能登记部署成功。

失败时既有脚本尝试恢复原 Compose、环境配置和 API/Web；Ansible 会报告失败，日志保存在
本次操作目录 `ansible-deploy.log`。保留的备份、指纹、配置和日志都不上传到 GitHub。
应用回退不覆盖数据库，也不自动撤销迁移，避免覆盖部署后的新工单；数据库恢复须单独处理。

## GitHub Actions 路线

自动 push/PR 执行 `task check`（测试、应用镜像及整栈冒烟，不构建 CLI 发布包或发布），
使用 GitHub 托管 runner，会消耗托管额度。
手动 `github:*` 路线使用专用自托管 Linux x86_64 runner，标签为 **`assay-release`**，
避免依赖当前耗尽的托管额度，并在本地保留构建产物及敏感演练副本。
本改动只提供工作流，不自动注册 runner，也没有在生产机器安装 runner。

设置步骤：

1. 在可信构建机安装前述工具，按 GitHub 的 runner 注册向导添加 `assay-release` 标签。
   用 runner group/仓库权限限制到本仓库的可信工作流；不让不受信任 PR 在该机器执行。
2. 仓库变量 `ASSAY_CI_STATE_DIR` 指向 runner 用户拥有的私有持久目录，必须在 checkout 外。
   使用单台专用 runner；如有多台同标签机器，必须提供相同有效状态和镜像，否则安全检查会拒绝。
3. 创建 `release` Environment，限定可信 `main` 和版本标签。设置 `DOCKERHUB_TOKEN` secret，
   `DOCKERHUB_USERNAME` 普通变量。GitHub 自带的短期 token 用于 Release/标签，无需保存 PAT。
4. 创建 `production` Environment，限定相同可信分支/标签。设置 secrets `DEPLOY_HOST`、
   `DEPLOY_USER`、`DEPLOY_SSH_KEY`（**密钥内容**）、`DEPLOY_KNOWN_HOSTS`（**指纹文件内容**）；
   设置普通变量 `DEPLOY_DIR`，可选 `DEPLOY_PORT`、`DEPLOY_OFFLINE`、`DEPLOY_BECOME`，
   如需 sudo 则设置 secret `DEPLOY_BECOME_PASSWORD`。这与本地变量的“文件路径”表示不同，
   适配器会转换为临时 `0600` 文件，结束后清理。
5. 在专用 runner 的同一提交和状态目录完成私有生产副本 `task test:upgrade`。
   工作流不会下载公开备份或跳过演练；未准备好的部署必须失败。

```bash
# 源码已提交并推送，当前 checkout 与远端 main 相同：
task github:ci
task github:publish
# 确认 publish 成功，且同一 runner 上已有对应升级/回退演练记录后：
task github:deploy
```

`ASSAY_ACTIONS_REF` 默认 `main`，也可设为匹配当前提交的版本标签。
触发前查询远端 SHA 并与本地比较；runner 再次核对输入 SHA、版本及 checkout，防止分支漂移。
不能用 `latest`、未提交源码或不同版本的演练记录。
GitHub `deploy` job 只部署已验证的发布，不构建镜像；构建/发布 job 不注入生产凭据。
需要交互审批时可使用 GitHub Environment 的既有保护规则，Task 不另加确认弹窗。

## 产物及验证

输出在 `$LOCAL_CI_STATE_DIR/<版本>/`；测试容器属于唯一的 `assay-local-ci-*` 项目，端口只绑定回环，
结束只清理本次项目。源码摘要、提交号、镜像 ID、文件 SHA256 共同绑定每步记录。
同一状态目录的单步操作使用非阻塞锁，重叠执行会失败；GitHub 手动任务还有工作流级并发串行。

GitHub Release 含 Linux musl CLI、Windows MSVC CLI、Linux musl Samba Agent、`SHA256SUMS`、
`release-manifest.json`。草稿上传后下载校验再发布。镜像推送 `assay-api`、`assay-web`、
`assay-samba-agent` 的明确版本标签，拒绝覆盖已存在的其他产物，不更新 `latest`。

本次工具调整可单独验证，不需要重复发布旧版本或重启生产：

```bash
task tools:ansible
task deploy:check
task test:deployment
```

部署测试包含真实 Ansible 在临时本机 fixture 上的传送、执行、完成凭证回传和失败中止；
不连接生产、不复制真实用户数据。完整发布前仍需运行 `task local:ci` 和私有副本演练。
