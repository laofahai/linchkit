# Rule Intelligence & Meta-Model Semantics Research Findings

> Research date: 2026-04-10
> Context: LinchKit Evolution System (Spec 55) needs rule conflict detection, impact analysis, semantic metadata across ALL meta-model elements, and vector storage infrastructure to support AI-driven lifecycle management.
> Triggered by: User scenario — "purchases over 10k need approval" created twice with conflicting thresholds; rule changes causing unintended side effects; realization that ALL defineXxx() elements need semantic richness for AI reasoning.

## Problem Statement

When users create/modify rules via natural language (through the Proposal system), three risks emerge:

1. **Rule duplication** — User forgets an existing rule and creates a semantically equivalent one
2. **Rule conflict** — Two rules on the same entity with overlapping conditions but contradictory effects
3. **Rule side effects** — Changing one rule's threshold propagates unexpected changes downstream (state transitions, event handlers, flows)

Current Spec 55 §7.3 mentions "does it conflict with existing Rules/Flows?" as a single bullet point but provides no design for how this works.

## 1. Rule Conflict Detection — Industry Survey

### 1.1 Decision Table Interval Analysis (IBM ODM, FICO Blaze)

For rules expressed as decision tables, conflict detection reduces to **set intersection on condition columns**:

- Each condition column defines a value range (e.g., `amount > 10000`)
- Two rows conflict when their condition ranges intersect AND effects contradict
- IBM ODM provides a static "Decision Table Analysis" tool that reports: overlapping conditions, gaps, redundant rows

**Applicability to LinchKit**: LinchKit rules have structured `condition` fields (`field`, `operator`, `value`), which are essentially single-column decision table entries. Interval analysis is directly applicable for same-entity, same-field rules.

### 1.2 Execution Order Resolution (Drools / Rete)

Drools uses the Phreak algorithm (improved Rete) for pattern matching, then resolves conflicts via:

- **Salience** (numeric priority)
- **Specificity** (more conditions = higher priority)
- **Activation Group** (mutual exclusion within group)
- **Recency** (most recently modified facts win)

**Key insight**: Drools resolves "who runs first", NOT "are the effects contradictory". It's a scheduling strategy, not a semantic conflict detector.

### 1.3 No Detection (Salesforce Flow, ServiceNow)

Low-code platforms generally do NOT detect rule conflicts. They rely on:
- Execution order (numeric) — administrator responsibility
- Debug logs for post-hoc analysis
- ServiceNow: `execution order` field on Business Rules

**Key insight**: This is the industry norm for low-code platforms, and it's a known pain point.

### 1.4 LLM + SMT Hybrid (Academic)

Emerging research direction:

- **RuleBERT** (IBM Research, 2022): Fine-tuned BERT for rule entailment/contradiction detection on IF-THEN natural language rules. Open source.
- **Z3 + LLM**: LLM translates natural language rules to SMT formulas; Z3 solver checks satisfiability (unsatisfiable = conflict).
- **Ahmadi et al. (IEEE Access, 2022)**: NLP extracts semantic triples from rules, ontology reasoning detects contradictions.

**Applicability to LinchKit**: LinchKit rules are already semi-structured (not pure natural language), making the LLM→SMT translation easier. The structured `condition` can be directly converted to SMT formulas without LLM assistance; LLM is only needed for intent-level conflict detection.

### 1.5 Recommendation for LinchKit

**Hybrid approach**:
- **Structural conflict detection** (no AI needed): Interval overlap analysis on same-entity, same-field conditions. Detects: "Rule A triggers on amount > 10000, Rule B triggers on amount > 5000 — Rule A is subsumed by Rule B."
- **Semantic conflict detection** (AI-assisted): For rules on different fields but same intent (e.g., one checks amount, another checks budget_code — both are "financial control"). Use embeddings + LLM classification.
- **Effect contradiction analysis** (deterministic): If two overlapping rules have effects `gate` (block) vs `side_effect` (allow + notify), flag as potential contradiction.

---

## 2. Rule Change Impact Analysis

### 2.1 Dependency DAG

Core data structure: directed acyclic graph where nodes are meta-model elements and edges are dependencies.

```
Rule → targets → Entity (field conditions)
Rule → triggers → Action (side effects)
Rule → guards → State Transition
Action → emits → Event
Event → handled_by → EventHandler
EventHandler → calls → Action (nested)
Flow → contains → Steps (Actions)
```

Impact analysis = BFS/DFS from changed node, collecting all reachable nodes.

**Reference implementations**:
- PostgreSQL `pg_depend`: tracks object dependencies with `deptype` (NORMAL / AUTO / INTERNAL)
- Oracle `DBA_DEPENDENCIES`: supports transitive closure queries via `CONNECT BY`
- Salesforce `MetadataComponentDependency`: per-component dependency lookup

**Proposed data structure for LinchKit**:

```typescript
interface MetaModelDependency {
  sourceType: 'rule' | 'action' | 'state' | 'event' | 'event_handler' | 'flow' | 'entity';
  sourceId: string;
  targetType: 'rule' | 'action' | 'state' | 'event' | 'event_handler' | 'flow' | 'entity' | 'field';
  targetId: string;
  dependencyKind: 'field_read' | 'field_write' | 'triggers' | 'guards' | 'handles' | 'contains';
}
```

This can be auto-built from meta-model definitions at registration time — no manual annotation needed.

### 2.2 What-If Simulation (Backtesting)

Replay historical data against proposed rule changes to preview impact.

**Reference implementations**:
- Moody's Analytics "Scenario Engine": select historical records → shadow-execute new rule → diff output
- Netflix Archaius: dry-run config changes on shadow traffic
- LaunchDarkly: show past 7-day flag evaluation count + affected user segments before change
- Spec 55 §7.4 already designs this ("backtest") but without implementation detail

**Proposed data structure**:

```typescript
interface WhatIfResult {
  timeWindow: string;           // e.g., '30d'
  totalRecords: number;         // records in window
  affectedRecords: number;      // records that would trigger the rule
  breakdown: {
    outcome: string;            // e.g., 'blocked', 'approved', 'notified'
    oldCount: number;
    newCount: number;
  }[];
  examples: {
    recordId: string;
    oldResult: string;          // what happened
    newResult: string;          // what would happen
  }[];
}
```

### 2.3 UI Patterns for Impact Preview

| Platform | Pattern | Description |
|----------|---------|-------------|
| Salesforce | Tree expand panel | Left: changed item; Right: downstream dependencies with severity tags |
| ServiceNow | Conflict list | Each conflict row: status (Skip/Error/Warning), user decides Accept/Skip |
| LaunchDarkly | Ring chart + numbers | Past 7-day evaluation count, affected segments |
| Proposed for LinchKit | Layered impact view | Layer 1 (red): direct dependencies; Layer 2 (yellow): indirect; Layer 3 (gray): distant |

---

## 3. Rule Semantic Metadata

### 3.1 Ontology-Based Approaches (SHACL, OWL)

SHACL (W3C) is the most practical model — constraints as RDF shapes with semantic annotations:

```turtle
ex:OrderAmountRule a sh:NodeShape ;
  sh:targetClass ex:Order ;
  sh:property [ sh:path ex:totalAmount ; sh:maxExclusive 50000 ] ;
  dcterms:subject ex:FinancialControl ;    # intent
  ex:regulation "SOX-404" ;                 # compliance link
  ex:conflictsWith ex:VIPNoLimitRule .      # explicit conflict
```

**Key takeaway**: Rules should carry semantic annotations (intent, domain, regulation) as first-class metadata, not just a free-text `description`.

### 3.2 W3C Rule Interchange Format (RIF)

RIF supports metadata annotation blocks (`(*...*)`) on every rule, carrying `dc:subject`, `rif:intent`, etc. Low real-world adoption, but the **metadata annotation pattern** is worth borrowing.

### 3.3 LLM-Based Semantic Extraction

Current capabilities:
- **Intent classification**: Zero-shot LLM classification of rules into categories (financial_control, compliance, quality_assurance, access_control). Accuracy ~85-90%.
- **Relationship extraction**: Extract subsumes/conflicts/complements relations between rule pairs.
- **Structured output**: LLM converts natural language rules to JSON-LD with semantic tags.

### 3.4 Knowledge Graph Rule Relationships

Four canonical edge types between rule nodes:

| Relation | Meaning | Use Case |
|----------|---------|----------|
| `subsumes` | A's conditions are a superset of B's | Rule simplification, redundancy detection |
| `conflictsWith` | A and B have contradictory effects | Conflict detection |
| `complements` | A and B work together | Co-activation, bundled changes |
| `overrides` | A supersedes B under specific conditions | Priority resolution |

### 3.5 Palantir Foundry Approach

Rules are **first-class citizens in the ontology** — not external config, but Object Type Actions/Constraints with:
- Semantic type tags (from ontology taxonomy)
- Typed input/output signatures
- Permission and audit associations

**Key insight**: This matches LinchKit's OntologyRegistry philosophy — rules should be queryable, describable, and relatable through the same ontology layer that handles entities.

### 3.6 Proposed Semantic Metadata for LinchKit

```typescript
interface RuleSemantics {
  intent: string[];              // ['financial_control', 'fraud_prevention']
  domain: string[];              // ['procurement', 'payment']
  regulation?: string[];         // ['SOX-404', 'GDPR-Art17']
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  naturalLanguageSummary: string; // AI-generated human-readable summary
  embedding?: number[];          // Vector for semantic similarity search
}
```

When a user creates a rule via natural language:
1. AI extracts `intent` and `domain` from the utterance
2. Embedding is computed for similarity search against existing rules
3. If similarity > threshold, show existing rules and ask: replace, modify, or add?
4. After creation, AI auto-fills remaining semantic fields

---

## 4. Synthesis — Proposed Architecture for LinchKit

### 4.1 Flow: Rule Creation via Natural Language

```
User: "Purchases over 10k need approval"
  │
  ▼
[Sense] Parse intent → financial_control, entity: purchase_request, field: amount
  │
  ▼
[Memory] Semantic search (embedding similarity + structured condition match)
  ├── Found: "Rule 'require_approval_over_5k' — amount > 5000 → gate"
  │   → Prompt user: "Existing rule covers amount > 5000. Replace threshold? Add separate rule?"
  └── Not found: proceed
  │
  ▼
[Awareness] Dependency DAG analysis
  ├── Affected downstream: State 'pending_approval', EventHandler 'notify_approver'
  └── Conflicting rules: none / list conflicts
  │
  ▼
[Insight] What-If backtest on past 30 days
  ├── "47 records would trigger; 38 were eventually rejected (81% hit rate)"
  └── "Estimated +200 approval tasks/month"
  │
  ▼
[Proposal] Present to user with full context:
  ├── The rule definition (defineRule code)
  ├── Semantic metadata (auto-filled)
  ├── Conflict report (if any)
  ├── Impact preview (dependency tree + what-if numbers)
  └── Options: Apply / Modify / Cancel
```

### 4.2 Three Components to Design

1. **Rule Dependency DAG** — Auto-built from meta-model registrations. Stored in OntologyRegistry. Used for impact analysis (BFS reachability).

2. **Rule Semantic Metadata** — `RuleSemantics` interface added to `defineRule()`. Auto-filled by AI at Proposal time. Embeddings stored for similarity search.

3. **Pre-Proposal Analysis Pipeline** — Inserted between Insight and Proposal in Spec 55's flow:
   - Semantic dedup check (embedding similarity)
   - Structural conflict detection (condition interval overlap)
   - Dependency impact analysis (DAG traversal)
   - What-If backtest (historical data replay)

### 4.3 What's Already in Place

| Component | Status |
|-----------|--------|
| OntologyRegistry (structure awareness) | Done (Spec 55 §5.4) |
| Proposal mechanism | Done (Spec 09) |
| Rule engine with structured conditions | Done (Spec 05) |
| What-If backtest concept | Designed but not detailed (Spec 55 §7.4) |
| Dependency DAG | **Not designed** |
| Rule semantic metadata | **Not designed** |
| Pre-Proposal conflict analysis | **Not designed** (only a bullet point in §7.3) |

---

## References

- IBM ODM Decision Table Analysis — static overlap/gap/redundancy detection
- Drools Phreak algorithm — Rete-based conflict set resolution via salience/specificity/activation groups
- RuleBERT (IBM Research, 2022) — BERT fine-tuned for rule entailment/contradiction
- Ahmadi et al. (IEEE Access, 2022) — NLP + ontology reasoning for business rule inconsistency detection
- SHACL (W3C) — constraint shapes with semantic annotations
- W3C RIF — rule interchange format with metadata annotation blocks
- PostgreSQL pg_depend — object dependency tracking model
- Salesforce MetadataComponentDependency — UI pattern for dependency tree
- LaunchDarkly Flag Impact Analysis — pre-change evaluation count + affected segments
- Moody's Analytics Scenario Engine — historical data replay for what-if analysis
- Palantir Foundry Ontology SDK — rules as first-class ontology citizens

---

## 5. Meta-Model Semantic Metadata — All defineXxx()

### 5.1 Problem: AI Needs to Understand the Entire System, Not Just Rules

Rule conflict detection and impact analysis require AI to reason about the **full meta-model graph**: Entity → Action → Rule → State → Event → EventHandler → Flow → Relation → View. If only Rules carry semantic metadata, AI cannot:

- Understand *why* an Action exists (to determine if a Rule change breaks its intent)
- Classify Entities by business role (master data vs transaction vs log)
- Trace the business purpose of a Flow (to assess if a Rule conflict affects a critical process)
- Determine if two Relations serve the same business purpose (redundancy detection)

### 5.2 Current State of Semantics in defineXxx()

| defineXxx | Current semantic info | AI-readability |
|-----------|----------------------|----------------|
| **Entity** | `name` (snake_case) + `description` (free text) + field definitions | Medium — structure is rich, intent is weak |
| **Action** | `name` (verb_noun) + `description` + input/output types | Medium — naming convention helps, but business purpose unclear |
| **Rule** | `name` + `description` + structured `condition` + `effect` type | Medium — conditions are machine-readable, intent is not |
| **State** | State names + transition definitions | Medium — names are semantic, business reasons for transitions missing |
| **Event** | `name` (entity.past_tense_verb) + payload type | Low-Medium — naming convention is strong, but impact/severity unknown |
| **EventHandler** | `name` + `description` + event binding | Low — derivative of Event, purpose unclear |
| **View** | Field list + sort/filter config | Low — serves UI, business context (who/when/why) missing |
| **Flow** | `name` + `description` + step definitions | Medium — steps are structural, business process mapping missing |
| **Relation** | `fromName`/`toName` + cardinality + entity refs | Medium — structural semantics strong, business meaning weak |

### 5.3 Proposed: Two-Layer Semantic Metadata

**Layer 1: Shared base interface for ALL defineXxx()**

```typescript
interface MetaSemantics {
  intent?: string[];          // Business intent tags: ['financial_control', 'compliance', 'automation']
  domain?: string[];          // Business domain: ['procurement', 'hr', 'inventory']
  summary?: string;           // AI-generated standardized natural language summary
  tags?: string[];            // Free-form tags for search/grouping
}
```

Lightweight, optional, zero burden on developers. AI auto-fills at registration time from `name` + `description` + structural analysis. Developer can override explicitly.

**Layer 2: Type-specific extensions**

```typescript
// Entity
interface EntitySemantics extends MetaSemantics {
  category?: 'master_data' | 'transaction' | 'reference' | 'log' | 'config';
  sensitivity?: 'public' | 'internal' | 'confidential' | 'restricted';
}

// Action
interface ActionSemantics extends MetaSemantics {
  sideEffectLevel?: 'none' | 'local' | 'cross_entity' | 'external';
  reversible?: boolean;
}

// Rule
interface RuleSemantics extends MetaSemantics {
  regulation?: string[];      // Compliance references: ['SOX-404', 'GDPR-Art17']
  riskLevel?: 'low' | 'medium' | 'high' | 'critical';
}

// Flow
interface FlowSemantics extends MetaSemantics {
  businessProcess?: string;   // Maps to business process name
  sla?: string;               // Time constraint: '24h', '3d'
}

// Relation
interface RelationSemantics extends MetaSemantics {
  businessMeaning?: string;   // 'supplier provides items for purchase orders'
}
```

### 5.4 Auto-Generation Strategy

Developers should NOT be forced to fill semantic metadata manually. The system generates it:

1. **At registration time** (deterministic, no AI):
   - `Entity.category`: inferred from field patterns (has `status` field + state machine → transaction; no mutations → reference)
   - `Action.sideEffectLevel`: inferred from handler analysis (calls external API → external; modifies other entities → cross_entity)
   - `Action.reversible`: inferred from whether a compensating action exists

2. **At first AI interaction** (LLM-assisted, cached):
   - `intent` classification from name + description (zero-shot, ~85-90% accuracy)
   - `domain` classification from entity names and field types
   - `summary` generation — standardized natural language description

3. **At Proposal time** (LLM-assisted, per-proposal):
   - Embedding computation for similarity search
   - Relationship extraction between new and existing elements

4. **Human override** (optional, always takes precedence):
   - Developer writes `semantics: { intent: ['financial_control'] }` in defineXxx()
   - Overrides auto-generated values

### 5.5 OntologyRegistry Integration

OntologyRegistry already provides `describe()`, `listEntities()`, `searchEntities()`, `actionsFor()`, `relationsFor()`. Semantic metadata should be:

- Stored in OntologyRegistry alongside structural metadata
- Queryable: `registry.searchByIntent('financial_control')` → all entities/actions/rules related to financial control
- Used by Evolution System for impact analysis scope determination

---

## 6. Vector Storage Infrastructure

### 6.1 Current State

LinchKit has **no vector storage**. Spec 00 (Tech Stack) explicitly lists "RAG / vector retrieval" under "things NOT introduced in M0-M2". No spec designs vector storage.

However, multiple planned features **implicitly require** vector capabilities:

| Feature | Spec | Vector need |
|---------|------|-------------|
| Rule semantic dedup | 55 §7.3 | Embedding similarity search on rule definitions |
| AI Insight "similar records" | 52 §3 | Find records with similar field patterns |
| Evolution Memory "pattern matching" | 55 §4 | Match current signals against historical patterns |
| Chatter context retrieval | 53 | RAG over business data for conversational AI |
| Meta-model semantic search | — (new) | Search defineXxx() by intent/domain |

### 6.2 Options Evaluated

**Option A: pgvector (PostgreSQL extension)**

- Pros: Zero additional infrastructure; current PG instance + `CREATE EXTENSION vector`; Drizzle supports custom column types; sufficient for meta-model scale (hundreds of definitions, not millions of documents)
- Cons: Not optimized for large-scale similarity search (>1M vectors); limited index types (IVFFlat, HNSW)
- Fit: Perfect for meta-model semantics, adequate for business data at moderate scale

**Option B: External vector database (Qdrant / Milvus / Pinecone)**

- Pros: Purpose-built, high performance at scale, advanced filtering
- Cons: Additional infrastructure dependency; overkill for meta-model scale; operational burden
- Fit: Only justified at enterprise scale with millions of documents for RAG

**Option C: Capability-based abstraction (RECOMMENDED)**

Core defines a `VectorStore` service interface. Capabilities provide implementations:

```typescript
// Core: abstract interface
interface VectorStoreService {
  embed(text: string): Promise<number[]>;
  upsert(id: string, vector: number[], metadata: Record<string, any>): Promise<void>;
  search(query: number[], topK: number, filter?: Record<string, any>): Promise<SimilarityResult[]>;
  delete(id: string): Promise<void>;
}

// cap-vector-pgvector: PostgreSQL pgvector implementation
// cap-vector-qdrant: Qdrant implementation (future)
// cap-vector-memory: In-memory implementation (testing/dev)
```

**Why Option C**: Aligns with LinchKit's Capability-Centric principle. Core never depends on a specific vector DB. Evolution System checks if a VectorStore capability is installed:
- **With VectorStore**: Full semantic search, embedding similarity, pattern matching
- **Without VectorStore**: Fallback to structural matching (field/operator/value comparison), text search on description

This means the Evolution System **degrades gracefully** — it's useful without vectors, but smarter with them.

### 6.3 Embedding Model Strategy

Who computes the embeddings?

| Option | Pros | Cons |
|--------|------|------|
| External API (OpenAI, Anthropic) | High quality, no local resources | Latency, cost, data leaves system |
| Local model (all-MiniLM-L6-v2 via ONNX) | Fast, private, free | Lower quality, binary size |
| AI Provider Capability | Uses whatever AI provider is configured | Depends on cap-ai-provider |

**Recommendation**: Use the existing `cap-ai-provider` capability's embedding endpoint. If no AI provider is configured, skip embedding-based features (graceful degradation). This avoids introducing a new dependency.

### 6.4 What Gets Vectorized

**Meta-model elements** (low volume, high value):

| Element | Vectorize what | Purpose |
|---------|---------------|---------|
| Entity | name + description + field names | Entity similarity search |
| Action | name + description + input fields | Action dedup, intent matching |
| Rule | name + description + condition (serialized) | Rule conflict detection |
| Flow | name + description + step summaries | Process similarity |

**Business data** (high volume, capability-dependent):

| Data type | Vectorize what | Purpose |
|-----------|---------------|---------|
| Record summaries | Key field values concatenated | Similar record detection |
| Event sequences | Serialized event chains | Pattern recognition |
| User queries | Natural language queries | Conversational context retrieval |

Business data vectorization should be opt-in per entity (`vectorize: true` in defineEntity), not automatic for all data.

---

## References

(additions)
- pgvector — PostgreSQL vector similarity search extension
- Drizzle ORM custom column types — for pgvector integration
- all-MiniLM-L6-v2 — lightweight sentence embedding model (384 dimensions)
- Palantir Foundry Ontology SDK — all elements as semantic first-class citizens
- SHACL (W3C) — semantic annotations on constraint definitions
