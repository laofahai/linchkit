# 缓存策略设计规范

> Tracking milestones:
> - `M5: Production Readiness`
>
> Related issues:
> - GitHub Issue `#73` — Cache strategy completion
>
> Execution source of truth: GitHub milestones and issues.

## 1. 概述

核心设计原则：

- **正确性优先**：宁可多一次 cache miss，不容忍脏数据读取
- **渐进式复杂度**：初期依赖进程内缓存 + Postgres 通知，后期按需引入 Redis
- **写入路径零缓存**：Action 作为唯一写入口，写路径不经过缓存，仅在写完成后触发失效

## 2. 缓存分层模型

```
┌─────────────────────────────────────────────┐
│  L1 - 进程内缓存（Map / LRU）               │  延迟 < 1μs
├─────────────────────────────────────────────┤
│  L2 - 分布式缓存（可选 Redis）              │  延迟 < 1ms
├─────────────────────────────────────────────┤
│  L3 - Postgres（source of truth）           │  延迟 ~ 1-5ms
└─────────────────────────────────────────────┘
```

所有缓存层均为 L3 的派生视图，失效方向自下而上传播。

## 3. 定义缓存（Definition Registry）

### 3.1 基础定义（Git 来源）

启动时一次性加载到进程内 Map，生命周期与进程一致。不设 TTL、不设 LRU 淘汰——只读的、有限的、与代码版本绑定的。每次加载完成后计算整体 hash 作为 `definitionVersion`。

### 3.2 租户覆盖（DB 来源）

- 缓存键：`override:{tenantId}:{type}:{name}`
- 存储：L1 进程内 LRU
- TTL：5 分钟软过期 + stale-while-revalidate
- 失效：租户修改覆盖后发出失效通知

### 3.3 定义合并视图

运行时实际使用的定义 = 基础定义 + 租户覆盖合并结果。缓存在 L1，键为 `merged:{tenantId}:{type}:{name}`。基础定义变更（部署）或租户覆盖变更时清除。

## 4. 权限决策缓存

| 缓存项 | 键 | 存储层 | TTL |
|---|---|---|---|
| 用户权限集合 | `perm:{tenantId}:{userId}:actions` | L1 LRU | 10 分钟 |
| 数据过滤条件 | `perm:{tenantId}:{userId}:{schema}:filter` | L1 LRU | 10 分钟 |

失效策略：**主动失效 + TTL 兜底**。权限相关 Action 执行成功后广播失效事件，按 `tenantId` 整体失效（权限变更低频，粗粒度可接受）。

## 5. GraphQL 查询缓存

- 缓存键：`query:{tenantId}:{schema}:{queryHash}`（queryHash 包含权限过滤条件，确保不同权限不命中同一缓存）
- 存储：L1 进程内 LRU，容量可配置
- TTL：30 秒 ~ 2 分钟，按 Schema 写入频率分级配置
- 写后失效：Action 成功后按 `{tenantId}:{schema}` 级别清除该 Schema 全部查询缓存
- 可选禁用：Schema 可标记 `cache: false`（写入频繁的场景）

## 6. 蓝绿部署的缓存一致性

蓝绿部署依赖流量切换的原子性，**不需要跨实例缓存同步**：

- 新实例（Green）启动时加载新版本定义，完成预热后接收流量
- 切换后 Green 的查询缓存是冷的——冷启动延迟在毫秒级，可接受
- 不存在新旧实例同时服务同一请求的情况

## 7. 多实例缓存同步

### Phase 1：Postgres LISTEN/NOTIFY

Action 执行成功后向 Postgres 发送 NOTIFY，payload 包含 `{tenantId, type, target}`。所有实例 LISTEN 该 channel，收到后清除本地对应缓存。TTL 兜底确保最终一致。适用于实例数 < 10 的场景。

### Phase 2：Redis Pub/Sub + 共享缓存（按需）

实例数增长时引入 Redis 作为 L2 共享缓存 + Pub/Sub 广播。通过可插拔的 `CacheProvider` 接口切换，L1 逻辑不变。

## 8. 失效事件流

```
Action 执行成功
  ├─→ 清除本地 query:{tenantId}:{schema}:* 缓存
  ├─→ 若为权限相关 Action → 清除 perm:{tenantId}:* 缓存
  ├─→ 若为租户覆盖相关 Action → 清除 override + merged 缓存
  └─→ 发送跨实例失效通知（NOTIFY / Redis Pub/Sub）
```

## 9. 监控

每个缓存层暴露：命中率、驱逐率、失效延迟、内存占用。通过 `/internal/cache/stats` 端点暴露。

## 10. 设计决策记录

| 决策 | 选择 | 理由 |
|---|---|---|
| 基础定义不设 TTL | 与进程生命周期绑定 | 定义来自 Git，部署即更新 |
| 权限失效粒度为租户级 | 粗粒度清除 | 权限变更低频，细粒度追踪不值得 |
| 查询缓存失效粒度为 Schema 级 | 不做行级/字段级 | Action 可能触发级联变更，精确追踪成本高 |
| 初期不引入 Redis | Postgres NOTIFY 兜底 | 减少依赖，多数场景实例数 < 10 |
| 蓝绿部署不做跨版本缓存同步 | 依赖流量原子切换 | 两个版本定义可能不兼容 |
