# 统一执行契约

## 1. 定位

本文定义一次 Action 请求从进入系统到结束的**统一执行契约**。

目标：

- 统一 Action、Rule、Approval、State、Event、Execution、Error 的执行顺序
- 明确每一步产出什么
- 明确哪些步骤在事务内，哪些在事务外
- 明确失败、审批、子 Action、异步副作用的边界

如果其他文档只描述局部机制，而没有明确顺序，以本文为准。

## 2. 适用范围

本文适用于所有通过 Command Layer 进入的写请求：

- UI
- HTTP API
- CLI
- MCP
- 内部 `ctx.execute`

不适用于纯查询路径。

## 3. 执行目标

每次 Action 执行都必须保证：

1. 有唯一 `executionId`
2. 有统一状态机
3. 有清晰的事务边界
4. 有一致的错误输出
5. 有可追踪的事件链
6. 有可查询的 Execution 记录

## 4. Execution 状态机

一次 Execution 的状态只允许按以下路径流转：

```text
requested
  ├─> blocked
  ├─> pending_approval
  ├─> running
  │    ├─> succeeded
  │    └─> failed
  └─> failed
```

说明：

- `requested`：请求刚进入系统
- `blocked`：被 Rule 或前置校验阻止
- `pending_approval`：需要审批，尚未真正执行主逻辑
- `running`：已进入主执行阶段
- `succeeded`：事务提交成功
- `failed`：执行失败

## 5. 标准执行流程

### 5.1 总流程

```text
1. 创建 executionId
2. 记录 action.requested
3. Command Layer 管道检查
4. 输入与前置校验
5. Rule 评估
6. 判断 block / approval / warn / enrich / execute_action
7. 如可继续，进入事务
8. 执行主 Action
9. 记录数据变更、状态迁移、运行事件
10. 提交事务
11. 补全 Execution 结果
12. 触发事务后异步副作用
```

### 5.2 逐步定义

#### Step 1: 分配执行标识

系统必须先生成：

- `executionId`
- `startedAt`
- `actor`
- `action`
- `capability`

此时 Execution 状态为 `requested`。

#### Step 2: 记录入口事件

立即产生事件：

- `action.requested`

该事件必须包含：

- action
- actor
- input
- execution_id
- capability_version

#### Step 3: Command Layer 管道

按照固定顺序执行：

1. `pre`
2. `auth`
3. `exposure`
4. `permission`
5. `tenant`
6. `pre-action`

若任一步失败：

- Execution 直接进入 `failed`
- 返回统一错误结构
- 不进入业务事务

#### Step 4: 输入与前置校验

按以下顺序执行：

1. 输入结构校验
2. `validate.required`
3. `validate.custom`

失败结果：

- 归类为 `ValidationError`
- Execution 状态为 `failed`
- 不进入 Rule 评估和事务

#### Step 5: Rule 评估

评估所有匹配当前 Action 的 Rule。

每条 Rule 评估后，必须记录：

- `rule.evaluated`

Execution 中同步累积 `rulesEvaluated`。

Rule 评估结果允许出现：

- `passed`
- `warned`
- `blocked`
- `approval_required`

#### Step 6: Rule Effect 决议

Rule 评估完成后，按以下固定优先级处理：

1. `block`
2. `require_approval`
3. `warn`
4. `enrich`
5. `execute_action`

这是硬顺序，不允许交换。

##### 6.1 block

只要存在任意 `block`：

- Execution 状态变为 `blocked`
- 产生 `rule.blocked`
- 返回 `BusinessRuleError`
- 不开事务
- 不创建审批请求

##### 6.2 require_approval

若不存在 `block` 且存在 `require_approval`：

- 创建 `ApprovalRequest`
- Execution 状态变为 `pending_approval`
- 产生 `approval.requested`
- 返回 `pending_approval` 响应
- 不开事务
- 不执行主 Action

##### 6.3 warn

所有 `warn` 仅进入返回值 `warnings` 和 Execution 记录，不中断流程。

##### 6.4 enrich

所有 `enrich` 在事务前统一作用于本次执行上下文。

要求：

- 只能修改当前 Action 输入上下文
- 必须可追踪到来源 Rule
- 不能直接落库

##### 6.5 execute_action

`execute_action` 只能在主 Action 事务开始前触发子 Action。

要求：

- 每个子 Action 有独立 `executionId`
- 父子关系必须写入 Execution
- 子 Action 的失败默认中断父 Action
- 不允许静默吞掉失败

限制：

- 必须受 `maxChildActions` 限制
- 必须做循环检测
- 必须记录最大调用深度

如果检测到循环依赖或超限：

- 归类为 `SystemError`
- 当前 Execution 失败

## 6. 事务阶段

### 6.1 进入事务的前提

只有在以下条件同时满足时，才允许进入事务：

- Command Layer 管道通过
- 输入校验通过
- 没有 `block`
- 没有 `pending_approval`
- 所有前置子 Action 已成功

### 6.2 事务内顺序

事务内顺序固定为：

1. 幂等检查
2. 读取目标记录
3. 乐观锁 / 当前状态检查
4. 执行声明式 `setFields`
5. 执行代码式 `handler`
6. 执行状态迁移
7. 写业务数据
8. 写运行事件
9. 写 outbox

### 6.3 幂等检查

如果 Action 启用了 `idempotent`：

- 事务开始时先检查幂等键
- 若已存在成功结果，直接返回历史结果
- 不重复执行业务逻辑

### 6.4 状态机检查

若 Action 声明 `stateTransition`：

- 必须在事务内基于最新记录检查当前状态
- 不允许在事务外预判状态后直接使用

否则并发情况下会产生错误判断。

### 6.5 数据变更记录

事务内必须收集：

- `before`
- `after`
- `changedFields`

这些内容用于：

- Execution `changes`
- `record.created / updated / deleted`

## 7. 事件契约

### 7.1 必发事件

一次正常进入执行链的 Action，至少应产生以下事件子集：

- `action.requested`
- `rule.evaluated`（零到多条）
- `state.transition`（如果发生）
- `record.created / updated / deleted`（如有）
- `action.succeeded` 或 `action.failed`

### 7.2 审批路径事件

审批路径必须产生：

- `action.requested`
- `rule.evaluated`
- `approval.requested`

审批通过后二次执行时：

- 重新产生新的 `executionId`
- 原审批请求与新 execution 建立关联

审批后的重新执行不是恢复旧事务，而是一次新的执行。

### 7.3 失败路径事件

失败时应尽量产生：

- `action.failed`

但如果失败发生在事件系统初始化之前，至少 Execution 记录中必须有错误结果。

## 8. Execution 记录契约

### 8.1 必填字段

Execution 至少必须包含：

- id
- action
- capability
- actor
- input
- status
- startedAt
- completedAt
- duration

### 8.2 状态与错误映射

| Execution 状态 | 错误类型 |
|----------------|----------|
| `blocked` | `BusinessRuleError` |
| `pending_approval` | `ApprovalRequiredError` |
| `failed` | `ValidationError` / `AuthorizationError` / `ConflictError` / `SystemError` |
| `succeeded` | 无错误 |

### 8.3 父子链路

若由 `ctx.execute()` 或 Rule `execute_action` 触发子 Action：

- 子 Execution 必须记录 `parentExecutionId`
- 父 Execution 必须在 `childExecutions` 中记录子节点

## 9. 审批契约

### 9.1 审批不是暂停事务

`require_approval` 的语义是：

- 本次执行在事务前停止
- 生成审批请求
- 审批通过后重新发起一次新执行

不是：

- 挂起一个数据库事务等待人工恢复

### 9.2 审批后的重新执行

审批通过后重新执行时：

- 使用原始 input
- actor 仍为原发起人
- 审批人只影响 ApprovalRequest，不替代业务发起人
- 跳过已通过审批的那批 Rule
- 其他 Rule 仍重新评估

### 9.3 审批后失败

审批通过后的再次执行仍可能失败，例如：

- 状态已变化
- 记录已被他人修改
- 其他 Rule 新增拦截
- 数据已不满足前置条件

这属于正常情况，不应被视为审批系统异常。

## 10. 错误契约

### 10.1 错误分类位置

| 阶段 | 错误类型 |
|------|----------|
| 管道检查 | `AuthorizationError` / `SystemError` |
| 输入校验 | `ValidationError` |
| Rule block | `BusinessRuleError` |
| Approval required | `ApprovalRequiredError` |
| 并发与状态冲突 | `ConflictError` |
| 基础设施故障 | `SystemError` |

### 10.2 返回格式

所有失败必须返回统一结构，详见 `33_error_handling.md`。

本文只补充要求：

- `blocked` 不应伪装成 `ValidationError`
- `pending_approval` 不应伪装成成功
- 子 Action 失败时，错误需能追溯到父 Execution

## 11. 事务后阶段

事务提交成功后，才允许执行以下异步任务：

- 通知
- 搜索索引更新
- 报表更新
- AI 分析
- 文档更新

这些任务失败：

- 不回滚主事务
- 必须通过 outbox / worker 重试或记录失败

## 12. 明确禁止的做法

- 在审批场景下挂起数据库事务等待人工处理
- 在事务外先判断状态，事务内不再校验
- 子 Action 失败但父 Action 静默继续
- Rule `enrich` 直接改数据库
- 用 `warn` 承载必须阻断的业务规则
- 让 `pending_approval` 返回看起来像成功的响应

## 13. 与现有文档的关系

- `04_action.md` 负责定义 Action 结构
- `05_rule.md` 负责定义 Rule 模型与 effect
- `35_approval_mechanism.md` 负责审批对象与操作流程
- `07_event.md` 负责事件模型
- `11_execution_log.md` 负责 Execution 存储与查询
- `33_error_handling.md` 负责统一错误模型
- 本文负责把它们串成统一执行时序

## 14. 与里程碑的关系

### M0

- 固定主执行顺序
- 固定错误分类
- 固定基础 Execution 与事件产物

### M1

- 补齐审批路径
- 补齐父子 Execution 链路
- 补齐事务后异步处理

### M2

- AI / MCP 入口完全复用同一执行契约
- 审批、审计、回放、分析都建立在统一链路上
