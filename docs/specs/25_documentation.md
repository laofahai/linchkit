# 文档能力设计规范

> 文档产物形态见本文；文档维护、校验、索引和归档规则见 `37_documentation_governance.md`。

## 1. 定位

文档不是补充品，是系统能力的一部分。

最大风险不是没有文档，而是**系统变了，文档没变**。因此文档必须自动生成优先，人工说明作为补充层。

## 2. 三层文档

### 2.1 Capability Spec（能力规格）

描述系统能力结构。**自动生成。**

每个 Capability 自动生成一份规格文档：

```markdown
# purchase_management v1.2.0

## Schemas
- purchase_request: 采购申请
  - title (string, required): 标题
  - amount (number, required): 金额
  - department (ref → department): 部门
  - status (state → request_lifecycle): 状态
  - ...

## Actions
- create_request: 创建采购申请 (draft)
- submit_request: 提交采购申请 (draft → submitted)
- approve_request: 审批通过 (submitted → approved)
- ...

## Rules
- amount_check: 金额超过10000需要总监审批
- ...

## State Machines
- request_lifecycle: draft → submitted → approved → purchased → completed

## Views
- purchase_request_list: 列表视图
- purchase_request_form: 表单视图

## Dependencies
- employee_management (schemas: employee, department)

## Relations
- affects: inventory_management (via bridge)
```

这份文档从 defineSchema / defineAction / defineRule / defineState / defineView 自动提取，每次部署后自动更新。**不需要人写，不会漂移。**

### 2.2 Execution Trace（执行记录）

描述系统运行情况。**自动记录。**

由 Execution Log 和 Event 系统提供，已在 07_event.md 和 11_execution_log.md 中定义。

### 2.3 Human Docs（人工补充文档）

自动生成的文档覆盖不了的：

- 业务背景说明（为什么要做这个 Capability）
- 设计决策说明（为什么选择这种 Schema 结构）
- 使用指南（怎么用这个模块）
- 注意事项（踩坑记录）

```typescript
// capabilities/purchase_management/docs/
//   README.md         ← 业务说明
//   decisions.md      ← 设计决策
//   guide.md          ← 使用指南
```

人工文档与 Capability 版本绑定。Proposal 改了 Capability，提醒检查文档是否需要更新。

## 3. CLAUDE.md 自动生成

已在 15_ai_developer_experience.md 中定义。CLAUDE.md 是所有 Capability Spec 的汇总 + 框架约定，自动生成。

## 4. 版本绑定

- Capability Spec 自动生成，与版本强绑定，不可能漂移
- Human Docs 存在 Capability 目录下，跟代码一起版本管理
- 版本发布时自动生成 changelog（基于 Proposal 的 description 和 diff）

## 5. 文档查询

通过 Command Layer 查询文档：

```bash
linch docs show purchase_management           # 查看 Capability Spec
linch docs show purchase_management --human   # 查看人工文档
linch docs changelog purchase_management      # 查看变更历史
linch docs search "审批"                       # 搜索文档
```

MCP 也可以查询：
```
tool: get_capability_docs
input: { capability: "purchase_management" }
```

## 6. 与里程碑的关系

### M0
- Capability Spec 自动生成（基础版）
- CLAUDE.md 自动生成

### M1
- Capability Spec 完整版（含关系图、变更历史）
- Human Docs 目录结构
- 版本绑定的 changelog

### M2
- 文档搜索
- AI 可查询文档（MCP）
