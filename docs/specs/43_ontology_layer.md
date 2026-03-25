# Ontology Layer — 统一语义模型

> Status: Implemented (core) | Date: 2026-03-23
> 灵感来源: Palantir Foundry Ontology
> 里程碑: M2
> **Implementation status (2026-03-25):** Core OntologyRegistry implemented with describe(), listSchemas(), searchSchemas(), actionsFor(), rulesFor(), stateFor(), viewsFor(), flowsFor(), handlersFor(), relatedSchemas(), toJSON(). MCP tools (describe_schema, ontology_overview, search_ontology) integrated.

## 1. 问题

LinchKit 拥有完整的元模型元素（Schema、Action、Rule、State、Event、EventHandler、View、Flow），但它们作为独立的 Registry 各自存在。缺少一个统一概念将它们绑定成业务领域的完整「数字孪生」。

后果：
- AI 代理必须分别查询多个 Registry 才能理解系统
- 没有单一 API 可以发现「关于 purchase_request 的一切」
- 没有统一元数据层用于内省、文档生成或影响分析
- MCP 工具暴露的是零散片段，而非全貌

## 2. 方案：Ontology 作为统一语义层

引入 `Ontology` 作为顶层容器，聚合所有元模型元素，提供统一的发现、内省和查询 API。

**Ontology 不是新的抽象** — 它是现有 Registry 的联合体，通过单一连贯的接口访问。

```
Ontology
  ├── Object Types（Schema 定义）
  │     ├── Fields（属性字段）
  │     ├── Relations（与其他 Schema 的关联）
  │     └── System Fields（id, tenant_id, timestamps, _version）
  ├── Actions（写操作）
  │     ├── Parameters（参数）
  │     ├── Pre-conditions（Rules execute_action 前置联动）
  │     └── Side Effects（EventHandlers 副作用）
  ├── Rules（业务约束）
  ├── States（每个 Schema 的状态机）
  ├── Events（领域事件定义）
  ├── EventHandlers（事件反应）
  ├── Views（UI 配置）
  ├── Flows（多步骤工作流）
  └── Relations（Schema 间的语义关联 — spec 24）
```

## 3. OntologyRegistry API

```typescript
interface OntologyRegistry {
  // === 发现 ===

  /** 获取关于某个 Schema 的一切：字段、Action、Rule、状态机、View、Flow、关联 */
  describe(schemaName: string): SchemaDescriptor              // ✅ Implemented

  /** 列出 Ontology 中所有 Schema 名称 */
  listSchemas(): string[]                                      // ✅ Implemented

  /** 按关键词搜索 Schema（名称、label、字段名） */
  searchSchemas(query: string): SchemaDescriptor[]             // ✅ Implemented

  // === 横切查询 ===

  /** 获取操作某个 Schema 的所有 Action */
  actionsFor(schemaName: string): ActionDefinition[]           // ✅ Implemented

  /** 获取影响某个 Schema 的所有 Rule */
  rulesFor(schemaName: string): RuleDefinition[]               // ✅ Implemented

  /** 获取某个 Schema 的状态机（如果有） */
  stateFor(schemaName: string): StateDefinition | null         // ✅ Implemented

  /** 获取为某个 Schema 定义的所有 View */
  viewsFor(schemaName: string): ViewDefinition[]               // ✅ Implemented

  /** 获取由某个 Schema 的 Action/Event 触发的所有 Flow */
  flowsFor(schemaName: string): FlowDefinition[]               // ✅ Implemented

  /** 获取监听某个 Schema 事件的所有 EventHandler */
  handlersFor(schemaName: string): EventHandlerDefinition[]    // ✅ Implemented

  /** 获取与某个 Schema 关联的 Schema（结构关联 + 语义关联） */
  relatedSchemas(schemaName: string): RelationDescriptor[]     // ✅ Implemented

  // === 影响分析 ===

  /** 如果修改了这个 Schema/字段，会影响什么？ */
  impactOf(target: { schema: string; field?: string }): ImpactReport  // ⚪ Planned for M3

  // === 序列化（用于 AI / MCP / 文档生成） ===

  /** 导出完整 Ontology 为 JSON（用于 AI 上下文注入） */
  toJSON(): OntologySnapshot                                   // ✅ Implemented

  /** 导出为 Mermaid 图 */
  toMermaid(): string                                          // ⚪ Planned for M3

  /** 导出为 Markdown（用于 CLAUDE.md 生成） */
  toMarkdown(): string                                         // ⚪ Planned for M3
}
```

## 4. SchemaDescriptor

`describe()` 方法返回某个 Schema 的完整画像：

```typescript
interface SchemaDescriptor {
  schema: SchemaDefinition
  fields: FieldDefinition[]
  relations: RelationInfo[]          // 结构关联（ref/has_many）+ 语义关联（spec 24）
  actions: ActionDefinition[]        // 操作此 Schema 的所有 Action
  rules: RuleDefinition[]            // 影响此 Schema 的所有 Rule
  state: StateDefinition | null      // 状态机（如果定义了）
  views: ViewDefinition[]            // 此 Schema 的所有 View
  flows: FlowDefinition[]            // 由此 Schema 的 Action 触发的 Flow
  handlers: EventHandlerDefinition[] // 监听此 Schema 事件的 EventHandler
  permissions: PermissionInfo[]      // 控制访问的权限组
}
```

## 5. 实现

### 5.1 OntologyRegistry 是只读聚合器

它组合现有 Registry，而非替代它们：

```typescript
function createOntologyRegistry(deps: {
  schemas: SchemaRegistry
  actions: ActionRegistry
  rules: RuleDefinition[]
  states: StateDefinition[]
  events: EventDefinition[]
  handlers: EventHandlerDefinition[]
  views: ViewDefinition[]
  flows: FlowRegistry
  relations: RelationGraph        // spec 24
  permissions: PermissionRegistry
}): OntologyRegistry
```

各个 Registry 仍然是数据源头。OntologyRegistry 是提供横切查询的 Facade。

### 5.2 生命周期

在 `RuntimeContext` 初始化期间构建一次，所有 Capability 注册完定义之后。构建后不可变（反映部署时的配置，不是运行时状态）。

### 5.3 缓存

`describe()` 结果按 Schema 名称缓存。仅在重启时失效（当前架构下定义不会在运行时变更）。

## 6. MCP 集成

OntologyRegistry 驱动增强版 MCP 工具，供 AI 代理使用：

```typescript
// MCP tool: describe_schema
// 输入: { schema: "purchase_request" }
// 输出: 完整 SchemaDescriptor（JSON）

// MCP tool: search_ontology
// 输入: { query: "approval" }
// 输出: 所有提到 "approval" 的 Schema、Action、Rule、Flow

// MCP tool: impact_analysis
// 输入: { schema: "purchase_request", field: "amount" }
// 输出: 修改此字段会影响的 Rule、Flow、Handler

// MCP tool: ontology_overview
// 输入: {}
// 输出: 所有 Schema 及其关联关系的高层摘要
```

替代当前分散的 MCP 工具（`list_schemas`、`get_rules`、`get_state_machine`），提供统一且更丰富的接口。

## 7. AI 上下文生成

### 7.1 自动生成系统上下文

启动时（或通过 CLI 命令），Ontology 可以导出完整的系统描述供 AI 上下文使用：

```typescript
const ontology = runtime.ontology
const markdown = ontology.toMarkdown()
// 写入 .linchkit/ontology.md — 可包含在 CLAUDE.md 或 MCP system prompt 中
```

### 7.2 Mermaid 图

```typescript
const mermaid = ontology.toMermaid()
// 生成关系图，用于文档
```

## 8. 影响分析

当 Proposal 修改某个 Schema 或字段时，Ontology 可以分析下游影响：

```typescript
const impact = ontology.impactOf({ schema: 'purchase_request', field: 'amount' })
// 返回:
// {
//   directlyAffected: [
//     { type: 'rule', name: 'budget_check', reason: 'condition 引用了 amount' },
//     { type: 'view', name: 'purchase_form', reason: '显示 amount 字段' },
//   ],
//   indirectlyAffected: [
//     { type: 'flow', name: 'purchase_approval', reason: '由 submit_request 触发' },
//     { type: 'schema', name: 'inventory_item', reason: '通过 bridge 关联' },
//   ],
// }
```

## 9. Ontology 不是什么

- **不是新的数据存储** — 它从现有 Registry 读取
- **不是各 Registry 的替代品** — 各 Registry 仍然是数据源头
- **不是 GraphQL schema** — GraphQL 是查询传输层；Ontology 是元数据聚合层
- **不是运行时状态** — 它描述系统的配置，不是当前数据

## 10. 与现有 Spec 的关系

| Spec | 关系 |
|------|------|
| 03_schema | Ontology 聚合 Schema 定义 |
| 04_action | Ontology 聚合 Action 定义 |
| 05_rule | Ontology 聚合 Rule 定义并交叉引用 |
| 06_state | Ontology 包含状态机 |
| 07_event | Ontology 包含事件定义 |
| 08_event_handler | Ontology 包含 EventHandler 注册 |
| 13_view_and_ui | Ontology 包含 View 配置 |
| 20_extension_mechanism | Capability 注册的定义填充 Ontology |
| 23_rule_engine_and_flow | Flow 定义包含在 Ontology 中 |
| 24_relation_graph | 语义关联驱动关系查询 |
| 36_ai_service | AI Service 使用 Ontology 获取上下文 |

## 11. 里程碑

### M2
- `OntologyRegistry` 接口 + `createOntologyRegistry()` 工厂 ✅
- `describe()`、`listSchemas()`、`actionsFor()`、`rulesFor()`、`stateFor()` ✅
- `viewsFor()`、`flowsFor()`、`handlersFor()`、`relatedSchemas()` ✅
- `searchSchemas()` keyword search ✅ (moved from M3, implemented 2026-03-25)
- `toJSON()` export for MCP context ✅
- Enhanced MCP tools based on Ontology (`describe_schema`, `ontology_overview`, `search_ontology`) ✅

### M3
- `impactOf()` impact analysis
- `toMarkdown()` + `toMermaid()` auto-generation
- CLI: `linch ontology describe <schema>`, `linch ontology diagram`
