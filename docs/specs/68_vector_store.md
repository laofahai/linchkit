# 向量存储与 RAG 基础设施

> 向量存储作为可选 Capability，为进化系统、AI 生成、Chatter 提供语义搜索能力。
>
> 相关规范：[55 — 进化系统](./55_evolution_system.md)（语义查重、模式匹配）、[67 — Meta-Model 语义层](./67_meta_model_semantics.md)（embedding 存储）、[52 — AI 深度集成](./52_ai_deep_integration.md)（NL → defineXxx 生成）、[53 — Chatter](./53_chatter_and_collaboration.md)（对话上下文检索）。
> 调研报告：[RAG Evolution Research](../research/rag-evolution-findings.md)、[Rule Intelligence Research](../research/rule-intelligence-findings.md) §6。
>
> Tracking milestone: `M5: Platform Maturity & AI Evolution`
>
> Execution source of truth: GitHub milestones and issues.

## 1. 定位

向量存储不是核心——是一个**可选的基础设施 Capability**。多个上层功能消费它：

| 消费者 | 用途 | 没有向量存储时 |
|--------|------|---------------|
| 进化系统 (Spec 55) | Rule 语义查重、模式相似度匹配 | 退化为结构化条件匹配 |
| Meta-Model 语义层 (Spec 67) | defineXxx() embedding 存储和相似度搜索 | 退化为标签字符串匹配 |
| AI 代码生成 (Spec 52) | Few-shot 示例检索（找最相似的现有定义） | 退化为随机/最近示例 |
| Chatter (Spec 53) | 业务数据 RAG、对话上下文检索 | 退化为关键词搜索 |

**核心原则：所有消费者必须在无向量存储时优雅降级。** 向量是加速层，不是必需层。

## 2. 架构

### 2.1 核心接口（定义在 core）

```typescript
/**
 * Abstract vector storage service interface.
 * Core defines the contract; capabilities provide implementations.
 */
interface VectorStoreService {
  /** Generate embedding for text using configured AI provider */
  embed(text: string): Promise<number[]>

  /** Insert or update a vector with metadata */
  upsert(id: string, vector: number[], metadata: Record<string, any>): Promise<void>

  /** Similarity search with optional metadata filter */
  search(
    query: number[],
    options: {
      topK: number
      filter?: Record<string, any>
      minScore?: number          // minimum similarity threshold
      namespace?: string         // tenant/scope isolation
    }
  ): Promise<SimilarityResult[]>

  /** Delete a vector by ID */
  delete(id: string): Promise<void>

  /** Batch operations for efficiency */
  batchUpsert(items: { id: string; vector: number[]; metadata: Record<string, any> }[]): Promise<void>
}

interface SimilarityResult {
  id: string
  score: number                 // 0-1, cosine similarity
  metadata: Record<string, any>
}
```

### 2.2 Capability 实现

```
cap-vector-pgvector     — PostgreSQL pgvector 扩展（推荐初始方案）
cap-vector-qdrant       — Qdrant 实现（大规模场景，未来）
cap-vector-memory       — 内存实现（测试/开发，brute-force KNN）
```

**cap-vector-pgvector** 详细设计：

```typescript
defineCapability({
  name: '@linchkit/cap-vector-pgvector',
  dependencies: ['@linchkit/core'],
  extensions: {
    services: {
      vectorStore: PgVectorStoreService,
    },
  },
})
```

存储：在现有 PostgreSQL 实例中添加 `vector` 扩展，新增系统表：

```sql
-- Drizzle schema (auto-generated, never hand-write)
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE _linchkit_vectors (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL DEFAULT 'default',
  embedding vector(1536),        -- dimension configurable
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ON _linchkit_vectors
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 200);

CREATE INDEX ON _linchkit_vectors (namespace);
```

### 2.3 Embedding 模型策略

不引入独立 embedding 依赖——复用 `cap-ai-provider`：

```typescript
// VectorStore 的 embed() 实现委托给 AI Provider
async embed(text: string): Promise<number[]> {
  const provider = this.ctx.services.get('aiProvider')
  if (!provider) throw new Error('AI Provider required for embedding')
  return provider.embed(text)
}
```

- AI Provider 已配置 → 使用其 embedding API（OpenAI text-embedding-3-small, Anthropic embedding 等）
- AI Provider 未配置 → VectorStore 的 embed() 不可用，但 upsert/search 仍可用（外部预计算 embedding）

## 3. 检索编排层

> 调研发现：Agentic RAG（Agent 自主选择检索策略）是 RAG 的主要演进方向。单纯的向量搜索不够。

### 3.1 统一检索接口

```typescript
interface RetrievalService {
  /**
   * Retrieve relevant context for a query.
   * Orchestrator decides which retrieval strategy to use.
   */
  retrieve(
    query: string,
    options: {
      strategies?: RetrievalStrategy[]  // if omitted, auto-select
      topK?: number
      namespace?: string
      entityFilter?: string[]           // limit to specific entities
    }
  ): Promise<RetrievalResult[]>
}

type RetrievalStrategy =
  | 'vector'          // VectorStore similarity search
  | 'structural'      // OntologyRegistry graph query
  | 'keyword'         // Full-text search (cap-search)
  | 'graphql'         // Precise data lookup

interface RetrievalResult {
  source: RetrievalStrategy
  content: string
  score: number
  ref?: MetaModelRef   // if result maps to a meta-model element
  metadata: Record<string, any>
}
```

### 3.2 策略选择

当 `strategies` 未指定时，编排器基于查询特征自动选择：

| 查询特征 | 选择策略 | 示例 |
|---------|---------|------|
| 引用具体 Entity/Action 名 | structural | "purchase_request 的审批规则" |
| 模糊意图描述 | vector + structural | "和财务控制相关的规则" |
| 精确数据查询 | graphql | "上个月被驳回的采购申请" |
| 关键词搜索 | keyword | "供应商 ABC" |

多策略结果通过 reciprocal rank fusion 合并排序。

## 4. 向量化范围

### 4.1 Meta-Model 定义（低量级，高价值）

| 元素 | 向量化内容 | 量级 | 触发时机 |
|------|-----------|------|---------|
| Entity | name + description + field names + semantics.summary | 百级 | 注册时 |
| Action | name + description + input fields + semantics.summary | 百级 | 注册时 |
| Rule | name + description + condition (序列化) + semantics.summary | 百级 | 注册时 |
| Flow | name + description + step summaries | 十级 | 注册时 |

注册时自动向量化（如果 VectorStore + AI Provider 均可用）。namespace = `meta_model`。

### 4.2 业务数据（高量级，Opt-in）

业务数据向量化是 **opt-in**——Entity 声明 `vectorize: true` 才生效：

```typescript
defineEntity({
  name: 'purchase_request',
  vectorize: {
    enabled: true,
    fields: ['title', 'description', 'supplier_name'],  // 哪些字段参与向量化
    // 或 'auto' — 自动选择文本字段
  },
})
```

向量化时机：Action 执行后（create/update），异步写入 VectorStore。namespace = `data:{entity_name}`。

### 4.3 不向量化的内容

- 系统字段（id, created_at, tenant_id 等）
- 纯数值字段（amount, quantity — 用结构化查询更合适）
- 敏感字段（semantics.sensitivity = 'restricted' 的 Entity 跳过）

## 5. 多租户隔离

向量搜索必须尊重租户边界：

- Meta-Model 向量：全局共享（所有租户看到相同的定义）
- 业务数据向量：通过 `namespace` 或 `metadata.tenant_id` 隔离
- 搜索时自动注入 tenant_id filter，防止跨租户泄漏

```typescript
// 自动注入（在 VectorStore middleware 层）
const results = await vectorStore.search(queryVector, {
  topK: 10,
  namespace: `data:purchase_request`,
  filter: { tenant_id: ctx.tenantId },  // auto-injected
})
```

## 6. RAG 质量评估

RAG 质量指标接入可观测性层（Spec 28）：

| 指标 | 含义 | 告警阈值 |
|------|------|---------|
| `rag.context_recall` | 检索结果覆盖了多少相关信息 | < 0.5 |
| `rag.faithfulness` | 生成内容是否忠于检索结果 | < 0.7 |
| `rag.answer_relevancy` | 回答是否切题 | < 0.6 |
| `rag.latency_p95` | 检索延迟 | > 500ms |

低 Faithfulness → 进化系统 Insight："AI 在 X 领域频繁产生幻觉"
低 Context Recall → "知识库在 Y 领域不够完整"

## 7. 优雅降级矩阵

| 条件 | 可用能力 | 不可用能力 |
|------|---------|-----------|
| VectorStore + AI Provider 均有 | 全部功能 | — |
| 仅 VectorStore（无 AI Provider） | 外部预计算 embedding 的 upsert/search | embed() 不可用，Meta-Model 自动向量化不可用 |
| 仅 AI Provider（无 VectorStore） | LLM 语义分类、intent 提取 | embedding 存储和搜索 |
| 均无 | 结构化匹配、标签搜索、关键词搜索 | 所有向量相关功能 |

## 8. 落地路径

| 阶段 | 内容 | 依赖 |
|------|------|------|
| **M5** | VectorStoreService 接口定义（core）；cap-vector-pgvector 实现；cap-vector-memory（测试用）；Meta-Model 定义自动向量化；Few-shot 示例检索（辅助 AI 生成 defineXxx） | cap-ai-provider, pgvector extension |
| **M5-M6** | 检索编排层（RetrievalService）；业务数据 opt-in 向量化；Chatter RAG 集成 | M5, cap-search |
| **M6+** | RAG 质量评估指标接入 Spec 28；多策略 reciprocal rank fusion；cap-vector-qdrant（大规模场景） | M5-M6 |
