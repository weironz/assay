# Assay CLI 与本地 MCP

`assay` 是 Assay 的跨平台命令行客户端。它复用系统的 REST API 与 RBAC 权限，
不会直连 PostgreSQL、Redis 或对象存储。除了供工程师在终端操作外，`assay mcp serve`
还能启动一个本地 stdio MCP Server，供 Codex、Claude Desktop 等 AI 客户端调用。

CLI 与 Web/API 使用同一产品版本，统一使用 `v1.3.x` Git 标签发布。

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

CLI 支持两种认证方式：可撤销 Cookie 会话，或从 Web「设置 → API Token」创建的个人
Bearer Token。登录成功后只保存会话 Cookie，不保存密码：

```bash
assay auth login --email you@greenstor.ai
assay auth whoami
```

自动化环境不应把密码放在命令行参数或 Shell 历史中：

```bash
printf '%s' "$ASSAY_PASSWORD" | assay auth login --email you@greenstor.ai --password-stdin
```

Token 更适合 MCP 与自动化；不要把它放进命令行参数或 Shell 历史。创建后通过标准输入保存：

```bash
printf '%s' "$ASSAY_TOKEN" | assay auth token --token-stdin
assay auth whoami
```

Token 用于提单时，在 **设置 → API Token** 勾选 **创建工单 (`ticket:create`)**；系统会同时
选中读取权限。需要后续回复时也勾选 `ticket:comment`。账号本身必须拥有对应权限，
例如提单人角色。已有只读 Token 以及它的轮换版本不会自动获得新权限，需要新建并更新凭据。

### 为 MCP 创建专用访问令牌

1. 使用专门的 Assay 账号登录目标站点，确认该账号只具有需要的业务角色。
2. 点击右上角账号 → **设置 → API Token**，填写易识别的名称和有效期。
3. 查询/下载需要 `ticket:read`；新建工单和上传或删除草稿需要 `ticket:create`；向已有工单上传或删除本人附件需要 `ticket:comment`。只勾选实际需要的权限，系统会按规则自动包含读取权限。
4. 点击创建并完成系统要求的身份验证。令牌仅在创建时完整显示，立即存入受保护的密钥管理器；不要放入聊天、Git、命令参数或日志。
5. 在 MCP 运行环境中配置 `ASSAY_BASE_URL=https://ticket.greenstor.ai/api`，并通过宿主密钥机制注入 `ASSAY_TOKEN`；或者通过 `assay auth token --token-stdin` 读取令牌，CLI 会在当前用户的配置目录以受限权限保存。运行 `assay auth whoami` 确认身份与权限。
6. 令牌过期、泄露或不再使用时，在同一页面轮换或吊销，并更新宿主机密。账号权限变更会影响令牌的有效权限。

默认访问 `https://assay.cloudcele.com/api`。连接测试环境可任选一种方式：

```bash
assay config set-url http://localhost:3000/api
assay --base-url http://localhost:3000/api auth whoami
ASSAY_BASE_URL=http://localhost:3000/api assay auth whoami
```

配置位于操作系统用户配置目录下（Windows 通常是 `%APPDATA%\assay\config.json`，Linux 通常是
`~/.config/assay/config.json`）。自动化或 MCP 宿主可注入 `ASSAY_TOKEN`（优先）或
`ASSAY_SESSION_COOKIE` 覆盖本地凭据，避免让 AI 管理登录密码。

## 3. 命令参数

所有命令可使用 `--help` 做逐层发现：

```text
assay --help
assay ticket --help
assay ticket create --help
assay ticket comment --help
```

默认情况下，终端显示格式化 JSON；非交互调用输出单行 JSON，适合脚本和 AI 解析。使用
`--output pretty` 可强制格式化，`--output json` 可强制单行 JSON。

### 身份与配置

| 命令 | 说明 |
| --- | --- |
| `assay auth login --email <邮箱>` | 交互式登录，安全读取密码。 |
| `... --password-stdin` | 从标准输入读取密码，适用于 CI。 |
| `assay auth token --token-stdin` | 从标准输入保存个人 API Token，并立即验证。 |
| `assay auth logout` | 注销服务器会话并清除本地 Cookie。 |
| `assay auth whoami` | 输出当前用户、角色和权限。 |
| `assay config set-url <URL>` | 设置默认 API 地址；会自动补全 `/api`。 |
| `assay config show` | 显示地址、Token/会话是否存在和配置文件位置，不泄露凭据。 |

### 工单

| 命令 | 参数 | 说明 |
| --- | --- | --- |
| `assay ticket create --input <JSON文件>` | `--dry-run` | 以当前身份创建工单，返回工单 ID 和工单号等详情；`--dry-run` 仅校验并输出请求预览，不要求登录。 |
| `assay ticket create --input -` | 标准输入 | 从管道读取 UTF-8 JSON 请求。 |
| `assay ticket upload <文件路径>` | `--ticket <工单号或 ID>` | 不指定工单时上传草稿附件；指定工单时直接上传。草稿 ID 可在建单的 `attachmentIds` 中使用。 |
| `assay ticket attachments <工单号或 ID>` | | 列出可访问的附件。 |
| `assay ticket download <附件 ID> <目标路径>` | | 下载到新文件；不覆盖已有文件。 |
| `assay ticket delete-attachment <附件 ID>` | | 删除本人上传的附件，正文引用中的附件需先移除引用。 |
| `assay ticket list` | `--status` `--priority` `--keyword` `--assignee-id` `--page` `--page-size` | 返回当前身份可见的工单；`page-size` 最大 100。 |
| `assay ticket get <id>` | 工单数据库 ID 或工单号 | 返回详情、讨论、附件、SLA 与协作成员。 |
| `assay ticket comment <id> --body <文本>` | `--internal` `--mention-user-id <用户ID>` | 立即写入一条评论；`--internal` 为内部备注；提及参数可重复。 |
| `assay ticket comment <id> --body -` | 标准输入 | 从管道读取评论正文，例如 `printf '...' | assay ticket comment WO-... --body -`。 |

工单权限始终由服务端执行。CLI 不会绕过提单人、处理人、主管、观察员和管理员的 RBAC 规则。

### 提单示例

JSON 与 [REST API 建单接口](04-API.md#32-创建工单) 的字段一致：`title` 和 `body` 必填，
正文为 HTML；不传 `priority` 时默认 `MEDIUM`，不传 `typeId` 时使用系统兜底 SLA。
`typeId`、`categoryId`、`datacenterId` 等字段使用已有记录的数据库 ID，
不能直接填展示名称。没有合适分类时可传 `categoryName`。联系方式 `contact`、设备序列号
`serialNumber` 和已上传的草稿 `attachmentIds` 也受支持。

```bash
# 先预览，确认输入有效；不会提交
assay ticket create --input ticket.json --dry-run

# 提交同一份文件
assay ticket create --input ticket.json

# 或从标准输入提交
printf '%s' '{"title":"B300 掉卡","body":"<p>节点重启后缺少两张 GPU。</p>","priority":"HIGH","categoryName":"GPU卡"}' \
  | assay ticket create --input -
```

CLI 建单参数校验失败会在 stderr 输出 JSON 错误并非零退出，API 的 `401`/`403` 也会作为失败返回。
预览只校验请求字段和格式；记录是否存在、联系方式邮箱、附件归属及权限由服务端验证。
CLI 不会自动重试建单。网络超时或响应丢失时，先用 `assay ticket list --keyword <标题>`
检查是否已建单，再决定是否重新提交，避免重复工单。

## 4. 自动更新

```bash
assay update --check   # 只检查
assay update           # 下载、校验 SHA-256 并替换当前可执行文件
```

Linux 会立即替换文件。Windows 会在当前进程退出后，通过短暂的本地更新脚本替换 `assay.exe`；
下一次打开终端即可使用新版本。更新仅接受带有 CLI 安装包的稳定 `v*` GitHub Release 及其
`SHA256SUMS` 校验文件。

## 5. MCP 集成

先在当前系统用户下执行一次 `assay auth login` 或 `assay auth token --token-stdin`，然后添加 MCP 配置：

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
Shell 脚本。若 MCP 宿主有专用服务身份，建议注入最小权限、有限期的 API Token：

```json
{
  "mcpServers": {
    "assay": {
      "command": "assay",
      "args": ["mcp", "serve"],
      "env": { "ASSAY_TOKEN": "<由宿主安全注入>" }
    }
  }
}
```

当前 MCP 工具：

| 工具 | 行为 | 风险级别 |
| --- | --- | --- |
| `assay_ticket_create` | 以当前身份创建工单，字段与 REST API 相同；`dryRun: true` 时仅返回请求预览 | 写操作；用户已授权提单时调用，需要 `ticket:create` |
| `assay_attachment_upload` | 上传 MCP 服务所在机器上的文件为草稿附件，返回附件 ID | 写操作；仅上传用户明确授权的文件 |
| `assay_attachment_list` | 列出有权查看的工单附件 | 只读 |
| `assay_attachment_download` | 下载附件到本地新文件，不覆盖已有文件 | 读取附件并写本地文件 |
| `assay_attachment_delete` | 删除本人上传的附件；被正文引用时先移除引用 | 写操作；需用户明确要求，且具有对应工单权限 |
| `assay_ticket_get` | 读取详情、讨论、附件元数据和协作成员；传 `includeImages: true` 时也返回图片内容 | 只读 |
| `assay_ticket_search` | 搜索当前身份可见的工单 | 只读 |
| `assay_ticket_add_comment` | 写入评论或内部备注，并可提及用户 | 写操作；AI 必须先获得用户明确确认 |

MCP 工具会经过与 Web 相同的 API 鉴权、权限检查和审计记录。AI 不应持有管理员账号；生产环境建议为它创建权限最小化的专用服务账号。

创建工具示例：

```json
{ "title": "B300 掉卡", "body": "<p>节点重启后缺少两张 GPU。</p>", "priority": "HIGH", "dryRun": true }
```

提交时去掉 `dryRun` 或设为 `false`。成功返回工单详情；API 拒绝会返回 MCP `isError: true`。
结果未知时先搜索确认，工具声明为非幂等操作，不应自动重复调用。

### 5.1 工单图片读取

`assay_ticket_get` 默认只返回文字与附件元数据。需要分析截图时，在同一次调用中传入：

```json
{ "id": "WO-20260905-0001", "includeImages": true }
```

MCP 会通过原有工单权限读取图片附件并返回可视觉识别的图片内容。单次最多 4 张、单张最多
10MB；图片较多时传 `imageIds` 指定最多 4 个附件 ID。非图片附件、超大图片和无权访问的
附件不会被读取。

## 6. 发布维护者说明

在 GitHub Actions 手动运行 `CI / CD`，并填写 `release_version`（如 `1.3.5`），流水线会在
测试、镜像部署和健康校验全部成功后，构建 Linux `x86_64` 与 Windows `x86_64` 二进制、生成
`SHA256SUMS`、创建 `v1.3.5` 标签与 GitHub Release。示例：

```bash
gh workflow run ci-cd.yml -f release_version=1.3.5
gh run watch
```

发布后，安装器与 `assay update` 会自动发现带有安装包的最新稳定产品 Release。

> 从旧的 `assay-cli-v0.1.x` 迁移时，流水线会额外生成一次同版本的兼容更新入口；它只为让
> 已安装的旧 CLI 自动升级，产品正式 Release 始终以 `v1.3.x` 为准。
