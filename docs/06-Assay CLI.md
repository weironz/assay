# Assay CLI 与本地 MCP

`assay` 是 Assay 的跨平台命令行客户端。它复用系统的 REST API 与 RBAC 权限，
不会直连 PostgreSQL、Redis 或对象存储。除了供工程师在终端操作外，`assay mcp serve`
还能启动一个本地 stdio MCP Server，供 Codex、Claude Desktop 等 AI 客户端调用。

当前 CLI 版本独立于 Web/API 的 `v1.3.x` 版本，使用 `assay-cli-vX.Y.Z` Git 标签发布。

## 1. 安装

二进制来自 GitHub Release，安装器会下载 `SHA256SUMS` 并校验文件哈希，失败时不会安装。

### Linux

当前支持 `x86_64` Linux。执行：

```bash
curl -fsSL https://raw.githubusercontent.com/weironz/assay/main/cli/install.sh | sh
```

默认安装到 `~/.local/bin/assay`。如该目录不在 `PATH`，按安装器输出执行：

```bash
export PATH="$HOME/.local/bin:$PATH"
```

也可以指定目录：

```bash
curl -fsSL https://raw.githubusercontent.com/weironz/assay/main/cli/install.sh | sudo ASSAY_INSTALL_DIR=/usr/local/bin sh
```

### Windows PowerShell

在 PowerShell 执行：

```powershell
irm https://raw.githubusercontent.com/weironz/assay/main/cli/install.ps1 | iex
```

默认安装至 `$HOME\bin\assay.exe`，安装器会将该目录写入用户 `PATH`。请打开**新的**
PowerShell 窗口后验证：

```powershell
assay --version
```

如需自定义位置：

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/weironz/assay/main/cli/install.ps1))) -InstallDir 'C:\Tools\assay'
```

## 2. 认证与配置

Assay 当前 API 使用可撤销 Cookie 会话。CLI 登录成功后只保存会话 Cookie，不保存密码：

```bash
assay auth login --email you@greenstor.ai
assay auth whoami
```

自动化环境不应把密码放在命令行参数或 Shell 历史中：

```bash
printf '%s' "$ASSAY_PASSWORD" | assay auth login --email you@greenstor.ai --password-stdin
```

默认访问 `https://assay.cloudcele.com/api`。连接测试环境可任选一种方式：

```bash
assay config set-url http://localhost:3000/api
assay --base-url http://localhost:3000/api auth whoami
ASSAY_BASE_URL=http://localhost:3000/api assay auth whoami
```

配置位于操作系统用户配置目录下（Windows 通常是 `%APPDATA%\assay\config.json`，Linux 通常是
`~/.config/assay/config.json`）。自动化或 MCP 宿主可注入 `ASSAY_SESSION_COOKIE` 覆盖本地会话，
避免让 AI 管理登录密码。

## 3. 命令参数

所有命令可使用 `--help` 做逐层发现：

```text
assay --help
assay ticket --help
assay ticket comment --help
```

默认情况下，终端显示格式化 JSON；非交互调用输出单行 JSON，适合脚本和 AI 解析。使用
`--output pretty` 可强制格式化，`--output json` 可强制单行 JSON。

### 身份与配置

| 命令 | 说明 |
| --- | --- |
| `assay auth login --email <邮箱>` | 交互式登录，安全读取密码。 |
| `... --password-stdin` | 从标准输入读取密码，适用于 CI。 |
| `assay auth logout` | 注销服务器会话并清除本地 Cookie。 |
| `assay auth whoami` | 输出当前用户、角色和权限。 |
| `assay config set-url <URL>` | 设置默认 API 地址；会自动补全 `/api`。 |
| `assay config show` | 显示地址、会话是否存在和配置文件位置，不泄露 Cookie。 |

### 工单

| 命令 | 参数 | 说明 |
| --- | --- | --- |
| `assay ticket list` | `--status` `--priority` `--keyword` `--assignee-id` `--page` `--page-size` | 返回当前身份可见的工单；`page-size` 最大 100。 |
| `assay ticket get <id>` | 工单数据库 ID 或工单号 | 返回详情、讨论、附件、SLA 与协作成员。 |
| `assay ticket comment <id> --body <文本>` | `--internal` `--mention-user-id <用户ID>` | 立即写入一条评论；`--internal` 为内部备注；提及参数可重复。 |
| `assay ticket comment <id> --body -` | 标准输入 | 从管道读取评论正文，例如 `printf '...' | assay ticket comment WO-... --body -`。 |

工单权限始终由服务端执行。CLI 不会绕过提单人、处理人、主管、观察员和管理员的 RBAC 规则。

## 4. 自动更新

```bash
assay update --check   # 只检查
assay update           # 下载、校验 SHA-256 并替换当前可执行文件
```

Linux 会立即替换文件。Windows 会在当前进程退出后，通过短暂的本地更新脚本替换 `assay.exe`；
下一次打开终端即可使用新版本。更新仅接受 `assay-cli-v*` 的稳定 GitHub Release 及其
`SHA256SUMS` 校验文件。

## 5. MCP 集成

先在当前系统用户下执行一次 `assay auth login`，然后添加 MCP 配置：

```json
{
  "mcpServers": {
    "assay": {
      "command": "assay",
      "args": ["mcp", "serve"]
    }
  }
}
```

MCP 使用 stdio，**stdout 只输出 JSON-RPC 协议数据**。不要在 `mcp serve` 前面套输出日志的
Shell 脚本。若 MCP 宿主有专用服务身份，建议注入短生命周期的会话 Cookie：

```json
{
  "mcpServers": {
    "assay": {
      "command": "assay",
      "args": ["mcp", "serve"],
      "env": { "ASSAY_SESSION_COOKIE": "<由宿主安全注入>" }
    }
  }
}
```

当前 MCP 工具：

| 工具 | 行为 | 风险级别 |
| --- | --- | --- |
| `assay_ticket_get` | 读取详情、讨论、附件元数据和协作成员 | 只读 |
| `assay_ticket_search` | 搜索当前身份可见的工单 | 只读 |
| `assay_ticket_add_comment` | 写入评论或内部备注，并可提及用户 | 写操作；AI 必须先获得用户明确确认 |

MCP 工具会经过与 Web 相同的 API 鉴权、权限检查和审计记录。AI 不应持有管理员账号；生产环境建议为它创建权限最小化的专用服务账号。

## 6. 发布维护者说明

创建并推送 `assay-cli-vX.Y.Z` 标签会触发 `.github/workflows/cli-release.yml`，构建 Linux
`x86_64` 和 Windows `x86_64` 二进制，生成 `SHA256SUMS` 并创建 GitHub Release。示例：

```bash
git tag -a assay-cli-v0.1.0 -m "Release Assay CLI v0.1.0"
git push origin assay-cli-v0.1.0
```

发布后，安装器与 `assay update` 会自动发现该最新稳定 CLI Release。
