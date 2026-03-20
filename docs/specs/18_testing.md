# 测试策略设计规范

## 1. 定位

测试是 Validation 的基础。AI 生成的 Capability 必须可测试，否则"变更治理"就是空话。

框架提供测试工具，让 Capability 开发者（人或 AI）能方便地写测试。

## 2. 测试分层

### 2.1 单元测试 — 测试单个定义

```typescript
import { testRule, testAction, testStateMachine } from '@linchkit/test'

// 测试 Rule
describe('amount_check', () => {
  it('should require approval when amount > 10000', async () => {
    const result = await testRule('amount_check', {
      target: { amount: 15000, department: 'sales' },
      actor: { type: 'human', roles: ['staff'] },
    })
    expect(result.effect.type).toBe('require_approval')
    expect(result.effect.level).toBe('director')
  })

  it('should pass when amount <= 10000', async () => {
    const result = await testRule('amount_check', {
      target: { amount: 5000 },
      actor: { type: 'human', roles: ['staff'] },
    })
    expect(result.effect).toBeNull()
  })
})

// 测试 Action
describe('submit_request', () => {
  it('should transition state from draft to submitted', async () => {
    const result = await testAction('submit_request', {
      input: { id: 'pr_001' },
      initialData: {
        purchase_request: [{ id: 'pr_001', title: 'test', amount: 5000, status: 'draft' }],
      },
      actor: { type: 'human', roles: ['staff'] },
    })
    expect(result.success).toBe(true)
    expect(result.record.status).toBe('submitted')
  })
})

// 测试 State Machine
describe('request_lifecycle', () => {
  it('should not allow direct transition from draft to approved', async () => {
    const result = await testStateMachine('request_lifecycle', {
      from: 'draft',
      to: 'approved',
    })
    expect(result.allowed).toBe(false)
  })
})
```

### 2.2 集成测试 — 测试完整 Action 链路

```typescript
import { createTestContext } from '@linchkit/test'

describe('purchase workflow', () => {
  const ctx = createTestContext({
    capabilities: ['purchase_management'],
    seedData: {
      department: [{ id: 'dept_001', name: '销售部' }],
      employee: [{ id: 'emp_001', name: '张三', department: 'dept_001' }],
    },
  })

  it('full lifecycle: create → submit → approve → complete', async () => {
    // 创建
    const created = await ctx.execute('create_request', {
      title: '办公用品',
      amount: 5000,
      department: 'dept_001',
      requester: 'emp_001',
    })
    expect(created.record.status).toBe('draft')

    // 提交
    const submitted = await ctx.execute('submit_request', { id: created.record.id })
    expect(submitted.record.status).toBe('submitted')

    // 审批
    const approved = await ctx.execute('approve_request', {
      id: created.record.id,
    }, { actor: { type: 'human', roles: ['manager'] } })
    expect(approved.record.status).toBe('approved')

    // 检查事件链
    const events = await ctx.getEvents({ recordId: created.record.id })
    expect(events).toContainEventTypes([
      'action.succeeded',    // create
      'action.succeeded',    // submit
      'state.transition',    // draft → submitted
      'rule.evaluated',      // amount_check
      'action.succeeded',    // approve
      'state.transition',    // submitted → approved
    ])
  })
})
```

### 2.3 Capability 测试 — 测试整个模块的一致性

```typescript
import { validateCapability } from '@linchkit/test'

describe('purchase_management capability', () => {
  it('should pass all structural validations', async () => {
    const result = await validateCapability('purchase_management')

    // Schema 完整性
    expect(result.schemas.valid).toBe(true)

    // Action 的 stateTransition 引用存在
    expect(result.actions.valid).toBe(true)

    // Rule 的 trigger 引用的 Action 存在
    expect(result.rules.valid).toBe(true)

    // State Machine 所有状态可达
    expect(result.stateMachines.valid).toBe(true)

    // View 引用的字段存在
    expect(result.views.valid).toBe(true)

    // 依赖都已安装
    expect(result.dependencies.valid).toBe(true)
  })
})
```

## 3. 测试工具

框架提供 `@linchkit/test` 包：

| 工具 | 作用 |
|------|------|
| `testRule(name, context)` | 单独测试一条 Rule |
| `testAction(name, options)` | 测试一个 Action（含 mock 数据） |
| `testStateMachine(name, transition)` | 测试状态迁移合法性 |
| `createTestContext(options)` | 创建完整测试上下文（内存数据库 + 种子数据） |
| `validateCapability(name)` | 结构性验证整个 Capability |

### 测试数据库

集成测试使用真实 PostgreSQL（不用 mock）：
- 每个测试套件创建一个临时数据库
- 测试完成后销毁
- 保证测试环境和生产环境行为一致

## 4. AI 生成代码的测试

AI 通过 Proposal 生成的代码，Validation 阶段自动运行：

```
Proposal 提交
    ↓
Phase 1: 静态检查
Phase 2: 构建检查
Phase 3: 兼容性检查
Phase 4: 自动运行测试
    ├── validateCapability（结构验证）
    ├── 已有的测试用例
    └── AI 自动生成的测试用例（可选）
    ↓
测试全过 → 可以审批
测试失败 → 标记在 PR 中
```

## 5. 与里程碑的关系

### M0
- testAction, testRule 基本实现
- createTestContext 基本实现
- 用真实 Postgres 做测试

### M1
- validateCapability 完整实现
- 集成到 Validation 流程（CI 自动运行）

### M2
- AI 自动生成测试用例
- 测试覆盖率检查
