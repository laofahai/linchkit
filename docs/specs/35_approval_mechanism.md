# 审批机制设计规范

## 1. 定位

审批机制处理 Rule 评估返回 `require_approval` 后的完整流程：Action 挂起、审批人操作、通过/驳回后的恢复。

**这是连接 Rule Engine 和 Action Engine 的关键路径。**

## 2. 完整流程

```
Action 请求进来
    ↓
Rule 评估 → 返回 require_approval（含审批级别）
    ↓
Action 不执行，创建 ApprovalRequest 记录（Postgres）
    ↓
通知审批人（EventHandler 异步触发）
    ↓
审批人在 UI/API 操作：通过 / 驳回
    ↓
通过 → 框架重新执行 Action（跳过已通过的审批 Rule）
驳回 → 记录原因，通知发起人
超时 → 自动驳回 或 升级（可配置）
```

## 3. ApprovalRequest 核心字段

- **挂起的 Action 信息**：action 名称、capability、input 参数（序列化）、目标 schema/recordId
- **审批信息**：审批级别（level）、审批原因（reason）、触发审批的 Rule 名称
- **发起人**：requestedBy（Actor）、requestedAt
- **审批人**（assignee）：按角色（role）、权限组（group）或具体用户（user）指定
- **状态**：pending → approved / rejected / expired / cancelled
- **审批结果**：decidedBy、decidedAt、decisionNote
- **超时**：expiresAt、timeoutPolicy（reject / escalate / none）
- **执行结果**：审批通过后重新执行的 executionId、executionError

## 4. 与 Action 执行流程的集成

在 Action 13 步流程的 Step 5（Rule 评估）后：

- 如果任何 Rule 返回 `require_approval`：
  - 取最高审批级别
  - 创建 ApprovalRequest 记录
  - 记录 Execution（status: `pending_approval`）
  - 产生 event: `approval.requested`
  - 返回给调用方：`{ status: 'pending_approval', approvalId, message }`
  - **Action 不继续执行**（不开事务、不执行 handler）
- 如果没有 `require_approval`：继续 Step 6

## 5. 审批操作

### 通过

1. 更新 ApprovalRequest 状态为 `approved`
2. 产生 event: `approval.approved`
3. **重新执行 Action**：使用原始 input，Actor 仍然是原始发起人，跳过触发审批的 Rule（`skipRules`），其他 Rule 照常评估
4. 执行成功 → 更新 executionId；执行失败 → 更新 executionError 并通知

### 驳回

1. 更新状态为 `rejected`，驳回原因必填
2. 产生 event: `approval.rejected`
3. 通知发起人

### 取消

发起人可以取消自己的审批请求。

### 超时

Rule 的 `require_approval` effect 可配置超时时间和超时策略（自动驳回 / 升级到上级）。定时任务扫描过期记录执行。

## 6. 审批人确定

Rule 的 `require_approval` effect 中 `level` 字段决定审批人，支持三种方式：

- **指定角色**：`level: 'director'` → 所有拥有 director 角色的用户都能审批
- **指定权限组**：`level: 'purchase_approver'`
- **指定具体用户**：`assignee: { type: 'user', value: '$target.department.manager' }`（代码式 Rule 中使用）

## 7. 多 Rule 审批合并

同一次 Action 可能触发多条 `require_approval` Rule：

- 取最高审批级别（所有 Rule 的 level 取并集）
- 所有审批原因合并展示
- 一次审批操作覆盖所有 Rule（不需要逐条审批）
- 通过后重新执行时，跳过所有触发审批的 Rule

## 8. UI 集成

- **待审批列表**：系统内置 View，按 assignee 过滤当前用户的角色/权限组。每条显示目标记录摘要、审批原因、发起人、提交时间、过期时间。
- **表单审批状态条**：当记录有 pending 的 ApprovalRequest 时，表单顶部显示审批信息和通过/驳回按钮。

## 9. Event 类型

| 事件 | 时机 |
|------|------|
| `approval.requested` | 创建审批请求 |
| `approval.approved` | 审批通过 |
| `approval.rejected` | 审批驳回 |
| `approval.expired` | 审批超时 |
| `approval.cancelled` | 审批取消 |

## 10. 权限

| 操作 | 权限要求 |
|------|---------|
| 查看待审批列表 | 任何登录用户（自动按 assignee 过滤） |
| 通过/驳回 | assignee 匹配（角色/权限组/用户） |
| 取消 | 原始发起人 |
| 查看所有审批记录 | system_admin |
