# State Machine 实现规范

## 1. 定位

本文档定义 State Machine 的内部实现方案。DSL 接口（defineState）见 06_state.md，本文档聚焦底层引擎。

## 2. 技术决策

**自研纯 TypeScript 实现，不引入 XState 等第三方库。**

### 为什么不用 XState v5

- XState 的 Actor 模型、invoke、spawn 等大量概念对业务状态机场景 overkill
- defineState DSL 本身是一层抽象，XState 又是一层，双重抽象增加理解和调试成本
- 业务状态机核心逻辑只需要 200-400 行 TypeScript
- 自研可以用 TypeScript const generics / template literal types 做到极致类型安全

### 升级路径

如果未来需要嵌套状态/并行状态等高级特性：
- 内部实现可切换到 XState v5（27k+ stars，API 已稳定）
- defineState DSL 接口保持不变，对使用者透明

## 3. 核心数据结构

```typescript
/** 状态定义 */
interface StateDefinition<
  S extends string = string,
  A extends string = string,
> {
  name: string
  schema: string                    // 绑定到哪个 Schema
  field: string                     // 绑定到 Schema 的哪个字段
  initial: S                        // 初始状态

  states: readonly S[]              // 所有合法状态

  transitions: Array<{
    from: S | readonly S[]          // 源状态（可多个）
    to: S                           // 目标状态
    action: A                       // 触发的 Action 名称
    guard?: (context: TransitionContext) => boolean  // 可选前置条件
  }>

  meta?: Partial<Record<S, {
    label: string
    color?: string
    description?: string
    terminal?: boolean              // 是否终态
  }>>
}

/** 迁移上下文 */
interface TransitionContext {
  record: Record<string, any>       // 当前记录
  actor: Actor                      // 当前操作者
  input: Record<string, any>        // Action 输入
}
```

## 4. 核心引擎

```typescript
/** 状态迁移函数 — 纯函数，无副作用 */
function transition<S extends string>(
  definition: StateDefinition<S>,
  currentState: S,
  actionName: string,
  context?: TransitionContext,
): TransitionResult<S> {
  // 1. 查找匹配的 transition
  const matched = definition.transitions.find(t => {
    const fromStates = Array.isArray(t.from) ? t.from : [t.from]
    return fromStates.includes(currentState) && t.action === actionName
  })

  if (!matched) {
    return {
      allowed: false,
      error: `No transition from "${currentState}" via action "${actionName}"`,
    }
  }

  // 2. 评估 guard（如果有）
  if (matched.guard && context) {
    if (!matched.guard(context)) {
      return {
        allowed: false,
        error: `Guard condition failed for transition "${currentState}" → "${matched.to}"`,
      }
    }
  }

  // 3. 返回目标状态
  return {
    allowed: true,
    from: currentState,
    to: matched.to,
    action: actionName,
  }
}

interface TransitionResult<S extends string> {
  allowed: boolean
  from?: S
  to?: S
  action?: string
  error?: string
}
```

## 5. 辅助函数

```typescript
/** 获取当前状态下所有可用的 Action */
function getAvailableActions<S extends string>(
  definition: StateDefinition<S>,
  currentState: S,
): string[] {
  return definition.transitions
    .filter(t => {
      const fromStates = Array.isArray(t.from) ? t.from : [t.from]
      return fromStates.includes(currentState)
    })
    .map(t => t.action)
}

/** 获取当前状态下所有可达的目标状态 */
function getReachableStates<S extends string>(
  definition: StateDefinition<S>,
  currentState: S,
): S[] {
  return definition.transitions
    .filter(t => {
      const fromStates = Array.isArray(t.from) ? t.from : [t.from]
      return fromStates.includes(currentState)
    })
    .map(t => t.to)
}

/** 验证状态机定义的完整性 */
function validateStateMachine<S extends string>(
  definition: StateDefinition<S>,
): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  // 1. initial 必须在 states 中
  if (!definition.states.includes(definition.initial)) {
    errors.push(`Initial state "${definition.initial}" not in states list`)
  }

  // 2. 所有 transition 的 from/to 必须在 states 中
  for (const t of definition.transitions) {
    const fromStates = Array.isArray(t.from) ? t.from : [t.from]
    for (const f of fromStates) {
      if (!definition.states.includes(f)) {
        errors.push(`Transition from unknown state "${f}"`)
      }
    }
    if (!definition.states.includes(t.to)) {
      errors.push(`Transition to unknown state "${t.to}"`)
    }
  }

  // 3. 检查不可达状态（从 initial 出发无法到达的状态）
  const reachable = new Set<string>([definition.initial])
  let changed = true
  while (changed) {
    changed = false
    for (const t of definition.transitions) {
      const fromStates = Array.isArray(t.from) ? t.from : [t.from]
      if (fromStates.some(f => reachable.has(f)) && !reachable.has(t.to)) {
        reachable.add(t.to)
        changed = true
      }
    }
  }
  for (const s of definition.states) {
    if (!reachable.has(s)) {
      warnings.push(`State "${s}" is unreachable from initial state "${definition.initial}"`)
    }
  }

  // 4. 检查死锁状态（非终态但没有出边）
  for (const s of definition.states) {
    const hasOutgoing = definition.transitions.some(t => {
      const fromStates = Array.isArray(t.from) ? t.from : [t.from]
      return fromStates.includes(s)
    })
    const isTerminal = definition.meta?.[s]?.terminal
    if (!hasOutgoing && !isTerminal) {
      warnings.push(`State "${s}" has no outgoing transitions and is not marked as terminal`)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
```

## 6. 注册表

系统启动时，所有 Capability 中定义的 State Machine 注册到内存：

```typescript
interface StateMachineRegistry {
  // schema.field → StateDefinition
  bySchemaField: Map<string, StateDefinition>
  // name → StateDefinition
  byName: Map<string, StateDefinition>
}
```

Action Engine 在执行有 `stateTransition` 的 Action 时：
1. 从注册表查找对应的 StateDefinition
2. 调用 `transition()` 检查是否允许
3. 不允许 → Action 直接失败
4. 允许 → 继续执行，执行后更新状态字段

## 7. 与 Bridge 的关系

Bridge 的 `extendState` 在注册时合并到原始 StateDefinition：

```typescript
function mergeStateDefinition(
  base: StateDefinition,
  extension: StateExtension,
): StateDefinition {
  return {
    ...base,
    states: [...base.states, ...extension.states],
    transitions: [...base.transitions, ...extension.transitions],
    meta: { ...base.meta, ...extension.meta },
  }
}
```

合并后重新运行 `validateStateMachine` 检查完整性。

## 8. 类型安全

利用 TypeScript const type parameters，defineState 的返回类型可以推断出所有合法状态和 Action 的字面量类型：

```typescript
// 使用者写
const lifecycle = defineState({
  name: 'request_lifecycle',
  states: ['draft', 'submitted', 'approved'] as const,
  transitions: [
    { from: 'draft', to: 'submitted', action: 'submit_request' },
    { from: 'submitted', to: 'approved', action: 'approve_request' },
  ],
  // ...
})

// TypeScript 自动推断：
// typeof lifecycle.states = readonly ['draft', 'submitted', 'approved']
// 合法 action 名 = 'submit_request' | 'approve_request'
```

## 9. 可视化

虽然不引入 XState 的 Stately Editor，但 State Machine 定义可以自动生成 Mermaid 状态图：

```typescript
function toMermaid(definition: StateDefinition): string {
  const lines = ['stateDiagram-v2']
  lines.push(`  [*] --> ${definition.initial}`)
  for (const t of definition.transitions) {
    const fromStates = Array.isArray(t.from) ? t.from : [t.from]
    for (const f of fromStates) {
      lines.push(`  ${f} --> ${t.to}: ${t.action}`)
    }
  }
  // 终态
  for (const [state, meta] of Object.entries(definition.meta || {})) {
    if (meta?.terminal) {
      lines.push(`  ${state} --> [*]`)
    }
  }
  return lines.join('\n')
}
```

输出纳入 CLAUDE.md 自动生成和 Capability Spec 文档。
