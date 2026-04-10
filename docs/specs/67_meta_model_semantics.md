# Meta-Model 语义层

> 所有 defineXxx() 元素携带结构化语义元数据，使 AI 能理解、比较和推理整个系统。
>
> 相关规范：[55 — 进化系统](./55_evolution_system.md)（消费语义做冲突检测和影响分析）、[52 — AI 深度集成](./52_ai_deep_integration.md)（NL → defineXxx 生成）、[68 — 向量存储](./68_vector_store.md)（embedding 存储和相似度搜索）。
> 调研报告：[Rule Intelligence & Meta-Model Semantics Research](../research/rule-intelligence-findings.md)。
>
> Tracking milestones: `M5: Platform Maturity & AI Evolution`, `M6: AI Intelligence`
>
> Execution source of truth: GitHub milestones and issues.

## 1. 动机

LinchKit 的 AI 能力（进化系统、NL 生成、Chatter）都需要**理解系统结构的业务含义**。当前 defineXxx() 只有 `name`（命名约定）+ `description`（自由文本），存在三个问题：

1. **意图不可查询**——无法回答"系统里有哪些和财务控制相关的规则？"
2. **相似度不可计算**——无法判断两条 Rule 是否语义重复
3. **影响不可分级**——无法区分"改一个日志实体"和"改一个核心交易实体"的风险差异

这些不只是 Rule 的问题——**所有 defineXxx() 都是 AI 推理图谱上的节点**，任何一个节点语义缺失，推理链就会断裂。

## 2. 设计

### 2.1 两层语义接口

**Layer 1：所有 defineXxx() 共享的基础语义**

```typescript
interface MetaSemantics {
  intent?: string[]        // 业务意图分类：['financial_control', 'compliance', 'automation']
  domain?: string[]        // 业务领域：['procurement', 'hr', 'inventory']
  summary?: string         // 标准化自然语言摘要（AI 生成或人工填写）
  tags?: string[]          // 自由标签，用于搜索和分组
}
```

所有 defineEntity / defineAction / defineRule / defineState / defineEvent / defineEventHandler / defineView / defineFlow / defineRelation 的选项对象中新增可选字段 `semantics?: MetaSemantics`。

**Layer 2：类型特定扩展**

```typescript
// Entity — 业务对象分类
interface EntitySemantics extends MetaSemantics {
  category?: 'master_data' | 'transaction' | 'reference' | 'log' | 'config'
  sensitivity?: 'public' | 'internal' | 'confidential' | 'restricted'
}

// Action — 操作影响评估
interface ActionSemantics extends MetaSemantics {
  sideEffectLevel?: 'none' | 'local' | 'cross_entity' | 'external'
  reversible?: boolean
}

// Rule — 规则治理
interface RuleSemantics extends MetaSemantics {
  regulation?: string[]    // 合规关联：['SOX-404', 'GDPR-Art17']
  riskLevel?: 'low' | 'medium' | 'high' | 'critical'
}

// Flow — 流程映射
interface FlowSemantics extends MetaSemantics {
  businessProcess?: string   // 对应的业务流程名称
  sla?: string               // 时效要求：'24h', '3d'
}

// Relation — 关系业务含义
interface RelationSemantics extends MetaSemantics {
  businessMeaning?: string   // '供应商为采购单供货'
}

// State, Event, EventHandler, View 使用基础 MetaSemantics，无扩展字段
```

### 2.2 各类型语义需求分析

| defineXxx | 当前语义信息 | AI 可推断度 | 扩展必要性 |
|-----------|-------------|-----------|-----------|
| **Entity** | name + description + fields | 中 — 结构丰富，意图弱 | **高** — 一切的根节点 |
| **Action** | name (verb_noun) + description + I/O | 中 — 命名约定帮助大 | **高** — 写入口，影响分析核心 |
| **Rule** | name + description + condition + effect | 中 — condition 可机读，意图不可 | **高** — 冲突检测核心 |
| **Flow** | name + description + steps | 中 — 步骤结构化，业务映射缺 | **高** — 多步编排，影响面大 |
| **Relation** | fromName/toName + cardinality | 中 — 结构语义强，业务含义弱 | **中** |
| **State** | 状态名 + transitions | 中偏高 — 名字本身有语义 | **中** — 基础 MetaSemantics 足够 |
| **Event** | name (entity.past_tense) + payload | 中偏高 — 命名约定强 | **低** — 基础 MetaSemantics 足够 |
| **EventHandler** | name + event binding | 低 — 但可从 Event + Action 继承 | **低** — 衍生语义 |
| **View** | 字段配置 + sort/filter | 低 — UI 层 | **低** — 基础 MetaSemantics 足够 |

### 2.3 规则间语义关系

除了单个元素的语义，元素之间的**语义关系**也需要表达：

```typescript
type MetaModelRelationType =
  | 'subsumes'         // A 的条件包含 B（A 更宽泛）
  | 'conflicts_with'   // A 与 B 效果矛盾
  | 'complements'      // A 补充 B（联合激活）
  | 'overrides'        // A 在特定条件下覆盖 B

interface MetaModelSemanticRelation {
  from: MetaModelRef    // { type: 'rule', name: 'require_approval_over_10k' }
  to: MetaModelRef
  relation: MetaModelRelationType
  confidence: number    // 0-1, AI 推断的置信度
  source: 'explicit' | 'inferred'  // 人工声明 or AI 推断
}
```

这些关系存储在 OntologyRegistry 中，由 AI 在 Proposal 阶段自动发现和维护。开发者也可在 defineRule 中显式声明：

```typescript
defineRule({
  name: 'require_approval_over_10k',
  semantics: {
    intent: ['financial_control'],
    riskLevel: 'high',
    // 显式声明关系
    overrides: ['require_approval_over_5k'],
  },
  // ...
})
```

## 3. 语义自动生成

开发者**不需要**手动填写语义元数据。系统分三个时机自动生成：

### 3.1 注册时 — 结构推断（无需 AI）

确定性推断，零成本：

| 推断规则 | 输入 | 输出 |
|---------|------|------|
| 有 State Machine 定义 → transaction | Entity 注册信息 | `EntitySemantics.category` |
| 无写 Action → reference | Entity + Action 注册信息 | `EntitySemantics.category` |
| handler 调用外部 API → external | Action handler 静态分析 | `ActionSemantics.sideEffectLevel` |
| 存在补偿 Action → reversible | Action 注册信息 | `ActionSemantics.reversible` |
| condition 引用金额/价格字段 → financial | Rule condition | `RuleSemantics.intent` (候选) |

### 3.2 首次 AI 交互 — LLM 分类（缓存）

当 AI Provider 可用时，对每个注册的 defineXxx() 做一次性分类：

- **输入**：name + description + 结构摘要（字段列表、condition 等）
- **输出**：intent[], domain[], summary
- **缓存**：结果持久化到 OntologyRegistry，定义不变则不重新生成
- **准确率**：zero-shot 意图分类 ~85-90%（参考调研）

### 3.3 Proposal 时 — 按需深度分析（每次）

仅在 Proposal 创建时触发：

- **embedding 计算**：将定义向量化，用于语义相似度搜索（需要 VectorStore Capability）
- **关系抽取**：与现有定义比较，发现 subsumes/conflicts/complements 关系
- **降级**：无 VectorStore 时退化为结构化匹配（field + operator + value 比较）

### 3.4 优先级

人工声明 > AI 分类 > 结构推断 > 默认值

开发者在 defineXxx() 中显式写 `semantics: { ... }` 始终优先于自动生成。

## 4. OntologyRegistry 集成

OntologyRegistry 是语义元数据的存储和查询层。扩展现有 API：

```typescript
// 现有 API（不变）
registry.describe(entityName)            // 结构描述
registry.listEntities()                  // 所有实体
registry.actionsFor(entityName)          // 实体可用 Action
registry.relationsFor(entityName)        // 实体关联 Relation

// 新增：语义查询 API
registry.searchByIntent(intent: string)          // → 所有相关的 Entity/Action/Rule/Flow
registry.searchByDomain(domain: string)          // → 某业务领域的全部元素
registry.getSemanticsFor(ref: MetaModelRef)      // → 元素的完整语义元数据
registry.getSemanticRelations(ref: MetaModelRef) // → 元素的语义关系列表

// 新增：依赖图谱 API（服务于 Spec 55 §7.3 影响分析）
registry.dependencyGraph(ref: MetaModelRef)      // → 以该元素为根的依赖 DAG 子图
registry.impactAnalysis(ref: MetaModelRef)       // → BFS 可达集，按拓扑距离分层
```

### 4.1 依赖 DAG 自动构建

DAG 从 defineXxx() 声明中自动提取依赖关系，无需手动标注：

```
节点类型：Entity | Action | Rule | State | Event | EventHandler | Flow | Relation | View
边类型：  field_read | field_write | triggers | guards | handles | contains | references
```

提取规则：

| 来源 | 边类型 | 目标 |
|------|--------|------|
| Rule.condition.field | field_read | Entity.field |
| Rule.effect.action | triggers | Action |
| State.transitions[].guard | guards | Rule |
| EventHandler.event | handles | Event |
| EventHandler.handler (calls Action) | triggers | Action |
| Flow.steps[].action | contains | Action |
| Action.entity | references | Entity |
| Relation.from / .to | references | Entity |
| View.entity | references | Entity |

DAG 在所有 defineXxx() 注册完成后自动构建（startup phase），运行时 Overlay 变更后增量更新。

## 5. 与向量存储的协作

语义层本身**不依赖**向量存储。向量是可选的加速层：

| 能力 | 有 VectorStore (Spec 68) | 无 VectorStore |
|------|--------------------------|----------------|
| 语义查重 | embedding 余弦相似度 | name + condition 结构匹配 |
| 意图搜索 | 向量 KNN | 字符串匹配 intent 标签 |
| 关系发现 | embedding 空间聚类 | 显式声明 + 结构推断 |

## 6. 落地路径

| 阶段 | 内容 | 依赖 |
|------|------|------|
| **M5** | MetaSemantics 类型定义；注册时结构推断；OntologyRegistry 语义查询 API；依赖 DAG 自动构建；LLM 语义自动分类（需 cap-ai-provider）；语义关系抽取 | OntologyRegistry, cap-ai-provider |
| **M6** | embedding 计算（需 Spec 68）；Proposal 语义查重集成（Spec 55 §7.3）；跨 Entity 语义冲突检测；语义关系图谱可视化 UI | Spec 68 |
| **M6+** | 跨 Entity 语义冲突检测；语义关系图谱可视化 UI | M5 |
