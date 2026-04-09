# 发布兼容性与迁移协议

> Tracking milestones:
> - `M5: Platform Maturity & AI Evolution`
>
> Related issues:
> - GitHub Issue `#74` — Release compatibility & versioning
>
> Execution source of truth: GitHub milestones and issues.

## 1. 定位

本文定义 LinchKit 在以下场景中的**硬约束**：

- 单机蓝绿部署
- 共享 PostgreSQL 的新旧版本并存
- Schema 变更与 DB migration
- SaaS 模式下 tenant override 的版本安全
- 回滚窗口与回滚条件

这不是“推荐做法”，而是发布阶段必须遵守的兼容性协议。

如果与其他文档冲突，以本文为准。

## 2. 核心原则

### 2.1 发布的真实边界

LinchKit 的一次发布，不是“代码构建成功”就算完成，而是同时满足：

1. 新版本实例可启动
2. 新版本实例健康检查通过
3. 新旧版本在切换窗口内都能访问同一数据库
4. migration 不破坏旧版本仍在执行的请求
5. 如需回滚，系统仍有一条可执行路径

任何一条不满足，都不能视为可发布。

### 2.2 蓝绿部署下的兼容性定义

在 LinchKit 中，“兼容”至少意味着：

- 旧版本代码在切流前仍可读写数据库
- 新版本代码在切流后可正常工作
- 切换窗口内不会因为 migration 导致旧版本立即崩溃

因此，**共享数据库蓝绿部署默认要求向后兼容，而不是只要求新版本可运行。**

### 2.3 回滚优先于清理

发布阶段优先保证可回滚，而不是优先做结构清理。

结论：

- 可以暂时保留废弃字段
- 可以容忍一段时间的冗余写入
- 不允许为了“结构干净”牺牲回滚能力

## 3. 发布类型

### 3.1 类型划分

| 类型 | 含义 | 默认要求 |
|------|------|----------|
| `safe` | 不涉及共享库不兼容风险 | 可正常蓝绿发布 |
| `expand` | 只增加能力，不破坏旧版本 | 可先 migration 再切换 |
| `contract` | 删除旧结构或收紧约束 | 必须两阶段发布 |
| `breaking` | 无法在共享库蓝绿窗口安全共存 | 禁止直接发布 |

### 3.2 默认映射

#### 视为 `safe`

- 只改文案、label、描述
- 新增不参与持久化的 View 配置
- 新增只读查询
- 新增不依赖数据库结构变更的非关键路径逻辑

#### 视为 `expand`

- 加新表
- 给已有表加可空字段
- 给已有表加带安全默认值的新字段
- 加新索引
- 加新事件类型
- 加新 capability 配置项

#### 视为 `contract`

- 删除字段
- 将可空字段改为非空
- 收紧唯一约束
- 删除表
- 删除旧事件消费逻辑
- 删除旧配置项并停止兼容读取

#### 视为 `breaking`

- 修改字段语义但复用原列名
- 直接改字段类型且旧代码无法继续读写
- 一次发布同时做“删旧字段 + 新代码强依赖新字段”
- migration 执行后旧版本必然报错

`breaking` 变更禁止走一次性蓝绿发布，必须重构方案。

## 4. 数据库变更协议

### 4.1 允许直接发布的数据库变更

以下变更允许在单次发布中执行：

- 新增表
- 新增可空列
- 新增有稳定默认值的列
- 新增索引
- 新增不会影响旧代码的辅助表

要求：

- 旧版本可以忽略这些变更
- 新版本不能假设历史数据已经全部回填

### 4.2 禁止直接发布的数据库变更

以下变更不得在一次蓝绿发布中直接执行：

- 直接删除列
- 直接删除表
- 直接把列从 nullable 改为 not null，且库中已有旧数据
- 直接修改列类型，导致旧代码解析失败
- 直接修改枚举语义，导致旧值失效

这些必须走 `expand -> migrate data -> contract` 三阶段。

### 4.3 三阶段协议

#### Phase A: Expand

目标：先把新结构加进去，不破坏旧版本。

允许操作：

- 新增列 / 新表 / 新索引
- 新代码开始双写
- 新代码优先读新字段，必要时回退读旧字段

#### Phase B: Migrate Data

目标：把旧数据搬到新结构。

要求：

- 必须是可重复执行的
- 必须可观测
- 必须可以中断后继续
- 不得假设一次跑完

#### Phase C: Contract

目标：确认旧路径已停止使用后，再删除旧结构。

前置条件：

1. 新版本已稳定运行一个发布窗口
2. 数据回填完成
3. 读路径已不再依赖旧结构
4. 回滚窗口已关闭或已有新的回滚方案

未满足这些条件，不得执行结构清理。

## 5. 应用层兼容协议

### 5.1 读路径协议

新版本上线后的一个兼容窗口内，读路径必须遵循：

- 能兼容历史数据
- 能容忍新字段为空
- 不把“回填未完成”当成异常路径

例如：

```typescript
// 允许在迁移窗口内读取旧字段兜底
displayName = row.display_name_new ?? row.display_name
```

### 5.2 写路径协议

当结构升级处于 expand 阶段时，写路径必须明确采用以下之一：

- `dual-write`：同时写新旧字段
- `new-write + read-fallback`：只写新字段，但读路径兼容旧字段

禁止模糊状态：

- 新代码只写新字段
- 旧代码只读旧字段
- 又没有清晰切换窗口

这会导致切换期间数据分叉。

### 5.3 事件协议

事件结构变更必须保持兼容窗口：

- 新消费者应容忍旧事件字段不存在
- 旧消费者应容忍新事件字段多出
- 禁止直接复用旧字段名表达新语义

如需重大变化，应升级事件版本，例如：

- `purchase_request.submitted.v1`
- `purchase_request.submitted.v2`

## 6. 回滚协议

### 6.1 回滚分级

| 回滚类型 | 场景 | 要求 |
|----------|------|------|
| 流量回滚 | 旧实例仍在运行 | 必须秒级可执行 |
| 版本回滚 | 旧实例已停，但 DB 仍兼容 | 必须可重新部署旧版本 |
| 数据回滚 | migration 已破坏兼容 | 视为高风险人工操作 |

### 6.2 发布前必须回答的回滚问题

每次带 migration 的发布，必须明确：

1. 流量切回旧实例是否仍可工作
2. 如果切回后继续写入，旧代码是否会产生脏数据
3. 是否需要执行 `down migration`
4. `down migration` 是否真的安全，还是只在理论上存在

如果这些问题回答不清，这次发布应被标记为高风险，不得自动化执行。

### 6.3 Down Migration 规则

LinchKit 不把“有 down 函数”视为“可安全回滚”。

`down migration` 只有在以下条件同时满足时，才允许自动执行：

- 不会删除发布窗口内新增的重要数据
- 不会破坏仍被旧版本依赖的数据
- 已经证明回滚后系统仍可启动

否则：

- 可以保留 down 函数用于开发环境
- 生产环境回滚只做流量回切或版本回滚，不自动回滚数据结构

## 7. SaaS 模式下 tenant override 的版本安全

### 7.1 基本原则

tenant override 是运行时覆盖值，不是绕过版本治理的后门。

平台版本升级时，必须验证现有 override 是否仍落在新版本允许的覆盖边界内。

### 7.2 升级校验

平台发布新版本时，对每个 override 至少做以下检查：

- `target` 仍存在
- 被覆盖字段仍标记为 `overridable: true`
- 覆盖值类型仍合法
- 旧的 target path 没有失效

结果分类：

| 结果 | 处理 |
|------|------|
| `valid` | 继续生效 |
| `needs_migration` | 自动迁移或提示平台处理 |
| `invalid` | 阻止发布或先禁用该 override |

### 7.3 不允许的做法

- 平台改了 Rule / View 结构，但不校验历史 override
- 删除 target 后，默认让 tenant override 静默失效
- 把 override 兼容问题留给运行时报错

tenant override 的兼容性必须在发布前解决，不应推迟到租户请求时暴露。

## 8. 发布前检查清单

带结构变更的发布至少检查以下项目：

### 8.1 数据库

- migration 是否属于 `expand / contract / breaking`
- 是否涉及数据回填
- 是否需要双写
- 旧版本是否仍可访问共享库

### 8.2 应用

- 新版本是否容忍迁移窗口内的数据不完整
- 是否存在旧字段读取兜底
- 是否有事件结构变化

### 8.3 回滚

- 旧实例是否保留到切换稳定后
- 流量回滚是否仍安全
- 是否需要人工参与

### 8.4 SaaS

- tenant override 是否批量校验通过
- 是否有 override 需要迁移
- 是否会因 target 删除导致租户配置失效

## 9. Validation 要求

`Validation` 在兼容性阶段至少必须输出：

```typescript
interface ReleaseCompatibilityResult {
  releaseType: 'safe' | 'expand' | 'contract' | 'breaking'
  oldVersionCanRead: boolean
  oldVersionCanWrite: boolean
  rollbackMode: 'traffic_only' | 'version_only' | 'manual'
  requiresBackfill: boolean
  requiresDualWrite: boolean
  tenantOverrideImpact: Array<{
    tenantId: string
    target: string
    status: 'valid' | 'needs_migration' | 'invalid'
  }>
  blockers: string[]
}
```

只要存在以下任一情况，Validation 必须失败：

- `releaseType === 'breaking'`
- `oldVersionCanRead === false`
- `oldVersionCanWrite === false` 且未明确禁止切换窗口写流量
- 存在 `tenant override` 为 `invalid`

## 10. 与现有文档的关系

- `02_runtime_change.md` 说明三层 Source of Truth 与蓝绿思路
- `12_deployment.md` 说明部署流程与基础 migration 规则
- `26_transaction_model.md` 说明变更事务与原子发布
- 本文补充的是：**共享库蓝绿下的兼容性硬约束**

## 11. 与里程碑的关系

### M0

- 不要求完整协议实现
- 但禁止写出明显不兼容的 migration 习惯

### M1

- 单机蓝绿部署必须遵守本文
- Validation 必须输出发布兼容性结论
- 对 `contract` 变更强制要求两阶段发布

### M2

- SaaS 下 tenant override 兼容校验纳入发布流程
- 平台升级前自动扫描 override 风险

### M4

- 多机 Rolling Update 也沿用本文协议
- 兼容性检查结果成为控制面发布准入条件
