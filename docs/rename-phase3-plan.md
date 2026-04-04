# Phase 3 Rename Plan: `.schema` → `.entity` + Link → Relation 属性名

> Status: **进行中** | Date: 2026-04-03  
> Branch: feat/m2

## 已完成 ✅

### Phase 1-2（之前的 commit 已合入）
- 类型名: SchemaDefinition→EntityDefinition, LinkDefinition→RelationDefinition
- 注册表: SchemaRegistry→EntityRegistry, LinkRegistry→RelationRegistry  
- 函数名: defineSchema→defineEntity, defineLink→defineRelation
- 文件名: 所有 *schema* → *entity*, *link* → *relation*
- CapabilityDefinition 属性: .schemas→.entities, .links→.relations

### Phase 3（本次会话已完成）
- ✅ Core 类型定义（`packages/core/src/types/*.ts`）— 全部属性改完
- ✅ MCP adapter 工具名 list_schemas→list_entities, get_schema→get_entity
- ✅ MCP adapter 所有源码和测试（161 tests pass）
- ✅ Spec 文档中的 MCP 工具名（spec 15, 43, 50, 51, 58）
- ✅ CLAUDE.md 中的 MCP 工具描述
- ✅ RelationDescriptor: linkName→relationName, targetSchema→targetEntity
- ✅ LinkInfo: relatedSchema→relatedEntity, .link→.relation
- ✅ RelationRegistry: linkBetween→relationBetween
- ✅ 测试修复: info.test.ts, e2e-flow-trigger.test.ts, semantic-inference.test.ts

## 剩余工作 🔧

### TypeCheck 错误（121 个，22 个文件）

**错误分布:**
- `Property 'entity' does not exist` (73) — 某些类型消费者还在用 `.schema`，但 sed 意外改坏了其他地方
- `Property 'linkName' does not exist` (7) — 需要改成 `.relationName`
- `Property 'targetSchema' does not exist` (5) — 需要改成 `.targetEntity`
- `Property 'schema' does not exist` (1) — 遗漏

**需要修复的文件（按优先级分组）：**

#### Group 1: Core 引擎（最关键）
```
packages/core/src/engine/action-engine.ts        — .schema→.entity 属性访问
packages/core/src/engine/action-registry.ts       — .schema→.entity
packages/core/src/engine/approval-engine.ts       — .schema→.entity
packages/core/src/engine/validation-engine.ts     — .schema→.entity
packages/core/src/entity/aggregate-engine.ts      — .schema→.entity
packages/core/src/entity/derived-registry.ts      — .schema→.entity
packages/core/src/observability/execution-logger.ts — .schema→.entity, getBySchema→getByEntity
packages/core/src/persistence/drizzle-approval-store.ts — .schema→.entity
packages/core/src/persistence/drizzle-execution-logger.ts — .schema→.entity
packages/core/src/life-system/usage-graph.ts      — .schema→.entity
```

#### Group 2: Ontology + AI（核心分析层）
```
packages/core/src/ontology/ontology-registry.ts   — 混合问题，部分改完部分未改
packages/core/src/ontology/semantic-inference.ts   — .schema→.entity in SemanticRelationEndpoint
packages/core/src/ai/pattern-detector.ts          — targetSchema→targetEntity
```

#### Group 3: Addons（适配层）
```
addons/adapter-server/cap-adapter-server/src/ai/system-prompt.ts — .linkName→.relationName
addons/adapter-server/cap-adapter-server/src/ai/tools.ts         — .targetSchema→.targetEntity
addons/adapter-server/cap-adapter-server/src/proposal-api.ts     — .schema→.entity on PatternInsight
addons/adapter-server/cap-adapter-server/src/routes/config-api.ts — .schema→.entity
addons/adapter-server/cap-adapter-server/src/subscription-manager.ts — .schema→.entity
addons/adapter-ui/cap-adapter-ui/src/pages/entity-list.tsx       — 变量名被sed改坏需恢复
```

#### Group 4: DevTools（文档生成）
```
packages/devtools/src/documentation/capability-doc-generator.ts — .linkName→.relationName
packages/devtools/src/documentation/doc-search.ts               — .linkName→.relationName
packages/devtools/src/documentation/markdown-renderer.ts        — 变量名被sed改坏需恢复
```

### 测试失败（168 个）

大部分测试失败是因为上面的 typecheck 错误导致模块加载失败，修完 typecheck 后大部分会自动恢复。

少量测试可能因为对象字面量里还用 `schema:` 而需要改成 `entity:`。

### 潜在的 sed 损坏

以下文件被 sed 过度修改（改了变量名但没改函数体引用），需要先 `git checkout` 恢复再手工改：
- `addons/adapter-ui/cap-adapter-ui/src/pages/entity-list.tsx`
- `packages/devtools/src/documentation/markdown-renderer.ts`

恢复命令:
```bash
git checkout -- addons/adapter-ui/cap-adapter-ui/src/pages/entity-list.tsx
git checkout -- packages/devtools/src/documentation/markdown-renderer.ts
```

## 修复策略

### 推荐方式：typecheck 驱动迭代

```bash
# 1. 先恢复被 sed 改坏的文件
git checkout -- <files>

# 2. 获取错误列表
bun run typecheck 2>&1 | grep "error TS"

# 3. 逐文件修复（属性访问 + 变量名 + 参数名一起改）

# 4. 每改几个文件验证一次
bun run typecheck 2>&1 | grep "error TS" | wc -l

# 5. 全部 0 error 后跑测试
bun test

# 6. 修复测试中的对象字面量 schema: → entity:
# 7. 最后 lint
bun run check
```

### 安全替换规则

**必须改:**
- `.schema` 属性访问 → `.entity`（当指 LinchKit entity 时）
- `schema:` 对象字面量键 → `entity:`
- `schema` 参数名/变量名 → `entity`（当持有 entity name 或 EntityDefinition 时）
- `targetSchema` → `targetEntity`
- `relatedSchema` → `relatedEntity`
- `linkName` → `relationName`
- `getBySchema` → `getByEntity`

**绝对不能改:**
- `fieldsToJsonSchema`, `buildGraphQLSchema`, `inputSchema`, `outputSchema`
- `zodSchema`, `z.schema`, Zod/JSON Schema 相关
- `drizzle-schema`, `_linchkit` PostgreSQL schema namespace
- `responseFormat.schema`（AI/Flow 的 Zod schema 引用）
- `"schema"` 作为 enum 值（UsageNodeKind, ProposalChangeTarget）
- `"schema.changed"` 事件类型字符串
- 数据库列名 `schema_name`（运行时 SQL 兼容）

## 验证标准

```bash
bun run typecheck   # 0 error
bun test            # 0 fail (1 skip OK: Volcengine)
bun run check       # 0 lint error
```
