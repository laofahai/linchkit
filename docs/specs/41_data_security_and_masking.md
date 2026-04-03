# 数据安全与脱敏设计规范

## 1. 概述

LinchKit 处理的业务数据中不可避免地包含敏感信息（手机号、身份证、银行卡、薪资等）。本规范定义三层防护：

1. **存储层加密**（Encryption at Rest）— 敏感字段在数据库中加密存储，即使数据库被拖库也无法直接读取
2. **查询层脱敏**（Query-time Masking）— 根据 Actor 权限组动态决定返回明文、部分遮盖还是完全隐藏
3. **传输层保护**（Transport Security）— HTTPS + 审计日志中的敏感数据处理

核心原则：

- **完全可插拔**：数据安全作为 Capability（`cap-data-security`）实现，不装则无影响。Core 只定义类型和 slot，不含加解密/脱敏实现
- **应用层优先**：加密和脱敏在应用层实现，不依赖特定数据库的原生功能，保证跨 RDS 兼容
- **声明式**：开发者在 Schema 上声明 `encrypted` / `masking`，Capability 自动处理
- **与权限联动**：脱敏规则复用现有的权限组（Permission Group）体系，不引入独立的脱敏角色模型
- **零信任读取**：默认脱敏，明文访问需要显式授权
- **渐进式安装**：支持先跑业务再装安全——已有明文数据可通过迁移工具渐进加密

## 2. 架构：Core 声明 + Capability 实现

### 2.1 职责分离

采用与 cap-auth / cap-permission 一致的模式：**Core 定义接口和 slot，Capability 提供实现**。

| 层 | 包 | 职责 |
|---|-----|------|
| 类型声明 | `@linchkit/core` | `FieldSecurityOptions`、`MaskingConfig`、`MaskingPolicy`、`MaskingFormat` 类型定义；`EncryptionProvider` / `MaskingEngine` 接口；Command Layer `masking` slot 定义 |
| 实现 | `@linchkit/cap-data-security` | `MaskingEngine` 实现；`EncryptionProvider` 实现（AES-256-GCM）；`KeyProvider` 实现（env / KMS）；masking slot 中间件；CLI 迁移命令；"申请查看明文"管理 Action |

### 2.2 Command Layer 新增 masking slot

现有 7 slot：`pre → auth → exposure → permission → tenant → pre-action → post-action`

新增 **`masking`** slot，位于数据响应路径：

```
查询响应路径：数据获取 → permission 过滤 → [masking slot] → 返回
```

cap-data-security 安装时注册中间件到此 slot。

### 2.3 降级行为（不安装 cap-data-security）

| 功能 | 不装时的行为 |
|------|------------|
| `masking` 声明 | 被忽略，所有字段返回明文 |
| `encrypted` 声明 | 被忽略，明文存储 |
| `sensitive` / `secret` | 被忽略（27_ai_security 的 AI 脱敏也依赖此 Capability） |
| `blindIndex` | 被忽略，不生成 HMAC 索引列 |
| masking slot | 为空，跳过 |
| 审计日志 | 记录原始值（无脱敏） |

> **注意**：Schema 上的 `encrypted` / `masking` 声明始终合法（Core 定义了类型），只是没有 Capability 时不产生任何运行时效果。这与 cap-permission 一致——不装 cap-permission 时 Permission Group 定义仍合法，只是不做权限检查。

### 2.4 数据访问层钩子

Core 的数据访问层（InMemoryStore / 未来的 Drizzle adapter）在 `create`、`update`、`get`、`query` 方法中预留加密钩子：

```typescript
// Core data access layer (pseudocode)
async create(schema, data) {
  const processed = this.encryptionProvider
    ? await this.encryptionProvider.encryptRecord(schema, data)
    : data
  return this.store.insert(processed)
}

async get(schema, id) {
  const raw = await this.store.findById(id)
  return this.encryptionProvider
    ? await this.encryptionProvider.decryptRecord(schema, raw)
    : raw
}
```

没有 `encryptionProvider`（没装 cap-data-security）→ 直接透传，零开销。

## 3. Schema 声明

### 3.1 字段安全标记

在 `FieldDefinition` 上扩展三个安全相关属性：

```typescript
interface FieldSecurityOptions {
  /**
   * Encrypt value before storing to database.
   * Decrypted only in application layer with proper key.
   * Supported field types: string, text.
   */
  encrypted?: boolean

  /**
   * Mark field as sensitive for AI queries.
   * Already defined in 27_ai_security — kept for backward compatibility.
   * Superseded by masking.rules for fine-grained control.
   */
  sensitive?: boolean

  /**
   * Mark field as completely hidden from AI.
   * Already defined in 27_ai_security.
   */
  secret?: boolean

  /**
   * Dynamic masking configuration.
   * Controls how field value is presented to different actors.
   */
  masking?: MaskingConfig
}
```

### 3.2 MaskingConfig

```typescript
interface MaskingConfig {
  /**
   * Default masking policy when no rule matches.
   * Defaults to 'partial' for sensitive fields, 'plain' for others.
   */
  default: MaskingPolicy

  /**
   * Masking format hint — tells the masker what kind of data this is.
   * If omitted, inferred from field name heuristics (phone, email, etc.).
   */
  format?: MaskingFormat

  /**
   * Per-group override rules. Evaluated in order, first match wins.
   */
  rules?: MaskingRule[]
}

interface MaskingRule {
  /** Permission groups this rule applies to. */
  groups: string[]
  /** Masking policy for matched groups. */
  policy: MaskingPolicy
}
```

### 3.3 MaskingPolicy

```typescript
type MaskingPolicy =
  | 'plain'      // Return original value
  | 'partial'    // Partially masked (keep first/last chars based on format)
  | 'hashed'     // Return deterministic hash (comparable but irreversible)
  | 'hidden'     // Field omitted from response entirely
  | 'redacted'   // Return placeholder string '[REDACTED]'
```

### 3.4 MaskingFormat

```typescript
type MaskingFormat =
  | 'phone'      // 138****1234
  | 'email'      // z***@example.com
  | 'id_card'    // **************1234
  | 'bank_card'  // **** **** **** 5678
  | 'name'       // 张*
  | 'address'    // 北京市朝阳区***
  | 'generic'    // First 1/4 + **** + last 1/4
```

### 3.5 完整示例

```typescript
defineEntity({
  name: 'customer',
  fields: {
    name: {
      type: 'string',
      masking: {
        default: 'partial',
        format: 'name',
        rules: [
          { groups: ['system_admin', 'crm_manager'], policy: 'plain' },
        ],
      },
    },
    phone: {
      type: 'string',
      masking: {
        default: 'partial',
        format: 'phone',
        rules: [
          { groups: ['system_admin'], policy: 'plain' },
          { groups: ['customer_service'], policy: 'partial' },
          { groups: ['ai_agent'], policy: 'hidden' },
        ],
      },
    },
    id_number: {
      type: 'string',
      encrypted: true,                // Encrypted in DB
      masking: {
        default: 'hidden',            // Hidden by default
        format: 'id_card',
        rules: [
          { groups: ['system_admin'], policy: 'plain' },
          { groups: ['compliance_officer'], policy: 'partial' },
        ],
      },
    },
    email: { type: 'string' },        // No masking — public field
  },
})
```

## 4. 存储层加密

### 4.1 加密方案

采用 **AES-256-GCM** 对称加密，应用层加解密：

```
写入：plaintext → AES-256-GCM(key, iv) → base64(iv + ciphertext + authTag) → 存入 DB
读取：DB → base64 decode → extract(iv, ciphertext, authTag) → AES-256-GCM decrypt → plaintext
```

- **IV（Initialization Vector）**：每次加密随机生成 12 字节，与密文一起存储
- **Auth Tag**：GCM 模式自带 16 字节认证标签，防篡改
- **密文格式**：`base64(iv[12] + ciphertext[N] + authTag[16])`

### 4.2 密钥管理

```typescript
// linchkit.config.ts
export default defineConfig({
  security: {
    encryption: {
      /**
       * Key provider. Determines where encryption keys come from.
       * - 'env': Read from environment variable (default, dev/small deploy)
       * - 'kms': Use cloud KMS (AWS KMS / AliCloud KMS)
       * - Custom: Implement KeyProvider interface
       */
      keyProvider: 'env',

      /**
       * For 'env' provider: environment variable name containing the key.
       * Key must be 32 bytes, hex-encoded (64 chars).
       */
      keyEnvVar: 'LINCHKIT_ENCRYPTION_KEY',  // default

      /**
       * Key version for rotation support.
       * Old versions kept for decryption, new writes use latest.
       */
      keyVersion: 1,
    },
  },
})
```

#### KeyProvider 接口

```typescript
interface KeyProvider {
  /** Get the current encryption key for new writes. */
  getCurrentKey(): Promise<{ key: Buffer; version: number }>

  /** Get a key by version for decrypting old data. */
  getKeyByVersion(version: number): Promise<Buffer>

  /** Rotate to a new key. Returns new version. */
  rotateKey?(): Promise<number>
}
```

### 4.3 密钥轮换（Key Rotation）

密文前缀存储 key version，解密时按 version 查找对应密钥：

```
存储格式：v{version}:{base64_ciphertext}
示例：    v1:SGVsbG8gV29ybGQ=...
```

轮换流程：
1. 生成新密钥，version +1
2. 新写入使用新密钥
3. 后台任务逐步重新加密旧数据（可选，lazy re-encryption 也可）
4. 所有数据迁移完成后，删除旧密钥

### 4.4 schema-to-drizzle 集成

`encrypted: true` 的字段在 Drizzle schema 中映射为 `text` 列（存储 base64 密文），读写时通过 wrapper 自动加解密：

```typescript
// Pseudocode — schema-to-drizzle generates this
const customerTable = pgTable('customer', {
  // encrypted field → text column, app-layer encrypt/decrypt
  id_number: text('id_number'),  // stores: v1:base64(iv+ciphertext+tag)
})
```

加解密在 **数据访问层**（InMemoryStore / Drizzle adapter）的 `create`、`update`、`get`、`query` 方法中透明处理。开发者在 Action handler 中操作的始终是明文。

### 4.5 加密字段的查询限制

加密字段**不支持**数据库层的条件查询（WHERE、ORDER BY、LIKE）。原因：密文无法比较。

如需对加密字段做等值查询，使用 **blind index** 模式：
- 额外存储 `HMAC-SHA256(key, plaintext)` 作为索引列
- 查询时对搜索值做同样的 HMAC，匹配索引列
- 支持精确匹配（eq），不支持范围、模糊查询

```typescript
defineEntity({
  name: 'customer',
  fields: {
    id_number: {
      type: 'string',
      encrypted: true,
      blindIndex: true,  // Generate HMAC index for exact-match queries
    },
  },
})
```

## 5. 查询层脱敏

### 5.1 脱敏中间件位置

脱敏在 **数据返回前** 执行，位于 Command Layer 的数据访问链路中：

```
请求 → auth → permission → 数据查询 → [脱敏中间件] → 响应
                                         ↑
                              读取 Actor.groups + 字段 masking 配置
                              逐字段应用脱敏策略
```

具体位置：
- **REST / GraphQL 响应层**：在 resolver / route handler 返回数据前，对结果集应用脱敏
- **Action handler 内部**：Action handler 中通过 `ctx.get()` / `ctx.query()` 获取的数据**不脱敏**（Action 需要明文做业务判断）
- **API 响应**：经过 API 层返回给前端/外部的数据**必须脱敏**

### 5.2 脱敏引擎

```typescript
interface MaskingEngine {
  /**
   * Apply masking to a record based on actor's groups and schema config.
   *
   * @param record - Raw data record
   * @param schema - Schema definition (contains field masking configs)
   * @param actor - Current actor (provides groups for rule matching)
   * @returns Masked record (same shape, sensitive values replaced)
   */
  applyMasking(
    record: Record<string, unknown>,
    schema: EntityDefinition,
    actor: Actor,
  ): Record<string, unknown>

  /**
   * Resolve the effective masking policy for a field given an actor.
   */
  resolvePolicy(
    field: FieldDefinition,
    actor: Actor,
  ): MaskingPolicy
}
```

### 5.3 策略解析逻辑

```
resolvePolicy(field, actor):
  1. 如果字段没有 masking 配置 → 'plain'（不脱敏）
  2. 遍历 masking.rules（有序）：
     - 如果 actor.groups 与 rule.groups 有交集 → 返回 rule.policy
  3. 没有匹配的 rule → 返回 masking.default
```

**system_admin 特殊处理**：`system_admin` 权限组默认获得 `'plain'` 策略，除非 masking.rules 中显式为 `system_admin` 设置了其他策略。

### 5.4 内置脱敏函数

```typescript
const maskers: Record<MaskingFormat, (value: string) => string> = {
  phone:     (v) => v.replace(/^(.{3}).*(.{4})$/, '$1****$2'),       // 138****1234
  email:     (v) => v.replace(/^(.).+(@.+)$/, '$1***$2'),            // z***@example.com
  id_card:   (v) => v.replace(/.(?=.{4})/g, '*'),                    // **************1234
  bank_card: (v) => v.replace(/.(?=.{4})/g, '*').replace(/(.{4})/g, '$1 ').trim(),
  name:      (v) => v[0] + '*'.repeat(v.length - 1),                 // 张*
  address:   (v) => v.slice(0, Math.ceil(v.length / 3)) + '***',     // 北京市朝阳区***
  generic:   (v) => {
    const quarter = Math.max(1, Math.floor(v.length / 4))
    return v.slice(0, quarter) + '****' + v.slice(-quarter)
  },
}
```

### 5.5 format 自动推断

当 `masking.format` 未指定时，根据字段名启发式推断：

| 字段名包含 | 推断 format |
|-----------|-------------|
| `phone`, `mobile`, `tel` | `phone` |
| `email`, `mail` | `email` |
| `id_card`, `id_number`, `identity` | `id_card` |
| `bank_card`, `card_number`, `account_number` | `bank_card` |
| `name` (且 type 为 string，长度 < 20) | `name` |
| `address`, `addr` | `address` |
| 其他 | `generic` |

## 6. 与现有机制的关系

### 6.1 与 sensitive / secret 的关系（27_ai_security）

现有的 `sensitive` 和 `secret` 标记是 AI 场景的简化版脱敏。关系：

| 现有标记 | 等价的 masking 配置 |
|----------|-------------------|
| `sensitive: true` | `masking: { default: 'plain', rules: [{ groups: ['ai_agent'], policy: 'partial' }] }` |
| `secret: true` | `masking: { default: 'plain', rules: [{ groups: ['ai_agent'], policy: 'hidden' }] }` |

**兼容性**：`sensitive` / `secret` 继续支持，引擎内部自动转换为等价的 masking 配置。如果同时设置了 `masking` 和 `sensitive`/`secret`，以 `masking` 为准。

### 6.2 与 Permission 的关系（10_actor_permission）

脱敏和字段级权限（M2）是互补的：

| 机制 | 控制的是 | 效果 |
|------|---------|------|
| 字段级权限（`read.fields`） | 能不能看到这个字段 | 字段从响应中移除 |
| 脱敏（`masking`） | 看到的值是什么样的 | 字段存在但值被遮盖 |

评估顺序：字段级权限 → 脱敏。如果权限检查已经移除了字段，不再走脱敏逻辑。

### 6.3 与 Exposure 的关系（03_schema）

`fieldExposure` 控制字段在 GraphQL / MCP 接口上的可见性。脱敏在 exposure 过滤之后执行：

```
字段集合 → fieldExposure 过滤 → 字段级权限过滤 → 脱敏 → 返回
```

### 6.4 与审计日志的关系（11_execution_log）

Execution Log 记录 Action 的输入输出。对于包含敏感字段的日志：

- **输入参数**：记录脱敏后的值（使用 `masking.default` 策略，不考虑 Actor）
- **输出结果**：记录脱敏后的值
- **审计查询**：`system_admin` 查看日志时看到的也是脱敏后的值

> 审计日志的目的是记录"谁做了什么"，不需要保留原始敏感值。如需回溯原始值，查数据库（需解密权限）。

## 7. RDS 兼容性

### 7.1 设计决策：应用层加密

不依赖数据库原生加密功能，原因：

| 方案 | 优势 | 劣势 |
|------|------|------|
| 数据库 TDE | 对应用透明 | DBA 仍可读明文；仅防磁盘被盗场景 |
| 数据库列级加密 | 性能好 | 语法各异（pgcrypto vs AES_ENCRYPT）；密钥暴露给 DB |
| **应用层加密** | 跨 DB 兼容；密钥不出应用 | 加密字段不可查询（需 blind index） |

LinchKit 选择**应用层加密**，配合**可选的 TDE**（推荐在生产环境开启，作为纵深防御）。

### 7.2 各 RDS 兼容情况

| RDS | 应用层加密 | TDE（推荐开启） | Blind Index |
|-----|-----------|----------------|-------------|
| PostgreSQL (self-hosted) | ✅ | PG16+ 原生 / pgcrypto | ✅ |
| AWS RDS PostgreSQL | ✅ | KMS + 存储加密 | ✅ |
| AliCloud RDS PostgreSQL | ✅ | TDE 一键开启 | ✅ |
| AWS RDS MySQL | ✅ | KMS + 存储加密 | ✅ |
| AliCloud RDS MySQL | ✅ | TDE 一键开启 | ✅ |
| SQLite (dev/test) | ✅ | N/A | ✅ |

### 7.3 KMS 集成

生产环境推荐使用云 KMS 管理加密密钥：

```typescript
// AWS KMS provider example
import { createKmsKeyProvider } from '@linchkit/security'

export default defineConfig({
  security: {
    encryption: {
      keyProvider: createKmsKeyProvider({
        region: 'ap-southeast-1',
        keyId: 'arn:aws:kms:ap-southeast-1:123456:key/xxx',
      }),
    },
  },
})
```

KMS 的优势：
- 密钥不出 KMS，应用只持有 Data Encryption Key（DEK），DEK 由 KMS 的 Key Encryption Key（KEK）保护
- 自动轮换
- 审计密钥使用记录

## 8. 前端集成

### 8.1 脱敏标记

API 响应中，脱敏字段附带 `_masked` 元数据，前端可据此调整 UI：

```json
{
  "data": {
    "id": "cust_001",
    "name": "张*",
    "phone": "138****1234",
    "id_number": null
  },
  "_masked": {
    "name": "partial",
    "phone": "partial",
    "id_number": "hidden"
  }
}
```

### 8.2 前端 Widget 行为

| 脱敏策略 | 显示模式 | 编辑模式 |
|---------|---------|---------|
| `plain` | 明文显示 | 正常编辑 |
| `partial` | 显示遮盖值 | 输入框清空，placeholder 提示"重新输入以修改" |
| `hashed` | 显示 hash | 输入框清空，同上 |
| `hidden` | 字段不渲染 | 字段不渲染 |
| `redacted` | 显示 `[REDACTED]` | 不可编辑 |

### 8.3 "申请查看明文" 流程（可选）

高安全场景下，用户可申请临时查看明文：

```
用户点击"查看原文" → 创建 Action: request_unmask → 审批流 → 授权后返回明文（限时）
```

此功能通过 Capability 扩展实现（如 `cap-data-security`），不是框架核心。

## 9. 配置汇总

配置由 cap-data-security Capability 提供，通过 `createCapDataSecurity()` 工厂函数传入：

```typescript
// capability setup (e.g. in linchkit.config.ts capabilities array)
import { createCapDataSecurity } from '@linchkit/cap-data-security'

createCapDataSecurity({
  encryption: {
    keyProvider: 'env',                      // 'env' | 'kms' | KeyProvider
    keyEnvVar: 'LINCHKIT_ENCRYPTION_KEY',    // For 'env' provider
    keyVersion: 1,
  },

  masking: {
    /**
     * Enable query-time masking globally.
     * Default: true in production, false in development.
     */
    enabled: true,

    /**
     * Default policy for fields with masking config but no matching rule.
     * Can be overridden per-field.
     */
    defaultPolicy: 'partial',

    /**
     * Groups that always receive plain text (bypass masking).
     * Default: ['system_admin'].
     */
    bypassGroups: ['system_admin'],

    /**
     * Whether to include _masked metadata in API responses.
     * Default: true.
     */
    includeMaskedMeta: true,
  },
})
```

不安装 cap-data-security 时，不需要任何配置。Schema 上的 `encrypted` / `masking` 声明仍然合法，只是不产生运行时效果。

## 10. 迁移策略

cap-data-security 支持**随时安装**——系统可以先跑业务，后期再加数据安全能力。

### 10.1 安装后：已有明文数据的处理

#### 加密字段的兼容读取

密文有固定前缀 `v{n}:`，明文没有。读取时自动识别：

```typescript
function readEncryptedField(raw: string, provider: EncryptionProvider): string {
  // Has version prefix → encrypted, decrypt it
  if (/^v\d+:/.test(raw)) {
    return provider.decrypt(raw)
  }
  // No prefix → legacy plaintext, return as-is
  return raw
}
```

装上 cap-data-security 后，**旧明文数据照常读取，不会报错**。

#### Lazy Migration（写时自动加密）

新的 `create` / `update` 操作走加密路径。旧数据被 update 时自动变为密文：

```
旧记录（明文）→ 用户编辑 → update → 写入加密值
```

无需任何手动操作，日常使用中数据自然地从明文过渡到密文。

#### 批量迁移（CLI 命令）

对于长期不被触碰的旧数据，提供 CLI 主动迁移：

```bash
# Encrypt all plaintext values in customer.id_number
bunx linchkit migrate:encrypt --schema customer --field id_number

# Encrypt all encrypted-marked fields across all schemas
bunx linchkit migrate:encrypt --all

# Dry run — show what would be encrypted, don't modify
bunx linchkit migrate:encrypt --all --dry-run
```

迁移行为：
1. 扫描目标字段所有不带 `v{n}:` 前缀的行（即明文）
2. 逐批加密 + 更新（默认 batch size 500，带事务）
3. 支持中断后恢复（记录最后处理的 ID）
4. 输出进度报告（总数 / 已处理 / 跳过 / 错误）

### 10.2 脱敏：无迁移问题

脱敏是查询时实时计算的，不涉及存储变更。**装上即生效**，无历史数据问题。

### 10.3 卸载 cap-data-security

⚠️ **卸载前必须先解密已加密数据**，否则密文会原样返回给用户（乱码）。

```bash
# Step 1: Decrypt all encrypted fields back to plaintext
bunx linchkit migrate:decrypt --all

# Step 2: Verify no encrypted values remain
bunx linchkit migrate:verify --expect plaintext

# Step 3: Now safe to uninstall
bun remove @linchkit/cap-data-security
```

CLI 在检测到 `encrypted: true` 字段仍有密文数据时，会**拒绝卸载并提示先运行 `migrate:decrypt`**。

### 10.4 场景矩阵

| 场景 | 读取 | 写入 | 需要迁移？ |
|------|------|------|-----------|
| 全新安装 cap-data-security | 正常 | 自动加密 | 否 |
| 运行一段时间后安装 | 自动识别明文/密文 | 新写入自动加密 | 推荐（`migrate:encrypt`） |
| 密钥轮换 | 按 version 找旧密钥解密 | 用新密钥加密 | 可选（批量重加密） |
| 卸载 cap-data-security | 密文原样返回（⚠️ 乱码） | 明文存储 | **必须**（先 `migrate:decrypt`） |

### 10.5 Blind Index 迁移

安装 cap-data-security 后，`blindIndex: true` 字段需要生成 HMAC 索引。CLI 同样支持：

```bash
# Generate blind index for existing data
bunx linchkit migrate:blind-index --schema customer --field id_number
```

## 11. 与里程碑的关系

### M0
- Schema 字段 `sensitive` / `secret` 标记（已完成）
- AI 查询时的脱敏（已在 27_ai_security 定义）
- Core 中定义 `FieldSecurityOptions`、`MaskingConfig` 等类型（纯类型，无实现）

### M1
- **cap-data-security Capability 实现**
  - `MaskingEngine` 实现 + masking slot 中间件
  - REST / GraphQL 响应自动脱敏
  - 前端 `_masked` 元数据 + Widget 适配
  - `sensitive` / `secret` 自动转换为 masking 配置

### M2
- **加密能力**
  - `EncryptionProvider` 实现（AES-256-GCM）
  - `KeyProvider` 实现（env / KMS）
  - `blindIndex` 支持加密字段等值查询
  - 密钥轮换机制
- **迁移工具**
  - `migrate:encrypt` / `migrate:decrypt` / `migrate:blind-index` CLI 命令
  - Lazy migration 支持
- **高级功能**
  - 审计日志敏感数据脱敏
  - "申请查看明文"流程
