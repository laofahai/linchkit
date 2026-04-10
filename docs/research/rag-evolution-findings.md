# RAG Evolution & Future Direction Research Findings

> Research date: 2026-04-10
> Context: LinchKit is adding vector storage as an optional Capability (Spec 55 §12). This research explores where RAG technology is heading to inform architecture decisions — design for the future, not just today.

## 1. Beyond Naive RAG — Architecture Evolution

### 1.1 Graph RAG (Microsoft, open-source 2024)

LLM extracts entity-relationship graph from corpus → community detection → hierarchical summaries. Solves the core limitation of vector search: inability to answer global questions ("what are the main themes across this dataset?").

### 1.2 Agentic RAG

Retrieval controlled by an Agent loop. Agent decides: whether to retrieve, what to retrieve, whether to do multiple rounds, whether to use tools instead. Main frameworks: LangGraph, LlamaIndex Workflows.

**Key shift**: RAG evolves from "one retrieval + generate" to "multi-step reasoning + retrieval on demand".

### 1.3 Self-RAG (Akari Asai et al., 2023)

Model self-judges: Do I need retrieval? → Is the retrieved result relevant? → Does my generation have hallucinations? Implemented via special reflection tokens.

### 1.4 CRAG (Corrective RAG)

Post-retrieval quality assessment layer. If results are irrelevant → trigger web search or query rewriting.

### 1.5 Adaptive RAG

Dynamic strategy selection based on query complexity:
- Simple question → direct generation (no retrieval)
- Medium question → single retrieval
- Complex question → multi-step reasoning with iterative retrieval

### 1.6 Implication for LinchKit

**Don't just build vector search. The real value is in the retrieval orchestration layer** — let AI choose between vector retrieval, graph queries, or structured queries based on the question.

Design:
```
RetrievalOrchestrator
  ├── VectorStore.search()        — semantic similarity
  ├── OntologyRegistry.query()    — structural/graph queries
  ├── GraphQL/SQL                 — precise data lookup
  └── Agent decides which to use
```

## 2. RAG vs Long Context

Current consensus: **complementary, not replacement**.

| Dimension | Long Context (1M tokens) | RAG |
|-----------|--------------------------|-----|
| Best for | Single-session document analysis, codebase understanding | Persistent knowledge bases, multi-tenant isolation |
| Cost | Expensive (full 1M inference) | Efficient (retrieve only what's needed) |
| Freshness | Snapshot at prompt time | Real-time index updates |
| Traceability | Implicit (buried in context) | Explicit (citations per chunk) |
| Multi-tenant | Cannot mix tenant data safely | Natural isolation via filtered search |
| Scale | ~750K words max | GB-TB scale knowledge bases |

**Key number**: 1M tokens ≈ several books. Enterprise knowledge bases are typically GB-TB — doesn't fit.

Google's Gemini team still ships "Grounding with Search" alongside 1M+ context, confirming retrieval remains infrastructure even with ultra-long context.

## 3. Structured Data RAG — Directly Relevant to LinchKit

Most RAG research focuses on unstructured documents. Emerging work on structured/semi-structured data:

- **Text-to-SQL + RAG hybrid** (Vanna.ai): Vector-index table schemas + example queries → retrieve relevant schemas → generate SQL. Most practical open-source project in this space.
- **Table Augmented Generation (TAG)** (Microsoft + UC Berkeley): Specialized architecture for natural language queries over database tables. More flexible than pure Text-to-SQL.
- **Schema-aware embedding**: Index database schemas, field descriptions, and business rules together. Retrieval returns structure definitions + sample data simultaneously.

### Direct application to LinchKit

LinchKit's meta-model definitions ARE structured metadata. The "meta-model RAG" pattern:

1. **Index**: All existing defineEntity/defineAction/defineRule definitions (name + description + structural summary) → vector embeddings
2. **Retrieve**: When AI generates a new definition, find top-k most similar existing definitions
3. **Generate**: Use retrieved definitions as few-shot examples → AI produces correct, consistent defineXxx() code
4. **Update**: New definitions automatically enter the index — no retraining needed

This is more valuable than document RAG for LinchKit's core use case.

## 4. RAG for Code/Config Generation

- **RACG (Retrieval-Augmented Code Generation)**: GitHub Copilot uses repo-level code retrieval internally
- **Few-shot example retrieval**: Most practical pattern — retrieve similar existing code as examples. More flexible than fine-tuning, instantly updated.
- **Documentation-grounded generation**: Index API docs and type definitions; force generated code to reference them.

### Recommended for LinchKit

Build a "capability template index":
- Vectorize all existing Entity/Action/Rule definitions with their descriptions
- When AI generates new definitions, retrieve top-k most similar as few-shot examples
- Ensures consistency with existing codebase patterns
- Natural quality improvement as the system grows (more examples = better generation)

## 5. Multi-Modal RAG in Business Context

Relevant business scenarios: invoice/contract OCR + retrieval, process diagram understanding, table image parsing. ColPali (2024) uses vision models to embed document pages directly, skipping OCR.

**Low priority for LinchKit** currently, but relevant if document management capability is added later.

## 6. RAG Quality Evaluation — Emerging Standards

**RAGAS** (de facto standard framework):
- **Faithfulness**: Is the generated answer faithful to retrieved context?
- **Answer Relevancy**: Does the answer address the question?
- **Context Precision**: Are the retrieved chunks relevant?
- **Context Recall**: Did retrieval find all relevant information?

**Other frameworks**: DeepEval (hallucination detection), Arize Phoenix / LangSmith (production tracing + eval).

### Implication for LinchKit

RAG quality metrics should feed into the Observability layer (Spec 28):
- Context Recall → "Is the knowledge base complete enough?"
- Faithfulness → "Is the AI hallucinating or grounded?"
- These metrics become sensors for the Evolution System (Spec 55)

## 7. Alternatives to RAG

| Approach | Pros | Cons | Relationship to RAG |
|----------|------|------|---------------------|
| **Continuous pre-training / fine-tuning** | Domain terminology, reasoning patterns | Can't solve knowledge freshness | Complementary |
| **Knowledge distillation** | Smaller model with RAG-like capability | Static, no real-time updates | Optimization |
| **Cache-Augmented Generation (CAG)** | Pre-load knowledge into KV cache | Only for small, stable knowledge bases | Niche alternative |
| **Memory mechanisms** (MemGPT/Letta) | Long-term memory management | Different scope (conversation, not knowledge) | Complementary |

**Conclusion**: No single technology replaces RAG. The trend is RAG becoming a component within a larger agent system, orchestrated on demand.

## 8. Design Recommendations for LinchKit

### Priority 1: Meta-Model RAG (M5)
- Index all defineXxx() definitions as embeddings
- Few-shot retrieval for AI code generation
- Semantic dedup for Rule/Action/Entity
- Requires: cap-vector-pgvector + cap-ai-provider

### Priority 2: Retrieval Orchestration Layer (M5-M6)
- Unified interface: vector search + graph query + structured query
- Agent decides retrieval strategy per query
- Requires: Agentic RAG pattern over OntologyRegistry + VectorStore

### Priority 3: Business Data RAG (M6+)
- Opt-in per-entity vectorization (`vectorize: true`)
- Chatter (conversational AI) grounded in business data
- Multi-tenant isolation via filtered vector search
- Requires: larger vector infrastructure (may need Qdrant for scale)

### Priority 4: RAG Quality as Evolution Signal (M6+)
- RAGAS metrics exposed to Observability (Spec 28)
- Low Faithfulness → Evolution System detects "AI is hallucinating about X"
- Low Context Recall → "Knowledge base is incomplete for domain Y"
- Feeds into Insight → Proposal cycle

## References

- Graph RAG (Microsoft, 2024) — entity-relationship extraction + community-based summarization
- LangGraph, LlamaIndex Workflows — Agentic RAG orchestration frameworks
- Self-RAG (Akari Asai et al., 2023) — self-reflective retrieval-augmented generation
- CRAG — corrective retrieval-augmented generation
- Vanna.ai — Text-to-SQL with RAG over database schemas
- TAG (Microsoft + UC Berkeley) — table augmented generation
- ColPali (2024) — vision-based document page embedding
- RAGAS — retrieval-augmented generation assessment framework
- DeepEval — open-source LLM evaluation
- MemGPT/Letta — long-term memory management for LLM agents
- CAG — cache-augmented generation for small knowledge bases
