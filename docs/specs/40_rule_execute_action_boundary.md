# Rule `execute_action` 边界与约束

## 1. 定位

`Rule.effect.type = 'execute_action'` 是 LinchKit 中风险最高的联动能力之一。

它的价值在于：

- 可以做前置联动
- 可以把某些简单规则触发的“附加动作”从主 Action 中剥离

它的风险在于：

- 容易形成递归
- 容易制造隐式依赖
- 容易让事务边界和失败模型变复杂

因此本文的目标不是鼓励使用，而是**限制使用**。

如果一个场景无法明确落入本文允许范围，应默认不用 `execute_action`。

## 2. 一句话原则

> `execute_action` 只适用于“主 Action 开始前的、有限的、同步的、失败即中断的前置联动”。

凡是涉及以下任一特征，都不应使用 `execute_action`：

- 依赖主 Action 的执行结果
- 需要等待人或外部事件
- 需要补偿或编排
- 可能形成多步链式扩散
- 容错要求是“主流程继续，子流程稍后处理”

这些场景应转向：

- EventHandler
- Flow / Temporal
- 主 Action handler 中显式编排

## 3. 允许使用的场景

### 3.1 允许场景

以下场景允许使用：

- 主 Action 执行前先创建一条风控审查记录
- 主 Action 执行前先同步生成一个本地附属对象
- 主 Action 执行前先校准某个本地缓存或辅助数据

前提是这些子 Action 同时满足：

- 同步完成
- 不依赖主 Action 结果
- 失败后主 Action 应立即停止
- 没有人机等待
- 没有跨系统长链路

### 3.2 不允许场景

以下场景禁止使用：

- 发送通知
- 调外部系统接口
- 创建需要稍后补偿的跨系统动作
- 审批、等待、异步队列任务
- 依赖主 Action 已写入的数据
- 可能触发更多子 Action 的复杂链式规则

这些应该分别使用：

- 通知 / 搜索索引 / 报表：EventHandler / Outbox
- 多步业务编排：Flow / Temporal
- 强业务组合：主 Action handler 显式调用

## 4. 选择规则

在使用 `execute_action` 前，必须先回答以下问题：

### 4.1 它是否依赖主 Action 的结果

如果答案是“是”，禁止使用。

因为 `execute_action` 发生在主事务前，拿不到主 Action 最终提交后的结果。

### 4.2 它失败后主 Action 是否必须停止

如果答案是“否”，禁止使用。

因为 `execute_action` 的默认模型是“子 Action 失败，父 Action 失败”。

### 4.3 它是否可能继续触发更多联动

如果答案是“可能很多层”，禁止使用。

此时应改为 Flow，明确编排结构。

### 4.4 它是否需要独立重试或补偿

如果答案是“是”，禁止使用。

应交给 Temporal / Saga。

## 5. 默认执行模型

### 5.1 时序

固定时序：

```text
Rule 命中
  -> 收集 execute_action effects
  -> 按顺序触发子 Action
  -> 全部成功
  -> 父 Action 才允许进入事务
```

### 5.2 失败传播

默认规则：

- 任一子 Action 失败
- 当前父 Execution 直接失败
- 父 Action 不进入事务

不允许默认“忽略子失败继续执行”。

如确实需要“子失败不影响主流程”，应改用 EventHandler 或事务后异步处理。

### 5.3 返回值

子 Action 的返回值默认不自动并入父 Action output。

只允许：

- 写入父 Execution 的 `childExecutions`
- 供运行时内部使用

如果主 Action 真的依赖子结果，应考虑改成主 Action handler 显式编排，而不是 Rule 联动。

## 6. 排序与并发

### 6.1 默认顺序执行

同一次 Rule 决议中，多个 `execute_action` 必须默认按声明顺序串行执行。

原因：

- 便于定位问题
- 便于控制副作用顺序
- 避免把前置联动变成并发竞态源

### 6.2 默认不并发

Rule `execute_action` 默认禁止并发触发。

如确需并行，说明场景已接近编排问题，应使用 Flow。

## 7. 循环检测与深度限制

### 7.1 必须检测循环

运行时必须维护当前执行链上的 action stack：

```text
submit_request
  -> create_risk_review
  -> ...
```

如果待执行的子 Action 已存在于当前 stack 中：

- 立即报错
- 归类为 `SystemError`
- 当前执行失败

### 7.2 最大深度

必须设置最大子链深度，例如：

- 默认 `maxChildActionDepth = 3`

超过即失败。

理由：

- 即使没有显式环，也可能出现过深链路
- 深链通常意味着设计已经偏向工作流，不再适合 Rule 联动

### 7.3 最大数量

单次父 Execution 内，Rule 触发的子 Action 数量必须受限，例如：

- 默认 `maxChildActions = 10`

超过即失败。

## 8. 幂等与重复触发

### 8.1 子 Action 必须独立幂等

如果子 Action 会产生记录、外部副作用或跨模块写入，它必须有自己的幂等策略。

不能指望“父 Action 只调一次”来保证安全。

### 8.2 审批重新执行场景

在 `pending_approval -> approved -> re-execute` 场景下，父 Action 会重新跑一遍。

因此 Rule `execute_action` 必须回答：

- 重新执行时子 Action 是否会再次触发
- 再次触发是否安全

默认要求：

- 要么子 Action 自身幂等
- 要么相关 Rule 在重新执行时被显式跳过

否则容易出现重复创建附属对象。

## 9. 与审批的关系

### 9.1 审批优先于 execute_action

统一执行契约中，`require_approval` 优先级高于 `execute_action`。

因此：

- 若同一次 Rule 决议里存在审批要求
- 则父 Action 先进入 `pending_approval`
- 前置 `execute_action` 不应在审批前偷跑

### 9.2 审批通过后的重新执行

审批通过后重新执行时，才允许重新评估 `execute_action`。

这意味着：

- 子 Action 的幂等性必须成立
- 或者该 Rule 在审批恢复执行时被跳过

## 10. 与 Flow / EventHandler 的边界

### 10.1 用 `execute_action`

适用：

- 前置
- 同步
- 失败即中断
- 轻量
- 有限深度

### 10.2 用 EventHandler

适用：

- 主事务成功后再做
- 即发即忘
- 允许异步重试
- 不应阻断主流程

### 10.3 用 Flow / Temporal

适用：

- 多步串联
- 分支
- 并行
- 超时
- 等待人或事件
- 补偿

## 11. Validation 要求

Validation 至少必须检查：

- 子 Action 是否存在
- 子 Action 是否暴露为 `internal`
- 是否存在直接环
- 预估链深是否超限
- 同一 Rule 中是否声明了过多子 Action
- 是否与审批语义冲突

遇到以下情况应直接失败：

- 检测到环
- 子 Action 不存在
- 子 Action 仅供外部接口使用而非内部调用
- 子 Action 明显依赖主 Action 结果

## 12. 推荐替代方案

如果团队在评审时对某个 `execute_action` 是否合理存在争议，默认按以下优先级选择替代方案：

1. 主 Action handler 显式调用
2. EventHandler
3. Flow / Temporal
4. 最后才考虑 Rule `execute_action`

原因很简单：

- handler 更显式
- EventHandler 更适合后置异步
- Flow 更适合编排
- Rule `execute_action` 最难读、最难调试、最容易藏复杂度

## 13. 与现有文档的关系

- `05_rule.md` 定义 Rule effect
- `23_rule_engine_and_flow.md` 定义 Rule Engine 与 Flow 分工
- `39_execution_contract.md` 定义统一时序与失败传播
- 本文专门收紧 `execute_action` 的使用边界

## 14. 与里程碑的关系

### M0

- 可以保留能力定义
- 但实现上应尽量少用

### M1

- 必须实现循环检测、深度限制、失败传播
- Validation 必须能识别明显不合理用法

### M2

- 若出现大量复杂联动，应推动迁移到 Flow / Temporal
