# GreenStor COP API 与模块扩展约定

所有业务接口在 `/api` 下，沿用已有会话、SessionGuard、PermissionsGuard 与错误格式。写操作必须经过服务器权限检查，隐藏按钮不替代授权。原有工单、认证、CLI/MCP 与分享接口保持兼容。

## 权限及读取范围

| 角色 | 资产 | 库存 | 组织 | 工单 |
| --- | --- | --- | --- | --- |
| admin | 读写 | 读写 | 管理 | 原管理员权限 |
| asset_manager | 读写 | 无 | 基础目录 | 本人/参与的工单，只读 |
| inventory_manager | 只读 | 读写 | 基础目录 | 本人/参与的工单，只读 |
| cop_viewer | 只读 | 只读 | 基础目录 | 无 |
| 原工单角色 | 无 | 无 | 无 | 原权限不变 |

新增业务管理员纳入已有特权 MFA 策略。初期资产与库存读取范围为公司全局；尚未实现部门/仓库级授权。基础目录仅提供启用员工的 ID、姓名和部门，不返回账户秘密。部门成员完整目录只允许组织管理员读取。

## 业务接口

| 路径 | 操作/约定 |
| --- | --- |
| `/platform/overview`、`/platform/options` | 按权限返回概览；受控关联目录 |
| `/departments`、`/departments/:id` | GET / POST / PUT；层级不能循环 |
| `/departments/members`、`/departments/members/:id` | GET / PATCH，调整员工部门 |
| `/assets`、`/assets/:id` | GET / POST / PUT；编号发出后不可变 |
| `/assets/:id/register` | POST，为尚未发号的草稿分配编号；重复调用返回现有编号 |
| `/assets/:id/tickets`、`/assets/:id/tickets/:ticketId` | GET / POST / DELETE；必须能读取相关工单 |
| `/tickets/:id/assets` | GET，工单用户可见安全的关联资产摘要 |
| `/spare-parts`、`/spare-parts/:id` | GET / POST / PUT；SKU、单位、最低库存、停用 |
| `/warehouses`、`/warehouses/:id` | GET / POST / PUT；仓库有库存时不能停用 |
| `/inventory/balances`、`/inventory/operations` | GET；操作 POST，不提供修改/删除流水接口 |
| `/assets/export`、`/inventory/export` | GET，带 BOM 的 CSV；防公式注入；最多 10000 条 |
| `/assets/import/preview`、`/assets/import/commit` | POST，预览校验后原子提交，最多 500 条 |
| `/assets/import/netbox` | GET，只读 NetBox 设备；需要单独配置只读 API token |
| `/operations/:kind/:id/activity` | GET，最近 100 条履历；隐藏无权查看的工单引用 |
| `/operations/:kind/:id/attachments` | GET / POST，按业务引用检查文件读写权限 |
| `/operations/attachments/:id/download` | GET，鉴权后流式附件下载、nosniff |

列表页码从 1 开始；`pageSize` 默认 20，最多 100；响应为 `{items,total,page,pageSize}`。实体维护使用完整 PUT 表单，不是 PATCH；省略可选手工字段视为清空，保留字段时须提交当前值。导入更新有独立规则：未提供的技术字段不清空已知值，且保留 COP 的所有权、责任人、采购、编号、状态与贴标核验。

### 资产登记

编号为跨站点的 `GS-` 流水号（至少六位），不编码机房、角色、型号或客户；变更位置/归属不换号。数据库 sequence 提供唯一流水，并与人工保留编号协调。PostgreSQL sequence 不随回滚回退，失败/并发重试可能产生跳号；不得手工回填跳号或回收退役编号。

新资产默认为 `PENDING_REGISTRATION`、`UNCONFIRMED`。导入但无 GS 的设备保持无编号草稿，预览与无编号导入不自动占号。资产进入在库/在用/维修状态前须发号并核对实物与标签；在用还须指定责任人。退役是终态，保留编号与履历。NetBox 的技术状态单独保存为 `sourceStatus`，不会被直接解释为 COP 所有权或在用确认。

### 库存请求

`POST /inventory/operations` 示例：

```json
{"type":"ISSUE","sparePartId":"part-id","warehouseId":"warehouse-id","quantity":2,"reason":"更换故障硬盘","idempotencyKey":"unique-operation-0001","assetId":"asset-id","ticketId":"ticket-id"}
```

支持 RECEIVE、ISSUE、RETURN、TRANSFER、ADJUST、REVERSAL。调拨附带 `destinationWarehouseId`；ADJUST 的 quantity 是盘点实存数，可为零；REVERSAL 使用 `reversesId` 与原因。数量为整数，领用和冲销不能产生负库存；同一原操作最多冲销一次，冲销单不能再冲销。

每个业务操作使用 16～100 字符的独立幂等键。相同操作者/有效载荷重复提交返回同一结果，键被不同载荷复用返回 409。操作、流水、余额与审计同事务提交。暂未实现批次、序列化备件、采购订单或成本计价。

### 导入协议

浏览器只解析设备表，接受不超过 8 MiB 的 XLSX/UTF-8 CSV；XLSX 解压总量不超过 64 MiB。设备数组只能包含白名单字段，账号密码、网络接口、连线和已安装组件不作为资产导入载荷。源标识 + GS + SN 用于协调；无 SN 时可按明确站点与名称匹配。重复 SN/编号、多个资产匹配、多行命中同一资产或编号冲突须人工修正。

预览返回 `fingerprint`；提交携带同一 rows、fingerprint 与幂等键。预览后资产发生变化返回 409，需重新预览。`dz-chonburi` 明确映射为 `datazone`；`b300` 旧角色映射为 `gpu-server`。NetBox 只读连接使用受控 HTTPS 域名，保留平台代理/CA；不创建 token、不回写 NetBox、不默认启用持续同步。

## 后续请假/报销扩展

每种业务建立独立表和模块，向 `BUSINESS_ADAPTERS` 注册受控 kind、模型、读取/写入权限和前端路径；相应扩展 BusinessKind。复用 BusinessRef、BusinessActivity、BusinessAttachment 与 NotificationsService 的 subject 字段。通知链接只能来自已注册路径，实际读取仍由模块授权。

`ApprovalAdapter` 已定义 submit / approve / reject / withdraw 和 definitionVersion 协议。后续需实现版本化流程定义、实例绑定、参与者权限、业务状态校验和事务事件；本期没有运行中的审批引擎、请假或报销页面。避免将审批状态与资产/库存状态混用，也不把报销明细塞入工单 extra。
