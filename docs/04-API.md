# Assay 工单系统 REST API

面向脚本、集成与二次开发。本文所有接口、参数、权限码均与代码逐一核对过，
示例响应取自真实调用。

- 基地址：`https://assay.cloudcele.com/api`（开发环境 `http://localhost:3000/api`）
- 编码：请求与响应均为 `application/json; charset=utf-8`（文件上传除外）
- 前端本身就是这套 API 的消费者，**界面能做的操作 API 都能做**

---

## 1. 认证

> **当前只支持 Cookie 会话认证。**
> 不支持 HTTP Basic，也不支持 API Token / Bearer —— 两者实测均返回 401。
> 脚本调用需要先登录拿到会话 Cookie，再带着它访问后续接口。
> 如需长期集成，建议先补 API Token 机制（见文末「已知限制」）。

### 1.1 登录

```
POST /api/auth/sign-in/email
Content-Type: application/json

{ "email": "you@example.com", "password": "••••••" }
```

响应 `200`，并通过 `Set-Cookie` 下发会话。后续请求带上该 Cookie 即可。

### 1.2 curl 完整示例

```bash
BASE=https://assay.cloudcele.com/api
JAR=$(mktemp)

# 登录，把会话存进 cookie jar
curl -s -c "$JAR" -X POST "$BASE/auth/sign-in/email" \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"你的密码"}'

# 之后所有请求带 -b "$JAR"
curl -s -b "$JAR" "$BASE/me"
curl -s -b "$JAR" "$BASE/tickets?status=NEW&pageSize=20"
```

### 1.3 登出

```
POST /api/auth/sign-out
```

### 1.4 注意事项

- **登录接口有限流**：同一 IP 每 60 秒 5 次。脚本请缓存会话，不要每次调用都重新登录。
- 会话有有效期，长时间运行的脚本需要处理 401 并重新登录。
- 密码重置、邮箱验证等接口由 better-auth 提供，路径均在 `/api/auth/*` 下。

---

## 2. 通用约定

### 2.1 错误格式

所有错误统一为这个形状：

```json
{ "message": "未登录", "error": "Unauthorized", "statusCode": 401 }
```

参数校验失败时 `message` 是字符串数组：

```json
{
  "message": [
    "title must be longer than or equal to 1 characters",
    "body must be a string"
  ],
  "error": "Bad Request",
  "statusCode": 400
}
```

| 状态码 | 含义 |
| --- | --- |
| 400 | 参数校验失败 |
| 401 | 未登录 / 会话失效 / 账号被禁用 |
| 403 | 已登录但缺少权限，或不满足业务归属（如非提单人删单） |
| 404 | 资源不存在 |
| 409 | 状态机冲突（如当前状态不允许该流转动作） |
| 413 | 上传文件超过大小上限 |

### 2.2 权限码

接口表格里的「权限」列对应 RBAC 权限码。角色与权限的对应关系：

| 角色 | 权限 |
| --- | --- |
| `requester` 提单人 | `ticket:create` `ticket:read` `ticket:update` `ticket:comment` `ticket:transition` |
| `handler` 处理人 | `ticket:read` `ticket:update` `ticket:transition` `ticket:comment` |
| `supervisor` 主管 | handler 全部 + `ticket:read:all` `ticket:assign` `stats:view` |
| `ticket_viewer_all` 工单观察员（全局只读） | `ticket:read` `ticket:read:all` |
| `admin` 管理员 | 全部权限 |

角色为固定岗位定义，由代码与 seed 同步维护，Web 端只能把既有角色分配给用户，不能拼装或改写权限。
`ticket_viewer_all` 是全局只读角色：可查看全部工单、历史、附件及对应仪表盘汇总，但不授予编辑、回复、
上传、删除、状态流转、分派或用户管理权限；内部备注仍仅对内部处理角色可见。

### 2.3 分页

列表接口统一返回：

```json
{ "items": [ ... ], "total": 9, "page": 1, "pageSize": 20 }
```

---

## 3. 工单

### 3.1 查询工单列表

```
GET /api/tickets
```
权限：`ticket:read`

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `status` | string | 状态枚举，见 §7 |
| `priority` | string | `LOW` `MEDIUM` `HIGH` `URGENT` |
| `queueId` | string | 队列 id |
| `assigneeId` | string | 处理人 id |
| `categoryId` | string | 分类 id |
| `keyword` | string | 模糊匹配标题或工单号 |
| `page` | int | 默认 1 |
| `pageSize` | int | 默认 20，最大 100 |
| `sort` | string | `createdAt`(默认) `updatedAt` `priority` `status` |
| `order` | string | `asc` / `desc`(默认) |

```json
{
  "total": 9,
  "page": 1,
  "pageSize": 1,
  "items": [
    {
      "id": "cmtide69w0001n466fohj1jet",
      "ticketNo": "WO-20260901-0003",
      "title": "BKK-CL02 两张 B300 掉卡",
      "status": "NEW",
      "priority": "HIGH",
      "category": { "id": "cmtid9v1z000ln43tqk8jgkid", "name": "B300" },
      "assignee": null,
      "createdAt": "2026-09-01T07:53:05.348Z",
      "slaDueAt": "2026-09-02T09:47:35.928Z"
    }
  ]
}
```

### 3.2 创建工单

```
POST /api/tickets
```
权限：`ticket:create`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `title` | string | ✅ | 至少 1 字符 |
| `body` | string | ✅ | 首条消息正文，HTML |
| `priority` | string | | `LOW` `MEDIUM` `HIGH` `URGENT`，默认 `MEDIUM` |
| `typeId` | string | | 工单类型 id，**决定 SLA 时限** |
| `categoryId` | string | | 分类 id |
| `categoryName` | string | | 下拉里没有合适分类时自填（≤60 字符）。与 `categoryId` 二选一，同时给出以 `categoryId` 为准；服务端忽略大小写查重后复用或新建 |
| `queueId` | string | | 队列 id |
| `datacenterId` | string | | 机房 id |
| `clusterId` | string | | 集群 id |
| `serialNumber` | string | | 设备序列号（≤200 字符） |
| `contact` | object | | 联系方式，见下 |
| `saveContactAsDefault` | boolean | | 把该联系方式存为本人默认，下次建单自动带出 |
| `attachmentIds` | string[] | | 预先上传的附件 id，见 §5 |

`contact` 结构：

| 字段 | 类型 | 必填 | 取值 |
| --- | --- | --- | --- |
| `phone` | string | ✅ | 1–40 字符，**不校验格式**（分机、境外号码写法差异太大） |
| `callTime` | string | ✅ | `ANY` `WEEKDAY_9_18` `WEEKDAY_9_22` `DAILY_9_22` `NONE` |
| `smsTime` | string | ✅ | 同上 |
| `position` | string | | `TECH_LEAD` `OPS_LEAD` `FINANCE` `CEO` `OTHER` |
| `emails` | string[] | | 最多 5 个，需为合法邮箱 |

> 时间和职位存的是**枚举键**而非展示文案，界面按当前语言翻译。

```bash
curl -s -b "$JAR" -X POST "$BASE/tickets" -H 'Content-Type: application/json' -d '{
  "title": "BKK-CL02 两张 B300 掉卡",
  "body": "<p>节点重启后 nvidia-smi 少两张卡，PCIe 链路降到 x8。</p>",
  "priority": "HIGH",
  "typeId": "<故障类型id>",
  "datacenterId": "<机房id>",
  "clusterId": "<集群id>",
  "serialNumber": "SN-B300-0042, SN-B300-0043",
  "contact": { "phone": "13800138021", "callTime": "ANY", "smsTime": "ANY", "emails": [] }
}'
```

返回创建后的工单详情（同 §3.3）。

### 3.3 工单详情

```
GET /api/tickets/:id
```
权限：`ticket:read`

在列表字段基础上额外包含：`messages`（往来消息，**提单人和关注人看不到内部备注**）、
`participants`（协作成员 / 关注人）、`availableActions`（当前用户可执行的流转动作）、`type`、`datacenter`、`cluster`、
`serialNumber`、`contact`、`firstResponseAt`、`firstResponseDueAt`。

### 3.4 修改工单

```
PATCH /api/tickets/:id
```
权限：`ticket:update`（服务层还要求是本人工单或内部人员）

可改字段：`title` `priority` `typeId` `categoryId` `queueId` `serialNumber`
`datacenterId` `clusterId` `contact`。传 `contact: null` 可清空联系方式。

### 3.5 指派

```
POST /api/tickets/:id/assign
{ "assigneeId": "<用户id>", "queueId": "<可选>" }
```
权限：`ticket:assign`。仅 `NEW` / `REOPENED` 状态可指派，指派后状态变为 `ASSIGNED`。

### 3.6 状态流转

```
POST /api/tickets/:id/transition
{ "action": "start" }
```
权限：`ticket:transition`

| action | 从 | 到 | 谁能做 |
| --- | --- | --- | --- |
| `start` | ASSIGNED | IN_PROGRESS | 处理人本人 / admin |
| `hold` | IN_PROGRESS | PENDING | 处理人本人 / admin |
| `resume` | PENDING | IN_PROGRESS | 处理人本人 / admin |
| `resolve` | IN_PROGRESS | RESOLVED | 处理人本人 / admin |
| `close` | RESOLVED | CLOSED | 提单人 / supervisor / admin |
| `reopen` | RESOLVED, CLOSED | REOPENED | 提单人 / supervisor / admin |
| `cancel` | NEW, ASSIGNED | CANCELLED | 提单人 / admin |

不满足前置状态返回 `409`，角色或归属不符返回 `403`。
当前可执行的动作可直接读工单详情的 `availableActions`。

### 3.7 消息

```
GET  /api/tickets/:id/messages           权限 ticket:read
POST /api/tickets/:id/messages           权限 ticket:comment
PATCH /api/tickets/:id/messages/:msgId   权限 ticket:comment
```

请求体：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `body` | string | ✅ | HTML，服务端会做 XSS 消毒 |
| `isInternal` | boolean | | 内部备注，**仅内部人员可发，提单人看不到** |
| `contentType` | string | | 默认 `text/html` |
| `mentionUserIds` | string[] | | 可选；仅能提及本工单的协作相关人员，收到 `MENTION` 通知 |

编辑消息限作者本人或 admin / supervisor。

### 3.8 协作成员与关注人

主处理人始终由 `assigneeId` 唯一承担，负责 SLA 与状态流转。协作成员与关注人不改变主责：

| 身份 | 可见范围 | 可执行操作 | 通知 |
| --- | --- | --- | --- |
| 协作成员 `COLLABORATOR` | 工单、历史、附件、内部备注 | 回复、内部讨论、上传附件 | 消息、状态变化、@ 提及 |
| 关注人 `FOLLOWER` | 工单、历史、附件；不含内部备注 | 无 | 消息、状态变化、@ 提及 |

以下接口均要求 `ticket:read`，服务端额外要求调用者是该工单的主处理人、主管或管理员：

```
GET    /api/tickets/:id/participants
GET    /api/tickets/:id/participant-candidates
POST   /api/tickets/:id/participants
DELETE /api/tickets/:id/participants/:userId
```

新增或更新成员：

```json
{ "userId": "<用户id>", "role": "COLLABORATOR" }
```

`role` 可取 `COLLABORATOR` 或 `FOLLOWER`。提单人与主处理人已有天然访问权，不能重复作为协作成员加入。

### 3.9 操作历史

```
GET /api/tickets/:id/history
```
权限：`ticket:read`

返回数组，每项含 `action` `field` `oldValue` `newValue` `createdAt` `user`。
**`user` 为 `null` 表示系统自动操作**（如 SLA 超时自动升级优先级）。

### 3.10 删除工单

```
DELETE /api/tickets/:id
```
权限：`ticket:read` + 服务层判定「admin 或提单人本人」。

> ⚠️ **级联删除**：消息、历史、附件记录一并删除，不可恢复。
> 只是不想要了、但要保留痕迹，请用 `cancel` 流转。

---

## 4. 元数据

| 方法与路径 | 权限 | 说明 |
| --- | --- | --- |
| `GET /api/categories` | 登录 | 分类列表（树形结构，含 `parentId`） |
| `POST /api/categories` | `user:manage` | 建分类 `{ name, parentId? }` |
| `GET /api/ticket-types` | 登录 | 工单类型，含 `slaResponseMin` `slaResolveMin` |
| `POST /api/ticket-types` | `queue:manage` | 建类型 `{ name, slaResponseMin, slaResolveMin }` |
| `PATCH /api/ticket-types/:id` | `queue:manage` | 改类型 / SLA 时限，均为 1–525600 分钟 |
| `GET /api/datacenters` | 登录 | 机房列表 |
| `GET /api/clusters` | 登录 | 集群列表，含 `datacenterId` |
| `GET /api/tags` | 登录 | 标签列表 |
| `POST /api/tags` | `ticket:update` | 建标签 `{ name, color? }` |
| `GET /api/queues` | 登录 | 队列列表 |
| `POST /api/queues` | `queue:manage` | 建队列 `{ name, description?, defaultAssigneeId? }` |
| `PATCH /api/queues/:id` | `queue:manage` | 改队列 |
| `DELETE /api/queues/:id` | `queue:manage` | 删队列 |
| `GET /api/assignees` | 登录 | 可指派的处理人（handler / admin 且状态正常） |
| `GET /api/roles` | `user:manage` | 固定岗位角色列表，仅用于为用户分配角色 |

> **改 SLA 只影响之后新建的工单。**在跑的工单截止时刻在建单时就算好了，
> 改配置不会回溯，避免处理人眼里的「还剩多久」凭空跳变。

---

## 5. 附件

### 5.1 规则

| 项目 | 限制 |
| --- | --- |
| 单文件大小 | **512 MB** |
| 单张工单附件数 | 5 个（界面约束，正文内联图片不计入） |
| 允许扩展名 | `.png .jpeg .jpg .txt .rar .zip .doc .docx .xls .xlsx .7z .mp4` |

`kind` 参数区分两种用途，校验规则不同：

- `kind=attachment`（默认）：受上面的扩展名白名单约束
- `kind=inline`：正文内联图片，**只要求是图片格式**（截图常为 webp/gif，
  套白名单会让粘贴功能失效）

超过大小返回 `413`，格式不符返回 `400`。

### 5.2 建单前上传（草稿）

```
POST /api/uploads?kind=attachment
Content-Type: multipart/form-data，字段名 file
```
权限：`ticket:create`

返回 `{ id, fileName, fileSize, mime, url }`。把 `id` 放进建单请求的
`attachmentIds` 即可挂到新工单上。

### 5.3 上传到已有工单

```
POST /api/tickets/:id/attachments?kind=attachment&messageId=<可选>
```
权限：`ticket:comment`

### 5.4 列出与下载

```
GET /api/tickets/:id/attachments        权限 ticket:read
GET /api/attachments/:id/download       权限 ticket:read
```

下载接口鉴权后以流式转发文件，图片为 `inline`，其余为 `attachment` 下载。

```bash
curl -s -b "$JAR" -F "file=@./log.zip" "$BASE/uploads?kind=attachment"
curl -s -b "$JAR" -o out.zip "$BASE/attachments/<附件id>/download"
```

---

## 6. 用户、通知、统计

### 6.1 当前用户

```
GET /api/me
```
返回 `id` `email` `name` `username` `image` `emailVerified` `status`
`roles[]` `permissions[]` `defaultContact`。

```
POST /api/me/avatar     multipart/form-data，字段名 file
```

### 6.2 用户管理

以下全部要求 `user:manage`：

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/users` | 用户列表 |
| `GET /api/users/:id` | 用户详情 |
| `POST /api/users` | 建用户 `{ email, name, password, roleNames[], username?, phone? }`，密码≥6 位 |
| `PATCH /api/users/:id` | 改 `{ name?, phone?, status?, roleNames? }`，`status` 为 `ACTIVE` / `DISABLED` |
| `DELETE /api/users/:id` | 删除用户 |
| `POST /api/users/:id/reset-password` | `{ newPassword }`，≥6 位 |

> 建用户时字段名是 **`roleNames`**（角色名数组，如 `["handler"]`），不是 `roles`。

### 6.3 通知

```
GET   /api/notifications
GET   /api/notifications/unread-count
PATCH /api/notifications/:id/read
POST  /api/notifications/read-all
```
均为当前用户自己的通知，无需额外权限。

通知 `type` 取值：`ASSIGNED` `MESSAGE` `RESOLVED` `CLOSED` `REOPENED`
`CANCELLED` `SLA_OVERDUE` `SLA_RESPONSE_OVERDUE`。

> 通知的 `title` 是服务端渲染好的中文字符串，**不随界面语言变化**。

### 6.4 统计

```
GET /api/stats/overview
```
权限：`ticket:read`。返回 `total` `open` `myTodo` `overdue` `unassigned`
`unread` 以及 `byStatus`（全部 8 个状态的计数）。

未拥有 `ticket:read:all` 时，统计范围自动收窄为「自己提交或指派给自己的工单」。

### 6.5 保存的筛选视图

```
GET    /api/saved-views
POST   /api/saved-views      { name, filter, isShared? }
DELETE /api/saved-views/:id
```

### 6.6 健康检查

```
GET /health
```
**不带 `/api` 前缀**，无需认证，供容器健康检查使用。

---

## 7. 枚举

### 工单状态

| 值 | 含义 |
| --- | --- |
| `NEW` | 待处理 |
| `ASSIGNED` | 已指派 |
| `IN_PROGRESS` | 处理中 |
| `PENDING` | 挂起（**SLA 停表**） |
| `RESOLVED` | 待验收 |
| `CLOSED` | 已关闭 |
| `REOPENED` | 重新打开 |
| `CANCELLED` | 已取消 |

### 优先级

`LOW` `MEDIUM` `HIGH` `URGENT`

---

## 8. SLA 行为

调用方需要知道的规则：

- **从建单时刻起算**，不是从有人接手开始 —— 一直没人接手的工单同样在监控内
- 时限来自工单类型的 `slaResponseMin` / `slaResolveMin`；未设类型时兜底
  为 60 分钟 / 24 小时
- **挂起期间不计时**：恢复时把暂停时长加回两个截止时刻，等价于时钟从未走过。
  累计暂停时长记在工单的 `holdMs` 上
- 首次由**非提单人**发出的公开回复即视为已响应，`firstResponseAt` 被写入
- 超时后果：
  - 响应超时 → 通知处理人；无人接手时通知全部 admin 与 supervisor
  - 解决超时 → 通知处理人与提单人，并**自动把优先级提升一级**
  - 两者都会在操作历史里留下 `user` 为 `null` 的系统记录
- 重开工单会按类型重新给一档解决时限

---

## 9. 已知限制

1. **没有 API Token / HTTP Basic**。只能用 Cookie 会话，且受登录限流约束、
   会话会过期。长期集成建议先补 API 密钥机制（可命名、可设有效期、可吊销、
   密钥只在创建时明文显示一次）。
2. **没有 OpenAPI / Swagger 描述文件**，本文是唯一接口说明。
3. **没有 Webhook**，事件只能靠轮询发现。
4. 通知标题是服务端渲染的中文，不随语言变化。
5. 接口无版本号前缀，破坏性变更依赖本文档同步更新。
