# 多租户设计规范

## 1. 定位

多租户包含三层隔离：数据隔离（tenant_id）、能力隔离（启用不同 Capability）、定制隔离（不同配置和规则）。

## 2. 两种运行模式

### 2.1 独立部署模式（Standalone）

单租户或少量租户，自己管服务器。

```
全局定义 → TS 文件 / Git
租户定制 → tenants/ 目录下的 TS 文件
变更方式 → 全部走 PR + 蓝绿部署
```

### 2.2 SaaS 模式

多租户平台，租户需要自助定制。

```
全局定义 → TS 文件 / Git（平台团队管理，PR + 蓝绿部署）
租户定制 → 数据库（租户在管理 UI 自助操作，Validation 后立即生效）
变更方式 → 平台变更走 PR，租户变更走 DB 热生效
```

### 2.3 配置切换

```typescript
// linchkit.config.ts
export default defineConfig({
  mode: 'standalone',  // 'standalone' | 'saas'
})
```

## 3. 核心引擎行为

两种模式共享同一套合并逻辑，只是定义来源不同：

```
启动时：
  1. 从 TS 文件加载全局 Capability 定义（两种模式都一样）
  2. if standalone → 从 tenants/ 目录加载租户覆盖（TS 文件）
     if saas     → 从数据库加载租户覆盖
  3. 全局 + 租户覆盖合并，缓存在内存中

运行时（请求进来）：
  1. 确定 tenant_id
  2. 取该租户的合并后定义集
  3. 用该定义集处理请求
  → 两种模式运行时行为完全一样
```

## 4. 三层隔离

### 4.1 数据隔离

每张业务表自动包含 `tenant_id` 字段（M0 就预留），所有查询自动附加 `WHERE tenant_id = current_tenant`。

### 4.2 能力隔离

不同租户启用不同的 Capability：

```
租户 A（制造业）：采购管理 ✅、库存管理 ✅、HR ✅、CRM ❌
租户 B（服务业）：采购管理 ❌、库存管理 ❌、HR ✅、CRM ✅
```

### 4.3 定制隔离

同一 Capability，不同租户有不同的配置、Rule、View。

## 5. Standalone 模式的代码结构

```
capabilities/                        ← 全局 Capability（所有租户共享）
  purchase_management/
    capability.ts
    schema/
    actions/
    rules/
    views/

tenants/                             ← 租户覆盖（TS 文件）
  tenant_a/
    config.ts                        ← 租户配置
    purchase_management/
      rules/
        food_safety_check.ts         ← 租户 A 专属规则
      views/
        purchase_request_form.ts     ← 租户 A 覆盖的表单
  tenant_b/
    config.ts
```

所有变更（包括租户覆盖）走 PR + 蓝绿部署。

## 6. SaaS 模式的租户自助变更

### 6.1 租户覆盖存储

租户覆盖存 Postgres（JSONB）：

```sql
CREATE TABLE tenant_overrides (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  type        TEXT NOT NULL,         -- 'rule' | 'view' | 'config' | 'schema_extension' | 'navigation'
  target      TEXT NOT NULL,         -- 覆盖目标（如 'purchase_management.amount_check'）
  definition  JSONB NOT NULL,        -- 覆盖定义（声明式 JSON）
  enabled     BOOLEAN DEFAULT true,
  created_by  TEXT NOT NULL,
  created_at  TIMESTAMP NOT NULL,
  updated_at  TIMESTAMP NOT NULL,
  version     INTEGER DEFAULT 1,     -- 乐观锁
);
```

### 6.2 租户自助变更流程

```
租户管理员在 UI 中操作
    ↓
1. 选择操作（加规则、改阈值、调布局等）
    ↓
2. Validation（实时）
   - 定义合法性检查
   - 兼容性检查
    ↓
3. 预览（变更前后对比）
    ↓
4. 确认
    ↓
5. 写入 tenant_overrides 表 → 刷新该租户的内存缓存 → 立即生效
    ↓
6. 记录变更历史（审计）
    ↓
7. 支持回滚
```

### 6.3 SaaS 模式下租户能自助做什么

| 操作 | 自助 | 需平台介入 |
|------|:---:|:---:|
| 启用/禁用 Capability | ✅ | |
| 调整参数（阈值等） | ✅ | |
| 新增声明式 Rule | ✅ | |
| 修改声明式 Rule | ✅ | |
| 新增/修改 View 布局 | ✅ | |
| 扩展 Schema（加字段） | ✅ | 需 DB migration |
| 新增代码式 Action | | ✅ |
| 新增代码式 Rule | | ✅ |
| 新增整个 Capability | | ✅ |

**声明式定义可以自助，代码式需要平台介入。**

### 6.4 缓存刷新

租户覆盖变更后：
- 更新数据库
- 刷新该租户在内存中的定义缓存
- 后续请求使用新定义
- 其他租户不受影响

多实例部署时，通过 Postgres LISTEN/NOTIFY 通知所有实例刷新缓存。

## 7. 租户配置

### Standalone 模式

```typescript
// tenants/tenant_a/config.ts
import { defineTenantConfig } from '@linchkit/core'

export default defineTenantConfig({
  tenant: 'tenant_a',
  label: '食品公司 A',
  capabilities: {
    purchase_management: { enabled: true, config: { approval_threshold: 10000 } },
    inventory_management: { enabled: true },
    crm: { enabled: false },
  },
})
```

### SaaS 模式

租户配置存数据库，通过管理 UI 操作。

## 8. 租户基础信息

```typescript
defineSchema({
  name: 'tenant',
  fields: {
    name: { type: 'string', required: true },
    slug: { type: 'string', required: true, unique: true },
    status: { type: 'state', machine: 'tenant_lifecycle' },
    plan: { type: 'enum', options: ['free', 'standard', 'enterprise'] },
    mode: { type: 'enum', options: ['standalone', 'saas'] },
    contact_email: { type: 'string', format: 'email' },
    settings: { type: 'json' },
  },
})
```

## 9. 租户与权限

- 每个租户有自己的用户和权限组
- system_admin 可以跨租户操作
- 普通用户只能看到自己租户的数据和 Capability
- 租户管理员可以管理本租户内的用户和权限
- SaaS 模式下，平台管理员可以管理所有租户

## 10. 隔离方案

| 方案 | 隔离级别 | 适用场景 | 里程碑 |
|------|----------|---------|--------|
| 行级隔离（tenant_id） | 低 | 标准 SaaS | M0 预留，M2 完整 |
| Schema 级隔离 | 中 | 租户需独立表结构 | M4 |
| 数据库级隔离 | 高 | 大租户、合规要求 | M4 |
| 独立部署 | 最高 | 特大租户 | M4 |

## 11. 与里程碑的关系

### M0
- tenant_id 系统字段预留
- 查询自动附加 tenant_id 过滤
- 单租户运行

### M2
- Standalone：tenants/ 目录 + defineTenantConfig
- SaaS：tenant_overrides 表 + 租户自助 UI + 缓存刷新
- 租户管理（创建/禁用/配置）

### M4
- Schema 级 / 数据库级隔离
- 独立部署选项
- 租户级计费 / 用量统计
