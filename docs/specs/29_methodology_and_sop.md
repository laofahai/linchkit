# 方法论与 SOP 设计规范

## 1. 定位

系统进化不能随意。AI 和人在设计、开发、修改 Capability 时，必须遵循一套方法论。

方法论文件是 AI 可读的 — 纳入 CLAUDE.md，AI 生成代码时自动遵循。

## 2. 两层方法论

### 2.1 框架层方法论 — "怎么在 LinchKit 上开发"

```
.linchkit/
  methodology/
    schema_design.md           — Schema 设计规范
    action_design.md           — Action 设计规范
    rule_design.md             — Rule 设计规范
    state_design.md            — State Machine 设计规范
    view_design.md             — View 设计规范
    flow_design.md             — Flow 设计规范
    capability_checklist.md    — 新 Capability 检查清单
    evolution_policy.md        — 进化策略
    naming_convention.md       — 命名约定
    change_classification.md   — 变更分级标准
```

### 2.2 业务层知识 — "系统应该有什么规则和流程"

业务层知识是 AI 生成 Rule / Flow / Schema 的依据。分四个维度：

```
.linchkit/
  knowledge/
    company/                   — 公司制度与管理要求
    industry/                  — 行业规范与合规
    domain/                    — 领域知识与最佳实践
    software/                  — 软件工程方法论
```

#### 公司制度（company/）

公司内部管理制度，直接转化为 Rule 和 Flow：

```
company/
  governance.md                — 公司治理架构（决策层级、汇报关系）
  procurement_policy.md        — 采购制度
    - 审批层级：5万以下部门经理，5-20万总监，20万以上CEO
    - 供应商准入：至少3家比价，必须有资质审核
    - 紧急采购：可跳过比价，但需事后补审
  approval_hierarchy.md        — 审批层级总表
    - 谁能审批什么、金额上限、代审规则
  expense_policy.md            — 报销制度
  hr_policy.md                 — 人事制度（请假、考勤、薪资）
  data_policy.md               — 数据管理制度（分类、保密、留存）
  security_policy.md           — 信息安全制度
```

#### 行业规范（industry/）

行业法规和合规要求，转化为强制 Rule：

```
industry/
  food_safety.md               — 食品安全法规（GB标准、保质期管理、溯源要求）
  financial_compliance.md      — 金融合规（KYC、AML、交易记录留存）
  gdpr.md                      — 数据隐私合规（GDPR/个人信息保护法）
  medical_device.md            — 医疗器械法规（UDI、不良事件报告）
  iso_9001.md                  — 质量管理体系
  customs_regulation.md        — 进出口海关法规
```

#### 领域知识（domain/）

业务领域的最佳实践和方法论：

```
domain/
  inventory/
    abc_classification.md      — ABC 分类法（按价值/频率分级管理）
    safety_stock.md            — 安全库存计算方法
    fifo_lifo.md               — 先进先出/后进先出
  procurement/
    vendor_evaluation.md       — 供应商评估方法
    strategic_sourcing.md      — 战略采购方法论
  project/
    agile_scrum.md             — 敏捷/Scrum 方法论
    kanban.md                  — 看板方法论
    critical_path.md           — 关键路径法
  finance/
    cost_allocation.md         — 成本分摊方法
    budget_control.md          — 预算控制方法
  hr/
    okr.md                     — OKR 目标管理
    performance_review.md      — 绩效评估方法
```

#### 软件工程方法论（software/）

软件开发和架构层面的方法论：

```
software/
  ddd.md                       — 领域驱动设计（bounded context、aggregate）
  event_sourcing.md            — 事件溯源模式
  cqrs.md                      — 命令查询分离
  saga_pattern.md              — Saga 补偿模式
  twelve_factor.md             — 12-Factor App
  api_design.md                — API 设计原则
```

### 2.3 知识文档的格式

每份知识文档使用统一格式，方便 AI 解析：

```markdown
---
type: company_policy          # company_policy / industry_regulation / domain_knowledge / software_methodology
domain: procurement           # 所属领域
applies_to:                   # 适用的 Capability
  - purchase_management
  - supplier_management
priority: high                # 约束强度：high（必须遵守）/ medium（建议遵守）/ low（参考）
---

# 采购审批制度

## 规则

### 审批层级
- 金额 ≤ 5万：部门经理审批
- 5万 < 金额 ≤ 20万：部门总监审批
- 金额 > 20万：CEO 审批

### 供应商准入
- 新供应商必须经过资质审核
- 单笔采购 ≥ 1万必须至少 3 家比价

### 例外处理
- 紧急采购可跳过比价流程，但必须在 3 个工作日内补审
- 独家供应商可免除比价，需附独家说明

## 转化为系统规则的建议

上述制度建议转化为以下 LinchKit 规则：
1. Rule: amount_approval_level（审批层级）
2. Rule: vendor_qualification_check（供应商资质）
3. Rule: multi_quote_requirement（比价要求）
4. Rule: emergency_purchase_post_review（紧急采购补审）
```

### 2.4 知识如何被 AI 使用

**两层都自动纳入 CLAUDE.md：**
- 框架层方法论 → 指导代码怎么写（命名、结构、分级）
- 业务层知识 → 指导 Rule/Flow 的业务逻辑（制度、合规、最佳实践）

**AI 生成 Capability 时的完整流程：**

```
AI 收到："帮我设计采购审批流程"
    ↓
1. 读取 methodology/action_design.md → 知道 Action 怎么命名和设计
2. 读取 knowledge/company/procurement_policy.md → 知道公司采购制度
3. 读取 knowledge/domain/procurement/strategic_sourcing.md → 参考行业最佳实践
4. 读取 knowledge/industry/... → 检查是否有合规要求
    ↓
AI 生成：
  - Rule: 5 万以下部门经理审批、5-20 万总监、20 万以上 CEO（来源：公司制度）
  - Rule: 1 万以上必须 3 家比价（来源：公司制度）
  - Flow: 多级审批流程
  - 命名和结构符合框架规范（来源：框架方法论）
  - 每条 Rule 的 description 标注知识来源
```

**AI 的 Proposal 中标注知识来源：**

```typescript
defineRule({
  name: 'amount_approval_level',
  description: '采购金额审批层级',
  // 标注这条规则的来源
  knowledgeSource: 'company/procurement_policy.md#审批层级',
  // ...
})
```

这样人审查 PR 时能追溯"为什么 AI 生成了这条规则"。

## 3. 核心 SOP

### 3.1 新增 Capability SOP

```
1. 需求分析
   - 明确业务边界（这个 Capability 负责什么、不负责什么）
   - 识别依赖（需要哪些已有 Capability）
   - 判断是 standard / bridge / adapter

2. Schema 设计
   - 核心实体识别
   - 字段定义（类型、约束、关联）
   - 状态字段识别 → State Machine
   - 明确哪些是一对多、多对多

3. State Machine 设计
   - 画出状态流转图
   - 每个迁移对应一个 Action
   - 确认没有死锁状态、所有状态可达

4. Action 设计
   - 按业务动作语义命名（verb_noun）
   - 判断声明式 vs 代码式
   - 定义 input / output / policy
   - 明确每个 Action 的副作用

5. Rule 设计
   - 识别业务规则
   - 判断声明式 vs 代码式
   - 确认 Rule 的 trigger 和 effect

6. View 设计
   - list / form 至少各一个
   - 根据状态定义按钮可见性
   - 确认筛选、排序

7. 测试
   - 每个 Action 至少一个测试
   - 状态流转完整测试
   - Rule 覆盖测试

8. 文档
   - 补充人工文档（业务背景、设计决策）
```

### 3.2 Schema 设计规范

```markdown
## Schema 命名
- 使用 snake_case
- 名词，不加前缀（不是 tbl_purchase_request）
- 单数形式（purchase_request，不是 purchase_requests）

## 字段命名
- 使用 snake_case
- 布尔字段用 is_ / has_ 前缀（is_active, has_attachment）
- 时间字段用 _at 后缀（created_at, approved_at）
- 关联字段用被关联实体名（department, requester）

## 必须考虑的
- 每个 Schema 是否需要状态字段？
- 关联关系是否正确（ref vs has_many）？
- 哪些字段是派生的（computed）？
- 哪些字段是敏感的（sensitive / secret）？
- 是否需要 i18n？
```

### 3.3 Action 设计规范

```markdown
## Action 命名
- verb_noun 格式（submit_request, approve_request）
- 动词用具体的业务语义，不用 CRUD（不是 update_request）

## 粒度判断
- 一个 Action = 一个业务动作
- 如果一个 Action 需要两种不同的权限检查 → 拆成两个
- 如果一个 Action 涉及两种不同的状态迁移 → 拆成两个
- 如果不确定 → 先细后粗，合并比拆分容易

## 声明式 vs 代码式
- 只做状态迁移 + 字段校验 → 声明式
- 有计算逻辑、外部调用、条件判断 → 代码式
- 不确定 → 用代码式（更灵活）
```

### 3.4 Rule 设计规范

```markdown
## 什么应该是 Rule
- 业务约束（金额限制、角色要求）
- 审批触发条件
- 自动数据补充
- 安全策略

## 什么不应该是 Rule
- 数据计算逻辑 → 放 Action handler
- UI 展示逻辑 → 放 View
- 流程编排 → 放 Flow

## 声明式 vs 代码式
- 能用 { field, operator, value } 表达 → 声明式（优先）
- 需要复杂计算或外部数据 → 代码式

## Rule 命名
- 描述规则含义（amount_check, role_requirement）
- 不用编号（不是 rule_001）
```

### 3.5 变更分级标准

| 级别 | 条件 | 审批要求 |
|------|------|---------|
| `patch` | 改 label、改阈值、加非必填字段、改 View 布局 | 可自动审批（M2+） |
| `minor` | 新增 Action、新增 Rule、新增可选字段、新增 View | 需人工确认 |
| `major` | 删字段、改字段类型、改 State Machine、删 Action、删 Rule | 必须人工审批 + 影响分析 |
| `critical` | 删 Capability、修改权限相关 Rule、修改认证逻辑 | 必须 system_admin 审批 |

### 3.6 进化策略（Evolution Policy）

```markdown
## AI 可以自主建议的
- 新增 Rule（基于数据分析）
- 调整 Rule 阈值
- 新增 View
- 优化 View 布局
- 新增非必填字段

## AI 建议但必须人工仔细审查的
- 新增 Action
- 修改 State Machine
- 新增 Flow
- 跨模块变更

## AI 不能建议的（只有人能发起）
- 删除 Capability
- 修改权限模型
- 修改安全相关规则
- 数据库结构的破坏性变更
```

## 4. 方法论的维护

- 方法论文件由团队维护，跟代码一起版本管理
- AI 严格遵循（纳入 CLAUDE.md）
- 方法论本身也可以通过 Proposal 修改
- 但方法论的修改必须 system_admin 审批

## 5. AI 如何使用方法论

```
AI 收到需求："加一个采购预算控制功能"
    ↓
AI 读取 CLAUDE.md（包含方法论）
    ↓
AI 按 SOP 执行：
  1. 需求分析 → 这是给 purchase_management 加 Rule
  2. Schema 设计 → 需要加 computed field (department_monthly_total)
  3. Rule 设计 → 声明式 condition，effect = require_approval
  4. View 设计 → 表单上显示预算使用情况
  5. 遵循命名约定、变更分级标准
    ↓
AI 生成 Proposal（符合方法论）
    ↓
Validation 检查是否违反方法论
```

## 6. 与里程碑的关系

### M0
- 基础命名约定
- Schema / Action 设计规范
- 变更分级标准

### M1
- 完整 SOP 文档
- 方法论纳入 CLAUDE.md
- Validation 检查方法论合规

### M2
- 进化策略
- AI 自动遵循方法论
- 方法论自身可通过 Proposal 修改
