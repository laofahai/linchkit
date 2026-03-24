# 配置中心

## 1. 概述

配置中心是 `@linchkit/core` 中的**核心基础设施**模块，为 LinchKit 的所有配置提供统一的概念模型——从基础设施配置到业务级参数。

它与事件总线、数据访问层、Command Layer 并列，是所有 Capability 都依赖的基础设施。

### 1.1 配置分类体系

LinchKit 配置沿两个轴组织：**类型**和**可变性**。

```
┌─────────────────────────────────────────────────────────────────┐
│                          配置中心                                 │
├────────────────────────────┬────────────────────────────────────┤
│   系统配置                  │   业务配置                          │
│   (基础设施)                │   (领域 / 应用)                     │
│                            │                                    │
│   仅静态。                  │   ┌─ KV 配置 ──────────────────┐   │
│   linchkit.config.ts       │   │  简单键值对                  │   │
│   + $env.*                 │   │  作用域: 全局 → 租户          │   │
│                            │   │  → 部门 → 用户               │   │
│   DB URL、服务端口、        │   │  存储在数据库                 │   │
│   加密密钥环境变量、        │   │  如：审批阈值、功能开关       │   │
│   JWT 密钥...              │   └──────────────────────────────┘  │
│                            │                                    │
│   只放 DB 可用之前          │   ┌─ 配置模型 ─────────────────┐   │
│   就必须确定的东西          │   │  结构化配置数据              │   │
│                            │   │  SchemaDefinition +          │   │
│                            │   │    purpose: 'config'         │   │
│                            │   │  完整 CRUD + 视图            │   │
│                            │   │  如：单据类型、税率表、       │   │
│                            │   │  编号规则                    │   │
│                            │   └──────────────────────────────┘  │
├────────────────────────────┴────────────────────────────────────┤
│   统一声明: defineConfigSchema (Zod)                              │
│   统一访问: configSchemaRef.from(ctx)                             │
└─────────────────────────────────────────────────────────────────┘
```

| 维度 | 选项 | 区分规则 |
|------|------|---------|
| **类型** | 系统 vs 业务 | 系统 = DB 可用之前就必须确定的；业务 = 其他一切 |
| **可变性** | 静态 vs 动态 | 静态 = `linchkit.config.ts`，启动后不可变；动态 = DB 存储，运行时可变 |
| **结构** | KV vs 配置模型 | KV = 简单标量值；配置模型 = 结构化记录（`SchemaDefinition` + `purpose: 'config'`） |
| **作用域** | 全局 → 租户 → 部门 → 用户 | 动态配置支持作用域级联；静态配置始终全局 |

### 1.2 本规范范围

本规范覆盖**完整概念模型**，但分阶段实现：

| 内容 | 阶段 |
|------|------|
| 系统配置（静态，`linchkit.config.ts`） | **M0a** — 立即实现 |
| Capability 静态配置（Zod schema + factory） | **M0a** — 立即实现 |
| `ConfigRegistry` + 启动校验 | **M0a** — 立即实现 |
| `defineConfigSchema` + 类型安全访问器 | **M0a** — 立即实现 |
| 业务 KV 配置（DB 存储、带作用域） | **M1** — 现在设计，后续实现 |
| 配置模型（Schema 驱动的结构化配置） | **M1** — 现在设计，后续实现 |
| 作用域级联（租户 → 部门 → 用户） | **M1+** — 现在设计，后续实现 |
| 动态配置 + 脱敏/加密集成 | **M1+** — 现在设计，后续实现 |

### 1.3 核心职责（静态层 — M0a）

1. **收集** — 从 `defineConfig()` 收集系统配置 + 从各 `CapabilityDefinition.config` 收集 Capability 配置
2. **解析** — 递归替换 `$env.VAR_NAME` 占位符为实际环境变量值
3. **校验** — 通过 Zod schema 解析所有配置；启动时快速失败并给出清晰错误信息
4. **冻结** — 将所有已解析配置深度冻结为不可变（`Object.freeze`）
5. **注入** — 通过 `ActionContext` 和 `TransportContext` 提供 `ConfigRegistry`
6. **访问** — 通过 `configSchemaRef.from(ctx)` 模式提供类型安全的访问器

## 2. 设计原则

### 2.1 静态配置 = 仅放 DB 可用之前必须确定的

`linchkit.config.ts` 与数据库的分界规则：

> **系统没有它就无法启动的，放 `linchkit.config.ts`。其他一切放数据库。**

| 放 `linchkit.config.ts` | 放数据库 |
|--------------------------|---------|
| 数据库连接 URL | 审批阈值 |
| 服务端口 / 主机 | 功能开关 |
| 加密密钥环境变量名 | 通知设置 |
| JWT 签名密钥 | 第三方 API 密钥（管理员配置） |
| AI 提供商凭证 | 业务规则参数 |

`linchkit.config.ts` 在启动时求值一次，运行期间不再修改。它应该**尽量精简**——只放基础设施引导配置。

**理由**：`linchkit.config.ts` 越精简，意味着更少的重启、更少的部署配置，以及"开发者关注点"（基础设施）和"管理员关注点"（业务设置）之间更清晰的分离。

### 2.2 Zod 作为唯一真相源

每一项配置——系统级或 Capability 级——都定义为 Zod schema。Zod schema 同时产出：
- **TypeScript 类型**（`z.infer<>`）— 编译时安全
- **运行时校验**（`.parse()`）— 启动时安全
- **默认值**（`.default()`）— 不需要单独的默认值层
- **文档**（`.describe()`）— 自描述配置

不做平行的类型定义。不手写与校验逻辑脱节的 `interface`。

### 2.3 启动时快速失败

缺失或无效的配置**必须**在启动时立即给出清晰错误——而不是几分钟后的运行时崩溃。错误信息必须标明：
- 哪个配置项失败
- 期望的类型 vs 实际收到的值
- 哪个环境变量缺失（如适用）

```
[linch] 配置校验失败：

  cap-auth.jwtSecret:
    ✗ 必填 — 环境变量 JWT_SECRET 未设置

  server.port:
    ✗ 期望 number，收到 string "abc"

启动已中止。
```

**关键行为**：错误被收集后一次性报告（不是逐个抛出），开发者能一次看到所有配置问题，避免"修一个-重启-再发现下一个"的循环。

### 2.4 编程式依赖 vs 声明式配置

Capability 工厂函数接受两种输入：

| 类别 | 示例 | 通过 ConfigRegistry？ |
|------|------|----------------------|
| **编程式依赖** | `AuthProvider` 实例、`PermissionRegistry` | 否 — 不可序列化、不可校验 |
| **声明式配置** | `jwtSecret`、`tokenExpiry`、`port` | 是 — Zod 校验、env 解析、冻结 |

规则：如果是 **string、number、boolean 或简单对象**，可以来自配置文件或环境变量 → 声明式配置。如果是**类实例、函数或复杂运行时对象** → 编程式依赖。

### 2.5 约定优于配置

- 系统配置 schema 使用 `system:` 命名空间前缀
- Capability 配置 schema 使用其 Capability 名称（如 `cap-auth`）
- 每个 `defineConfigSchema` 调用是唯一权威定义——不在其他地方重复声明
- Capability 配置 schema 从 Capability 包导出，供消费者引用类型

## 3. 配置分层

### 3.1 系统配置

在 `@linchkit/core` 中定义，全局生效：

```typescript
// packages/core/src/config/system-schemas.ts

export const serverConfig = defineConfigSchema('system:server', {
  port: z.number().default(3001),
  host: z.string().default('0.0.0.0'),
});

export const databaseConfig = defineConfigSchema('system:database', {
  url: z.string().optional(),
  poolSize: z.number().default(10),
  debug: z.boolean().default(false),
});

export const queueConfig = defineConfigSchema('system:queue', {
  pollInterval: z.number().default(1000),
  batchSize: z.number().default(10),
});

export const securityConfig = defineConfigSchema('system:security', {
  encryption: z.object({
    keyProvider: z.enum(['env', 'kms']).default('env'),
    keyEnvVar: z.string().default('LINCHKIT_ENCRYPTION_KEY'),
    keyVersion: z.number().default(1),
  }).optional(),
});
```

### 3.2 Capability 配置

每个 Capability 声明自己的配置 schema 并导出：

```typescript
// capabilities/cap-auth/src/config.ts

export const capAuthConfig = defineConfigSchema('cap-auth', {
  jwtSecret: z.string().describe('JWT signing secret for token generation'),
  tokenExpiry: z.number().default(3600).describe('Token expiry in seconds'),
  sessionCookieName: z.string().default('session'),
  allowAnonymous: z.boolean().default(false),
});
```

### 3.3 用户侧配置（linchkit.config.ts）

```typescript
import { defineConfig } from '@linchkit/core';
import { createCapAuth } from '@linchkit/cap-auth';
import { createCapDataSecurity } from '@linchkit/cap-data-security';

export default defineConfig({
  // 系统配置 — 按系统 schema 校验
  server: { port: 3001 },
  database: { url: '$env.DATABASE_URL' },
  security: {
    encryption: {
      keyProvider: 'env',
      keyEnvVar: 'LINCHKIT_ENCRYPTION_KEY',
    },
  },

  // 带配置的 Capability
  capabilities: [
    createCapAuth({
      provider: createDevAuthProvider(),    // 编程式依赖
      config: {                              // 声明式配置
        jwtSecret: '$env.JWT_SECRET',
        tokenExpiry: 7200,
      },
    }),
    createCapDataSecurity({
      config: {
        maskingEnabled: true,
        bypassGroups: ['system_admin'],
      },
    }),
    capAdapterServer,                        // 无需配置
  ],
});
```

## 4. API 设计

### 4.1 `defineConfigSchema`

Core 提供的辅助函数，将 Zod schema 绑定到配置命名空间并返回类型安全的访问器。

```typescript
interface ConfigSchemaRef<T> {
  /** 配置命名空间名称 */
  readonly name: string;
  /** 用于校验的 Zod schema */
  readonly schema: ZodObject<any>;
  /** 类型安全的访问器。在 action handler / transport factory 中使用。 */
  from(ctx: { config: ConfigRegistry }): Readonly<T>;
}

function defineConfigSchema<T extends ZodRawShape>(
  name: string,
  shape: T,
): ConfigSchemaRef<z.infer<z.ZodObject<T>>>;
```

**使用模式：**

```typescript
// 1. 定义（在 cap 的 config.ts 中，只定义一次）
export const myConfig = defineConfigSchema('cap-foo', {
  apiKey: z.string(),
  retries: z.number().default(3),
});

// 2. 声明（在 capability 定义中）
defineCapability({
  name: 'cap-foo',
  configSchema: myConfig.schema,
  config: options.config,
});

// 3. 访问（在 handler 中，类型安全，零 cast）
const { apiKey, retries } = myConfig.from(ctx);
```

### 4.2 `ConfigRegistry`

核心配置存储，启动时创建一次，注入到所有上下文中。

```typescript
class ConfigRegistry {
  /**
   * 创建注册表：解析环境变量 → 校验所有 schema → 冻结。
   * 校验失败时抛出 LinchKitError（type: 'validation'）。
   */
  static create(
    rawConfig: LinchKitConfig,
    capabilities: CapabilityDefinition[],
  ): ConfigRegistry;

  /** 按命名空间名称获取已注册的配置区段 */
  get<T = Record<string, unknown>>(name: string): Readonly<T>;

  /** 检查命名空间是否已注册 */
  has(name: string): boolean;

  /** 获取所有已注册的命名空间名称 */
  keys(): string[];
}
```

说明：不提供 `getCapability()` 和 `getSystem()` 便捷方法。统一的 `get(name)` 同时适用于两者——系统配置使用 `system:*` 前缀，Capability 配置使用其 Capability 名称。主要访问模式是 `configSchemaRef.from(ctx)`，内部调用 `get()`。

### 4.3 `CapabilityDefinition` 扩展

```typescript
interface CapabilityDefinition {
  // ... 已有字段不变

  /**
   * 声明此 Capability 的配置结构的 Zod schema。
   * ConfigRegistry 在启动时用于校验。
   *
   * 注意：此字段引入 zod 作为 @linchkit/core types 层的依赖。
   * 由于 core 引擎层已使用 zod（schema-to-zod.ts），
   * 这是合理的——zod 是 core 的直接依赖。
   */
  configSchema?: ZodObject<any>;

  /**
   * 配置值。由工厂函数填入。
   * Core 在启动时解析环境变量并按 configSchema 校验。
   */
  config?: Record<string, unknown>;
}
```

### 4.4 上下文集成

```typescript
interface ActionContext {
  // ... 已有字段
  config: ConfigRegistry;
}

interface TransportContext {
  // ... 已有字段
  config: ConfigRegistry;   // 替换原来的: config: Record<string, unknown>
}
```

## 5. 启动校验流程

```
linchkit.config.ts
  │
  ▼
loadConfig()
  │  加载并求值配置文件
  ▼
ConfigRegistry.create(rawConfig, capabilities)
  │
  ├─ 步骤 1：解析系统配置中的环境变量
  │    resolveEnvVars({ server, database, security, queue, ... })
  │
  ├─ 步骤 2：校验系统配置
  │    对每个系统 schema（server, database, security, ...）：
  │      schema.parse(resolvedSection)
  │      → 成功：存入注册表 "system:*" 命名空间
  │      → 失败：收集错误
  │
  ├─ 步骤 3：解析 + 校验 Capability 配置
  │    对每个带 configSchema 的 Capability：
  │      resolveEnvVars(cap.config)
  │      cap.configSchema.parse(resolved)
  │      → 成功：存入注册表 cap.name 命名空间
  │      → 失败：收集错误
  │
  ├─ 步骤 4：检查收集的错误
  │    if errors.length > 0:
  │      格式化所有错误为人类可读信息
  │      抛出 LinchKitError({ type: 'validation', message })
  │      → 启动中止
  │
  └─ 步骤 5：深度冻结所有已存储配置
       递归 Object.freeze()
       → ConfigRegistry 此后不可变
```

## 6. Capability 配置声明约定

### 6.1 文件结构

```
capabilities/cap-foo/
  src/
    config.ts          ← defineConfigSchema + 导出
    factory.ts         ← createCapFoo() 工厂函数，导入 config
    index.ts           ← 重新导出
```

### 6.2 命名约定

| 配置类型 | 名称模式 | 示例 |
|---------|---------|------|
| 系统配置 | `system:<section>` | `system:server`、`system:database` |
| Capability 配置 | `<capability-name>` | `cap-auth`、`cap-data-security` |

### 6.3 工厂函数模式

```typescript
// capabilities/cap-foo/src/factory.ts
import { capFooConfig } from './config';

interface CapFooOptions {
  // 编程式依赖（不是配置）
  provider?: FooProvider;
  registry?: FooRegistry;

  // 声明式配置（Zod 校验）
  config?: Partial<z.infer<typeof capFooConfig.schema>>;
}

export function createCapFoo(options: CapFooOptions = {}): CapabilityDefinition {
  return defineCapability({
    name: 'cap-foo',
    configSchema: capFooConfig.schema,
    config: options.config,
    // ... 使用 options.provider 来装配 actions/middlewares
  });
}
```

### 6.4 Handler 中访问配置

```typescript
// capabilities/cap-foo/src/actions/do-something.ts
import { capFooConfig } from '../config';

const handler: ActionHandler = async (ctx) => {
  // 类型安全、已校验、env 已解析、不可变
  const { apiKey, retries } = capFooConfig.from(ctx);
  // ...
};
```

## 7. 环境变量解析

### 7.1 语法

```
"$env.VARIABLE_NAME"
```

- 必须是**整个字符串值**（不支持插值如 `"prefix_$env.KEY"`）
- 递归处理：可用于嵌套对象和数组内部
- 在 Zod 校验之前解析。由于环境变量始终为 string，来自 `$env.*` 的数字/布尔字段应使用 `z.coerce.number()` / `z.coerce.boolean()` 而非 `z.number()` / `z.boolean()`

### 7.2 缺失变量行为

| 场景 | 行为 |
|------|------|
| `$env.FOO` 且 `FOO` 已设置 | 替换为值 |
| `$env.FOO` 且 `FOO` 未设置 | 替换为 `undefined` |
| 字段在 Zod schema 中为必填 | Zod 校验捕获 → 清晰错误信息 |
| 字段有 `.default()` | env 解析后应用默认值 → 正常工作 |

即：缺失的环境变量不在解析时失败——而是在校验时带上下文地失败。

## 8. 与其他模块的关系

### 8.1 数据安全与脱敏（spec 41）

- **系统级加密配置**（`security.encryption`）通过 `securityConfig` 系统 schema 声明
- **Capability 级脱敏配置**（`maskingEnabled`、`bypassGroups`）通过 `cap-data-security` 自己的 `configSchema` 声明
- 脱敏中间件通过 `capDataSecurityConfig.from(ctx)` 访问其配置
- 加密密钥提供者通过 `securityConfig.from(ctx).encryption.keyEnvVar` 读取密钥环境变量

### 8.2 认证（cap-auth）

- `AuthProvider` 是**编程式依赖** → 通过工厂函数 options 传入，不在配置中
- `jwtSecret`、`tokenExpiry`、`sessionCookieName` 是**声明式配置** → 通过 ConfigRegistry
- 消除当前 `dev.ts` 中根据 DB 可用性重新装配 cap-auth 的做法

### 8.3 Transport 适配器

- Transport 工厂接收 `TransportContext.config`（现在是 `ConfigRegistry` 而非原始 `Record`）
- 每个适配器通过自己的 `configSchemaRef.from(ctx)` 读取配置
- 系统配置（如服务端口）通过 `serverConfig.from(ctx)` 访问

### 8.4 Command Layer

- `ActionContext.config` 在 action 执行前由 CLI/runtime 填充
- 配置在 action handler 中只读——不可能修改（已冻结）

## 9. 业务配置（动态层 — M1+）

业务配置是运行时可变的，存储在数据库中，由管理员（而非开发者）管理。分为两种形式：**KV 配置**和**配置模型**。

### 9.1 KV 配置

存储在系统表中的简单键值对，支持作用域级联。

**系统表：`_linchkit.config`** (in `_linchkit` PostgreSQL schema via `pgSchema("_linchkit")`)

| 列 | 类型 | 说明 |
|----|------|------|
| `id` | `uuid` | 主键 |
| `namespace` | `text` | 配置命名空间（Capability 名称或 `system:*`） |
| `key` | `text` | 配置键 |
| `value` | `jsonb` | 配置值（任何 JSON 可序列化类型） |
| `scope` | `text` | `'global'` \| `'tenant'` \| `'department'` \| `'user'` |
| `scope_id` | `text` | 作用域标识（tenant_id、dept_id、user_id）。全局时为 NULL |
| `encrypted` | `boolean` | 值是否加密存储（spec 41） |
| `created_at` | `timestamptz` | |
| `updated_at` | `timestamptz` | |
| `updated_by` | `text` | 最后修改此值的 Actor |

**唯一约束：** `(namespace, key, scope, scope_id)`

**作用域级联解析：**

```
resolve(namespace, key, actor):
  1. 查用户作用域:   WHERE namespace=N AND key=K AND scope='user'       AND scope_id=actor.id
  2. 查部门作用域:   WHERE namespace=N AND key=K AND scope='department' AND scope_id=actor.departmentId
  3. 查租户作用域:   WHERE namespace=N AND key=K AND scope='tenant'     AND scope_id=actor.tenantId
  4. 查全局作用域:   WHERE namespace=N AND key=K AND scope='global'
  5. 回退到 Zod schema 默认值
  → 第一个匹配者胜出。
```

**缓存策略：** 已解析配置按请求缓存（非全局缓存），作用域变更在下一次请求立即生效。全局作用域可用短 TTL 缓存。

**声明 KV 配置项：**

Capability 声明哪些配置键是动态的（DB 存储）vs 静态的（`linchkit.config.ts`）：

```typescript
export const capApprovalConfig = defineConfigSchema('cap-approval', {
  // 静态：启动时需要，留在 linchkit.config.ts
  // （此 Capability 无静态配置）

  // 动态：存储在 DB，带作用域，运行时可变
  threshold: z.number().default(10000).describe('Approval amount threshold'),
  requireDualSign: z.boolean().default(false).describe('Require dual signature'),
}, {
  // 默认标记所有字段为动态
  storage: 'dynamic',
  // 或标记特定字段：
  // static: [],          // 必须在 linchkit.config.ts 中的字段
  // dynamic: ['threshold', 'requireDualSign'],  // DB 存储的字段
});
```

当 `storage: 'dynamic'` 时，`configSchemaRef.from(ctx)` 访问器透明地查询 DB（带缓存）并应用作用域级联，回退到 Zod 默认值。访问模式与静态配置完全相同——调用者不需要知道也不关心值从哪里来。

### 9.2 配置模型

有些配置太复杂，KV 对无法表达——需要有自己的 CRUD、视图和权限的结构化记录。例如：

- **单据类型管理** — 每个类型有名称、编号规则、默认字段、审批流程
- **税率表** — 按地区、日期范围、类别的税率表
- **编号规则** — 前缀模式、序列计数器、重置规则

配置模型本质上就是一个带 `purpose: 'config'` 的 `SchemaDefinition`：

```typescript
defineSchema({
  name: 'document_type',
  purpose: 'config',    // ← 区别于业务数据 schema
  fields: {
    name: { type: 'string', required: true },
    prefix: { type: 'string', required: true },
    numberingRule: { type: 'string', default: '{prefix}-{YYYY}{MM}-{seq:4}' },
    requireApproval: { type: 'boolean', default: false },
    approvalFlow: { type: 'reference', target: 'flow' },
  },
});
```

**与普通 Schema 的区别：**

| 方面 | 业务 Schema | 配置 Schema（`purpose: 'config'`） |
|------|------------|----------------------------------|
| 数据量 | 无上限（订单、客户） | 少量（几十到几百条记录） |
| 管理者 | 最终用户 | 管理员 |
| 变更频率 | 高（日常操作） | 低（设置 / 维护） |
| 缓存 | 标准查询缓存 | 激进缓存（很少变更） |
| UI 位置 | 主导航 | 管理员 / 设置区域 |
| 多租户 | 始终租户隔离 | 全局或租户隔离 |

配置模型享有普通 Schema 的所有能力（CRUD action、视图、权限、脱敏），无需特殊运行时处理。`purpose: 'config'` 标志是元数据，用于：
- UI 路由（显示在设置区域，而非主导航）
- 缓存策略（更长的 TTL）
- 种子数据处理（配置模型通常需要种子/默认记录）

### 9.3 动态配置 + 数据安全（spec 41）

DB 中存储的动态配置可能包含敏感值（如管理员在运行时输入的第三方 API 密钥）。与 spec 41 的集成：

**加密：** 标记 `encrypted: true` 的 KV 配置条目使用与业务数据字段相同的 `EncryptionProvider` 加密存储。`_linchkit.config.value` 列在标记时存储加密的 JSONB。

**脱敏：** 通过 API 暴露配置值时（如管理员设置 UI），脱敏中间件生效。配置条目可声明脱敏规则：

```typescript
export const capIntegrationConfig = defineConfigSchema('cap-integration', {
  webhookUrl: z.string().describe('Webhook endpoint URL'),
  apiSecret: z.string().describe('Third-party API secret'),
}, {
  storage: 'dynamic',
  security: {
    apiSecret: { encrypted: true, masking: { default: 'partial', format: 'generic' } },
  },
});
```

管理员在设置 UI 中看到 `sk-****-ab12`；实际值在 DB 中加密存储。只有 `system_admin` 且有显式权限才能看到完整值。

### 9.4 统一访问模式

无论配置是静态还是动态、KV 还是模型，访问模式相同：

```typescript
// 静态配置（linchkit.config.ts）— 立即可用
const { jwtSecret } = capAuthConfig.from(ctx);

// 动态 KV 配置（DB）— 透明地按作用域级联解析
const { threshold } = capApprovalConfig.from(ctx);

// 配置模型（DB）— 通过标准 data provider 访问
const docTypes = await ctx.dataProvider.query('document_type', { filters: [] });
```

KV 配置使用 `configSchemaRef.from(ctx)`。配置模型使用标准 `dataProvider.query()`，因为它们是完整的 Schema。这个区分是有意为之的——KV 用于标量设置，配置模型用于结构化数据。

## 10. 本规范不覆盖的内容（YAGNI）

| 明确排除 | 理由 |
|---------|------|
| **Public/Private 配置分层** | 目前无使用场景。当 UI 适配器需要向浏览器暴露配置时再加 `publicConfigSchema` |
| **静态层配置热重载** | Nuxt、NestJS、Strapi、Phoenix 都不做。静态配置重启即可 |
| **配置文件叠加** | 不做 `config.dev.ts` / `config.prod.ts`。用 `$env.*` 处理环境差异。一个文件，环境变量区分 |
| **远程配置拉取** | 不做 Consul、etcd、AWS AppConfig。超出范围。未来可作为 Capability 实现 |
| **作用域间配置继承** | 作用域级联是扁平优先级列表，不是继承。不做"部分覆盖 + 合并" |

## 11. 与其他 spec 的关系

| Spec | 关系 |
|------|------|
| **00_tech_stack** | 原列 `c12 (UnJS)` 作为配置管理方案。本 spec 以自研 `ConfigRegistry` + Zod 替代 c12，因为 c12 不支持 Capability 级 schema 声明和作用域级联。spec 00 应更新 |
| **19_initialization** | 原展示的 `linchkit.config.ts` 结构已过时（使用 `process.env` 而非 `$env.*`，无 `capabilities` 数组）。以本 spec 和当前代码库为准。spec 19 应更新 |
| **41_data_security_and_masking** | 加密密钥配置在系统级 `system:security`；脱敏行为配置在 `cap-data-security` capability 级。两层分明 |

## 12. 实现说明

### 12.1 系统配置 schema 覆盖范围

M0a 先定义以下系统 schema：`server`、`database`、`queue`、`security`。

`ai`、`flow`、`github` 等配置区段暂不纳入 ConfigRegistry，后续按需逐步纳入。

### 12.2 zod 依赖

`configSchema` 字段引入 `zod` 作为 `@linchkit/core` types 层的依赖。由于 core 引擎层已使用 zod（`schema-to-zod.ts`），这是合理的。

## 13. 里程碑

### M0a（本里程碑）

- `@linchkit/core` 中的 `defineConfigSchema` 辅助函数
- `ConfigRegistry` 类：`create()`、`get()`、`has()`、`keys()`
- 系统配置 Zod schema（`server`、`database`、`queue`、`security`）
- `CapabilityDefinition` 扩展 `configSchema` + `config` 字段
- `ActionContext.config` 和 `TransportContext.config` 连接到 `ConfigRegistry`
- `dev.ts` 重构使用 `ConfigRegistry.create()`
- 启动校验 + 错误收集报告
- 现有 Capability 迁移：`cap-auth`、`cap-permission`、`cap-adapter-server`

### M1

- `_linchkit.config` 系统表 + `DynamicConfigProvider`
- `defineConfigSchema` 的 `storage: 'dynamic'` 支持
- 作用域级联解析（全局 → 租户）
- 配置模型支持（`SchemaDefinition` 上的 `purpose: 'config'`）
- 动态配置加密 + 脱敏集成（spec 41）
- cap-adapter-ui-react 中的管理员设置 UI

### M2+

- 部门 + 用户作用域级联
- 配置变更审计日志
- 从 Zod schema 自动生成配置文档
- 面向 UI 适配器的 Public 配置暴露
- 配置对比工具（比较两个环境）
