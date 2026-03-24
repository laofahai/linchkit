# Proposal / Validation / Version 设计规范

## 1. 定位

这三者构成 LinchKit 的变更治理核心：
- **Proposal** — 变更草案，描述要改什么
- **Validation** — 验证变更是否安全
- **Version** — 管理 Capability 的版本历史

**核心原则：AI 永远不能直接修改生产系统。所有变更必须经过 Propose → Validate → Approve → Release 流程。**

## 2. 变更治理完整流程

```
Propose → Validate → Approve → Commit → Build → Deploy
   │          │          │         │        │        │
   │          │          │         │        │        └── 蓝绿切换
   │          │          │         │        └── 构建新版本
   │          │          │         └── 写入 Git
   │          │          └── 人工确认或自动审批
   │          └── 静态检查 + 构建测试 + 兼容性检查
   └── AI 或人提出变更草案
```

---

## 3. Proposal

### 3.1 定义

Proposal 是一次变更的完整描述。它包含：
- 要改什么（具体的文件变更）
- 为什么改（动机/需求）
- 影响什么（影响分析）
- 谁提的（AI / 人）

### 3.2 Proposal 来源

| 来源 | 说明 |
|------|------|
| AI 建议 | AI 观察系统运行数据，提出优化建议 |
| AI 辅助 | 人描述需求，AI 生成具体变更 |
| 人工编写 | 开发者直接修改 TS 文件 |

### 3.3 Proposal 结构

```typescript
interface Proposal {
  id: string
  title: string                    // 简短描述
  description: string              // 详细说明

  // 来源
  author: {
    type: 'human' | 'ai'
    id: string
    name: string
  }

  // 影响范围
  capability: string               // 影响哪个 Capability
  changeType: 'minor' | 'major' | 'patch'  // 变更级别

  // 具体变更
  changes: Array<{
    file: string                   // 文件路径
    type: 'create' | 'modify' | 'delete'
    diff?: string                  // 变更内容（unified diff）
    content?: string               // 新文件内容（create 时）
  }>

  // 影响分析
  impact: {
    schemasAffected: string[]      // 影响的 Schema
    actionsAffected: string[]      // 影响的 Action
    rulesAffected: string[]        // 影响的 Rule
    dependentsAffected: string[]   // 受影响的依赖方 Capability
    migrationRequired: boolean     // 是否需要 DB migration
  }

  // 状态
  status: 'draft' | 'validating' | 'validated' | 'approved' | 'rejected' | 'committed' | 'deployed'

  // 时间线
  createdAt: datetime
  validatedAt?: datetime
  approvedAt?: datetime
  committedAt?: datetime
  deployedAt?: datetime

  // 审批
  approvedBy?: { type: string, id: string }
  rejectionReason?: string

  // 验证结果
  validationResult?: ValidationResult
}
```

### 3.4 Proposal 的 changeType 判断

| 级别 | 触发条件 | 审批要求 |
|------|----------|---------|
| `patch` | 修改 Rule 阈值、改 label、加非必填字段 | 可自动审批 |
| `minor` | 新增 Action、新增 Rule、新增可选字段 | 需人工确认 |
| `major` | 删除字段、修改字段类型、改 State Machine、删 Action | 必须人工审批 + 影响分析 |

---

## 4. Validation

### 4.1 定位

Validation 是 AI 变更进入生产前的防爆系统。

**AI 一定会出错，关键不是避免出错，而是让错误无法进入生产。**

### 4.2 验证阶段

```
Proposal 提交
      ↓
  Phase 1: 静态检查
      ↓
  Phase 2: 构建检查
      ↓
  Phase 3: 兼容性检查
      ↓
  Phase 4: 测试（如果有）
      ↓
  验证通过 / 失败
```

### 4.3 Phase 1: 静态检查

不需要构建，直接分析变更内容：

- **Schema 合法性** — 字段类型合法、必填字段有默认值、ref 目标存在
- **Action 合法性** — input/output schema 合法、stateTransition 的 from/to 在状态机中存在
- **Rule 合法性** — trigger 引用的 action/event 存在、condition 表达式合法
- **State Machine 完整性** — 所有状态可达、没有死锁状态、initial 状态存在
- **依赖检查** — 引用的外部 Schema/Action 存在、依赖声明完整
- **命名规范** — 无重名、命名格式正确

### 4.4 Phase 2: 构建检查

实际执行构建，发现类型错误和编译问题：

- TypeScript 编译通过
- 无类型错误
- 无循环依赖

### 4.5 Phase 3: 兼容性检查

检查变更是否与现有系统兼容：

- **DB migration 安全性** — 自动生成的 migration 是否安全（不丢数据、不破坏约束）
- **向后兼容** — 蓝绿部署时旧实例还在运行，新 migration 不能破坏旧版本
- **API 兼容** — Action 的 input/output 变更是否破坏现有调用方
- **依赖方兼容** — 被其他 Capability 依赖的部分是否有 breaking change

### 4.6 Phase 4: 测试

- 运行 Capability 的单元测试（如果有）
- 运行 Capability 的集成测试（如果有）
- Dry run（用样例数据模拟执行变更后的 Action，检查行为正确性）

### 4.7 ValidationResult

```typescript
interface ValidationResult {
  passed: boolean

  phases: {
    static: { passed: boolean, errors: ValidationError[], warnings: ValidationWarning[] }
    build: { passed: boolean, errors: ValidationError[] }
    compatibility: { passed: boolean, errors: ValidationError[], warnings: ValidationWarning[] }
    test: { passed: boolean, results: TestResult[] }
  }

  // 自动生成的信息
  migrationPlan?: MigrationPlan       // 需要执行的 DB migration
  impactSummary: string               // 人类可读的影响摘要
}
```

---

## 5. Version

### 5.1 版本策略

每个 Capability 独立版本，使用语义版本号（semver）：

```
major.minor.patch

patch: 不影响行为的小修改（label、description、阈值调整）
minor: 新增能力（新 Action、新 Rule、新字段）
major: 破坏性变更（删字段、改类型、改状态机）
```

### 5.2 版本与 Git 的关系

- 每次 Proposal 通过审批后 commit 到 Git
- Capability 版本号在 capability.ts 中声明
- Git tag 标记每次发布：`purchase_management@1.2.0`
- 回滚 = 部署上一个 Git tag 对应的版本

### 5.3 版本记录

框架维护版本发布历史（存 Postgres）：

```typescript
interface VersionRecord {
  id: string
  capability: string
  version: string              // semver
  previousVersion: string

  // 关联
  proposalId: string           // 对应的 Proposal
  gitCommit: string            // Git commit hash
  gitTag: string               // Git tag

  // 变更摘要
  changelog: string            // 人类可读变更说明
  migrationApplied: boolean    // 是否执行了 DB migration

  // 状态
  status: 'released' | 'rolled_back'
  releasedAt: datetime
  rolledBackAt?: datetime
  rolledBackBy?: { type: string, id: string }
  rolledBackReason?: string
}
```

### 5.4 回滚

```
发现问题
    ↓
决定回滚到 v1.1.0（当前 v1.2.0）
    ↓
检查 DB migration 是否可逆
    ↓
如果蓝绿的旧实例还在 → 直接切流量（秒级）
如果旧实例已下线 → 从 git tag 重新构建部署
    ↓
执行 DB migration 回滚（如果需要）
    ↓
记录回滚事件
```

### 5.5 DB Migration 与版本的关系

- 每次 Schema 变更自动生成 migration（Drizzle Kit）
- Migration 文件和 Capability 版本绑定
- 回滚时需要检查 migration 是否可逆
- **重要原则：尽量使用可逆的 migration**
  - 加字段：可逆（删字段）
  - 删字段：不可逆（数据丢失）→ 改为"标记废弃 + 下个版本再删"

---

## 6. 审批策略

### 6.1 自动审批

满足以下全部条件时可自动通过：
- changeType = patch
- Validation 全部通过
- 无 DB migration
- 不影响其他 Capability

### 6.2 人工审批

以下情况必须人工确认：
- changeType = minor 或 major
- 有 DB migration
- 影响其他 Capability
- AI 提出的 Proposal（至少 M2 之前全部需要人工确认）
- Validation 有 warning

### 6.3 审批展示

审批时展示：
- 变更 diff
- Validation 结果
- 影响分析
- DB migration 计划
- 变更说明

---

## 7. 与里程碑的关系

### M0
- 无 Proposal 流程，直接修改 TS 文件 + 重启

### M1
- Proposal 模型
- Validation（Phase 1 静态检查 + Phase 2 构建检查）
- Version 管理（Git tag + 版本记录）
- 基础蓝绿部署
- 基础审批（全部人工）

### M2
- AI 生成 Proposal
- Validation Phase 3 兼容性检查
- 自动审批（patch 级别）
- 回滚机制

### M3
- Validation Phase 4 测试 + Dry Run
- Evolution System 自动提出优化 Proposal
