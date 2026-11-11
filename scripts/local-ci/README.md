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

## Agent 接手：先检查什么

本说明是现行发布流程的维护入口，`AGENTS.md` 和根 README 均链接到这里。无需依赖历史聊天、
某台开发机的临时脚本或已有登录状态。环境初始化、网络接入和灾难恢复见
[部署文档](../../docs/05-部署文档.md)，生产副本格式见 [升级演练说明](upgrade-v1.3.12.md)。
版本示例及历史发布记录不代表当前生产状态，接手时须重新核对。

1. 阅读根 `AGENTS.md`，检查当前任务与已有授权要求的是修代码、构建、发布，还是更新指定生产环境。
   发布与部署分开执行，普通代码提交不自动触发这两步。
2. 检查 `git status --short`、当前分支及 `git fetch origin main` 后的差异，保留其他人的改动。
   新工作区应在目标提交上开始；已有改动的工作区先处理差异，不执行强制重置或强推。
3. 核对根/API/Web `package.json`、CLI/Agent `Cargo.toml` 与相应锁文件的版本，
   并检查 GitHub Release/标签是否已经存在。已发布版本不可覆盖；只有文档或工具修改时，
   不需要为验证说明而重复发布旧版本。
4. 运行 `task --list`；需要发布时按下文安装控制机工具、注入环境变量并运行 `task doctor`。
   只核对变量是否配置和权限是否足够，不打印令牌、生产 `.env` 或私钥。
5. 选择本地或 GitHub 路线，检查对应执行机的状态目录、镜像和记录是否仍匹配当前提交。
   本地记录不会自动传给 GitHub runner；缺失或过期时在选定执行机重新验证。
6. 涉及生产时核对 `DEPLOY_HOST`、`DEPLOY_DIR`、实际 Compose 项目、原 API/Web 镜像 ID、
   数据卷和备份位置。生产运行版本以该目标机器为准，不能由仓库版本或 Release 推断。
   文件服务器上的 Assay/Samba 与阿里云工单站点是不同目标，本流程默认只更新所选站点的 API/Web。

### 一次发布的执行顺序

先完成改动、必要验证和提交推送，再对最终提交执行 CI；提交、源码摘要或产物变化后，旧记录失效。
以下命令假定已完成工具与变量配置；默认使用包内版本，显式传 `VERSION` 时所有步骤必须一致。

```bash
task local:ci               # 全部测试、三镜像、CLI 发布包和整栈检查
task status                 # 查看本机记录；存在记录不等于记录仍有效
task local:publish          # 推 Docker Hub 和 GitHub Release；不更新生产

# 仅当本次目标包含生产部署：在同一执行机准备该生产的私有完整副本，
# 设置 LOCAL_CI_UPGRADE_BACKUP_DIR，核对 DEPLOY_* 后继续。
task test:upgrade           # 恢复、迁移、数据/对象校验及旧程序兼容演练
task local:deploy           # Ansible：最终停写备份、更新、校验、开放 Web
```

只发布时执行到 `local:publish` 即完成对应目标。GitHub 路线用 `github:ci` / `github:publish` /
`github:deploy` 提交相应阶段；其中 `github:publish` 会再执行完整 CI。
生产演练仍须在专用 runner 的同一状态目录完成，再触发 `github:deploy`，详见下文。
不要并行对同一状态目录运行两条发布流程，也不要复制/编辑 JSON 记录来跳过演练。

### 实现在哪里

| 文件 | 职责 |
| --- | --- |
| [`Taskfile.yml`](../../Taskfile.yml) | 所有人工/Agent 触发入口及任务顺序 |
| [`.github/workflows/ci-cd.yml`](../../.github/workflows/ci-cd.yml) | 自动检查、手动构建发布、独立生产部署 job；调用同一 Taskfile |
| [`run.py`](run.py) | 源码与产物校验记录、测试/构建、镜像推送、Release 与部署前置检查 |
| [`actions.py`](actions.py)、[`actions_check.py`](actions_check.py)、[`actions_deploy.py`](actions_deploy.py) | Actions 提交/SHA 核对、runner 检查、临时密钥文件适配 |
| [`deployment.py`](deployment.py)、[`deploy/ansible`](../../deploy/ansible) | 环境变量目标、严格主机校验、Ansible 传送/执行与完成凭证回传 |
| [`deploy.sh`](deploy.sh)、[`deploy_config.py`](deploy_config.py) | 主机锁、配置边界、最终备份、仅 API/Web 更新、失败恢复 |
| [`backup.sh`](../backup.sh)、[`backup-s3.cjs`](../backup-s3.cjs) | PostgreSQL、S3 当前对象、配置与恢复密钥备份 |
| [`upgrade.py`](upgrade.py)、[`db_fingerprint.py`](db_fingerprint.py) | 隔离恢复、升级/旧程序兼容演练及原记录完整性校验 |

### 如何判断完成与交接

| 阶段 | 必须核对的证据 |
| --- | --- |
| 代码同步 | 当前提交 SHA 与远端目标分支一致；不是仅有本地 commit |
| CI | 当前源码的测试/构建记录有效；GitHub 路线还须确认相应 run 最终成功，不能只看 dispatch 成功 |
| 发布 | 正式 Release URL/标签、附件 SHA256、`release-manifest.json` 和 Docker Hub 三镜像 digest 相符 |
| 生产演练 | 当前目标镜像的 `upgrade.json`，包含数据保留、对象校验、`rollbackCompatible` 及原生产镜像证明 |
| 部署 | 目标上的 `deployment-result.json` 精确匹配版本、API/Web 镜像 ID、`dataPreserved=true`，且控制端登记 `deployed.json` |
| 生产验收 | 实际 API/Web 版本及健康、站点访问/权限和附件检查；明确未能执行或未通过的项目 |

`task status` 仅列出记录名称，真正的源码/产物一致性由执行后续步骤时检查；不能用“文件存在”代替验证。
部署返回成功也不代替无法从控制机验证的浏览器或业务检查。发现外网策略限制时，分别报告
主机健康和公网验收的结果，不把未验收写成通过。

交接报告至少列：源码提交、Release 版本/URL、实际部署目标与运行版本、CI/run 或本地验证结果、
备份/操作目录、数据保留结果，以及未完成项。未发布、未部署就明确写明。
备份、密钥、客户附件和生产副本留在受保护位置，不加入 Git、Release 或公开 Actions artifact。
失败时先保留操作目录与日志，按下文恢复规则处理；不删除业务卷或直接用旧数据库覆盖当前写入。

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

既有 Samba 文件服务器使用独立的 `samba:backup`、`local:deploy:samba`、`samba:runtime`、`samba:policy` 入口，
同样通过 Ansible，详见 [部门禁删与领导访问](../../docs/samba/03-目录禁删权限.md)。
部署后先用 `samba:runtime` 核对已发布程序和备份，再做策略维护。仅变更运维工具时，
提交并执行 `test:deployment` 后可重新登记运行证明；应用源码变化必须走完整新发布。
新运维源码与原发布源码分别记录，原 CI/发布/部署记录保持不变。
不要把阿里云 S3 工单站点的部署任务直接指向本地附件存储的公司栈。

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

当前工作流仅允许手动 `workflow_dispatch`，push/PR 不自动消耗 Actions 额度。
本地可随时执行 `task check`（测试、应用镜像及整栈冒烟，不构建 CLI 发布包或发布）。
手动 `github:*` 路线使用专用自托管 Linux x86_64 runner，标签为 **`assay-release`**，
可在托管额度不足时继续使用，并在本地保留构建产物及敏感演练副本。
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
