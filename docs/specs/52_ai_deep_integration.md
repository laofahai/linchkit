# AI Deep Integration — From Chat to Action

> This spec extends [Spec 15 — AI Developer Experience](./15_ai_developer_experience.md) and [Spec 36 — AI Service](./36_ai_service.md). Read those specs first for context.
>
> - **Spec 15** covers *developer-facing* AI: MCP tools, Proposals, code scaffolding, CLAUDE.md/AGENTS.md auto-generation, AI Management UI (Proposal approval, Insights dashboard, Evolution timeline, AI assistant panel, AI search/auto-fill). This spec does NOT duplicate those features.
> - **Spec 36** covers the AI service layer (`ctx.ai`, provider configuration, model aliases, rate limiting, cost control, tool calling). This spec uses `ctx.ai` as the underlying engine and does NOT redefine its API or configuration.
> - **Spec 22** defines AI rule boundaries. **Spec 27** defines AI security hardening. Both apply here without modification.
>
> Tracking milestones:
> - `M6: AI Intelligence`
>
> Related issues:
> - GitHub Issue `#78` — AI deep integration: NL intent resolution
> - GitHub Issue `#83` — Record analysis and data quality scanning
>
> Execution source of truth: GitHub milestones and issues.

## 1. Overview

Spec 15 §8 defines the AI Management UI including AI assistant panel, AI search, and auto-fill. Spec 36 defines `ctx.ai` for AI calls within Action handlers and Flows. This spec builds on both to define how AI becomes an **active participant in the runtime UI** — executing actions via natural language, analyzing records contextually, detecting data quality issues, and proactively surfacing insights.

The core principle: **AI proposes, user confirms, CommandLayer executes.**

### 1.1 Design Principles

| Principle | Description |
|-----------|-------------|
| **Human-in-the-Loop** | AI never auto-executes write operations. It builds the action payload and presents a confirmation card. User clicks "Execute." |
| **CommandLayer is the only gate** | All AI-initiated actions go through the full 7-slot pipeline (pre → auth → exposure → permission → tenant → pre-action → post-action). No shortcuts. |
| **Permission-scoped** | AI sees only what the current user can see. AI cannot elevate privileges. |
| **Auditable** | Every AI-initiated action is tagged with `source: 'ai'` in the execution log. The original natural-language prompt is recorded. |
| **Graceful degradation** | If AI service is unavailable, the system works normally. AI features show "AI unavailable" state, not errors. |
| **Respect spec 22 boundaries** | AI does not replace Rule Engine for deterministic decisions. AI handles fuzzy intent, pattern discovery, and suggestions. |

### 1.2 Relation to Existing Specs

| Spec | Relationship | What this spec adds |
|------|-------------|---------------------|
| 15 — AI Developer Experience | Developer-facing AI + AI Management UI (§8). | User-facing runtime AI: intent resolution, action execution via NL, record analysis. |
| 36 — AI Service | `ctx.ai` API, provider config, model aliases, tool calling. | Higher-level orchestration: intent resolver, record analyzer, suggestion engine on top of `ctx.ai`. |
| 22 — AI Rule Boundary | Hard boundary rules. | Operates within those boundaries; no changes. |
| 27 — AI Security | Prompt sanitization, output validation, PII redaction. | All apply to deep integration endpoints; no changes. |
| 13 — View & UI | AI inline hints, Intent Preview mode (§2.3), AI assistant panel (§2.2). | Concrete implementations: ActionProposalCard, InsightPanel, RichMessage renderer, SuggestionBell. |

---

## 2. AI Action Execution

The headline feature: users describe what they want in natural language, AI maps it to a concrete action with pre-filled parameters, and presents a confirmation card.

### 2.1 Flow

```
User: "创建一个5000元的采购请求给综合管理部"
  ↓
AI Intent Parser (server-side)
  ↓ Ontology lookup: find matching action + schema
  ↓ Extract parameters from natural language
  ↓ Validate against action input schema (Zod)
  ↓
Response: ActionProposalCard
  {
    action: "create_purchase_request",
    input: { amount: 5000, department: "综合管理部", ... },
    confidence: 0.92,
    missingFields: ["description"],
    explanation: "I'll create a purchase request for ¥5,000 assigned to 综合管理部."
  }
  ↓
UI renders ActionProposalCard with pre-filled form
  ↓ User reviews, edits if needed, clicks "Execute"
  ↓
POST /api/actions/create_purchase_request  (standard action endpoint)
  ↓ Full CommandLayer pipeline
  ↓
Result shown in chat + toast notification
```

### 2.2 Intent Resolution

The server-side intent resolver uses OntologyRegistry to understand the system:

```typescript
interface IntentResolution {
  /** Matched action name, or null if no match */
  action: string | null;

  /** Target schema (inferred from action) */
  schema: string | null;

  /** Extracted input parameters */
  input: Record<string, unknown>;

  /** Fields that are required but not extracted */
  missingFields: string[];

  /** Confidence score 0-1 */
  confidence: number;

  /** Human-readable explanation of what will happen */
  explanation: string;

  /** Alternative interpretations if confidence < threshold */
  alternatives?: Array<{
    action: string;
    confidence: number;
    explanation: string;
  }>;
}
```

**Resolution strategy:**

1. Build a system prompt containing:
   - All schema names + descriptions from `OntologyRegistry.listSchemas()`
   - All action names + descriptions + input schemas from `OntologyRegistry.describe()`
   - Current user's permission scope (which schemas/actions they can access)
   - Current context (viewing schema X, record Y)

2. Send user message + system prompt to AI with structured output (`responseFormat: json`)

3. Validate extracted input against the action's Zod schema. Mark invalid/missing fields.

4. If confidence < 0.7, include alternative interpretations.

5. If confidence < 0.4, respond with clarification question instead of action proposal.

### 2.3 ActionProposalCard (UI Component)

```typescript
interface ActionProposalCardProps {
  /** The resolved intent */
  intent: IntentResolution;

  /** Schema definition for rendering the form preview */
  schema: EntityDefinition;

  /** Callback when user confirms execution */
  onExecute: (input: Record<string, unknown>) => void;

  /** Callback when user wants to edit before executing */
  onEdit: (input: Record<string, unknown>) => void;

  /** Callback when user dismisses */
  onDismiss: () => void;
}
```

The card renders:
- Action name + description
- Pre-filled field values (editable inline)
- Missing fields highlighted with input controls
- Confidence indicator (high/medium/low)
- "Execute" primary button + "Edit in Form" secondary button + "Cancel" ghost button
- If confidence is low: "Did you mean..." alternatives as clickable chips

### 2.4 Confirmation Modes

| Mode | When | Behavior |
|------|------|----------|
| **Explicit confirm** (default) | All write actions | User must click "Execute" |
| **Auto-execute** | Read-only queries, navigation | AI directly runs the query and shows results |
| **Batch confirm** | Multiple related actions | AI proposes a sequence, user confirms all at once |

Configuration per action:

```typescript
defineAction({
  name: 'create_purchase_request',
  ai: {
    confirmationMode: 'explicit',     // default
    allowAutoExecute: false,          // never skip confirmation for writes
    promptHints: [                    // help AI understand this action
      'Used when creating new purchase requests',
      'Amount is in CNY',
      'Department must be a valid department name',
    ],
  },
  // ...
})
```

### 2.5 Multi-Step Action Sequences

AI can propose a sequence of actions:

```
User: "Create a purchase request for 3 laptops at ¥8000 each and submit it for approval"
  ↓
AI proposes:
  Step 1: create_purchase_request { amount: 24000, items: [...] }
  Step 2: submit_purchase_request { id: <result of step 1> }
  ↓
UI renders ActionSequenceCard:
  [1] Create purchase request — ¥24,000 for 3x laptop  ✓
  [2] Submit for approval — pending step 1              ⏳
  [Execute All] [Edit] [Cancel]
```

Step 2 depends on step 1's result (the created record ID). The executor chains them sequentially, aborting if any step fails.

### 2.6 Server API

```
POST /api/ai/resolve-intent
  Body: { message: string, context: { schema?: string, recordId?: string } }
  Response: IntentResolution

POST /api/ai/execute-intent
  Body: { action: string, input: Record<string, unknown>, source: 'ai' }
  → Proxies to standard action execution with AI audit metadata
```

---

## 3. AI Record Analysis

On any record detail page, AI can analyze the record and provide contextual insights.

### 3.1 Analysis Types

| Type | Description | Example |
|------|-------------|---------|
| **Comparison** | Compare against historical averages | "This request is 3x the department average" |
| **Timeline** | Predict based on similar records | "Similar requests approved in ~2 days" |
| **Risk** | Flag potential issues | "Vendor has 3 late deliveries in past month" |
| **Recommendation** | Suggest next actions | "Consider splitting into 2 requests (policy: >¥50k needs VP approval)" |
| **Related** | Surface related records | "5 similar requests from same department this quarter" |

### 3.2 RecordAnalysis Interface

```typescript
interface RecordAnalysis {
  /** Record being analyzed */
  recordId: string;
  schemaName: string;

  /** Analysis results */
  insights: RecordInsight[];

  /** When this analysis was generated */
  generatedAt: Date;

  /** AI model used */
  model: string;
}

interface RecordInsight {
  /** Insight category */
  type: 'comparison' | 'timeline' | 'risk' | 'recommendation' | 'related';

  /** Severity/importance: higher = more prominent in UI */
  severity: 'info' | 'warning' | 'critical';

  /** Short title */
  title: string;

  /** Detailed explanation */
  description: string;

  /** Supporting data (for rendering charts, tables, etc.) */
  data?: {
    /** Comparison values */
    comparison?: { current: number; average: number; field: string };
    /** Related record references */
    relatedRecords?: Array<{ id: string; schema: string; label: string }>;
    /** Suggested action */
    suggestedAction?: { action: string; input: Record<string, unknown> };
  };
}
```

### 3.3 Analysis Trigger

Analysis is **on-demand**, not automatic. Triggered by:
- User clicks "Analyze" button on record detail page
- User asks AI assistant about the current record
- Explicit API call: `POST /api/ai/analyze-record`

Analysis results are cached per record for 15 minutes (configurable) to avoid redundant AI calls.

### 3.4 Data Gathering

Before calling the AI, the server gathers context:

1. **Current record** — all field values (respecting data masking rules)
2. **Schema metadata** — field definitions, states, rules from OntologyRegistry
3. **Statistical context** — aggregates from same schema (avg amounts, common values, count by status)
4. **Related records** — via Link relationships (e.g., same vendor's other orders)
5. **Execution history** — recent actions on this record (state transitions, who did what)

This context bundle is sent to the AI as a structured prompt. The AI returns structured JSON matching `RecordInsight[]`.

### 3.5 UI: InsightPanel Component

Renders inside the record detail page (collapsible section or side panel):

- Each insight as a card with icon (info/warning/critical), title, description
- Comparison insights show mini bar charts (current vs average)
- Related record insights show clickable links
- Recommendation insights show "Apply" button that triggers ActionProposalCard
- Risk insights show severity badge

---

## 4. AI Data Quality

Background or on-demand scanning of data for quality issues.

### 4.1 Quality Checks

| Check | Description | Implementation |
|-------|-------------|----------------|
| **Completeness** | Required fields that are empty or null | Rule-based (no AI needed) |
| **Consistency** | Values that conflict with related records | Rule-based + AI for fuzzy matching |
| **Outliers** | Statistical outliers (amount 100x average) | Statistical analysis + AI interpretation |
| **Duplicates** | Near-duplicate records | Fuzzy string matching + AI confirmation |
| **Freshness** | Records stuck in state for too long | Rule-based (state duration threshold) |
| **Referential** | Broken references, orphaned records | Link traversal (no AI needed) |

### 4.2 DataQualityReport Interface

```typescript
interface DataQualityReport {
  /** Schema analyzed */
  schemaName: string;

  /** Overall quality score 0-100 */
  score: number;

  /** Individual issues found */
  issues: DataQualityIssue[];

  /** Summary statistics */
  stats: {
    totalRecords: number;
    issueCount: number;
    byType: Record<string, number>;
    bySeverity: Record<string, number>;
  };

  /** When the scan was performed */
  scannedAt: Date;
}

interface DataQualityIssue {
  /** Issue type */
  type: 'completeness' | 'consistency' | 'outlier' | 'duplicate' | 'freshness' | 'referential';

  /** Severity */
  severity: 'low' | 'medium' | 'high';

  /** Affected record(s) */
  recordIds: string[];

  /** Affected field(s) */
  fields?: string[];

  /** Human-readable description */
  description: string;

  /** Suggested fix (if applicable) */
  suggestedFix?: {
    action: string;
    input: Record<string, unknown>;
    description: string;
  };
}
```

### 4.3 Execution Modes

| Mode | Trigger | Scope |
|------|---------|-------|
| **On-demand** | User clicks "Scan" on schema list page | Single schema |
| **Scheduled** | Cron via Flow engine (e.g., nightly) | All schemas or configured subset |
| **Incremental** | After bulk import | Newly imported records only |

### 4.4 UI: DataQualityWidget

Dashboard widget showing per-schema quality scores:

```
┌────────────────────────────────────┐
│  Data Quality                      │
│                                    │
│  purchase_request    ████████░░ 82 │
│  vendor              ██████████ 95 │
│  purchase_item       ██████░░░░ 64 │
│                                    │
│  12 issues found  [View All →]     │
└────────────────────────────────────┘
```

Clicking a schema shows the full `DataQualityReport` with issue list, each issue expandable with "Fix" button.

---

## 5. AI Conversation Context

Make AI conversations context-aware and multi-turn.

### 5.1 Context Layers

```typescript
interface AIConversationContext {
  /** Current session ID (persists across messages in one conversation) */
  sessionId: string;

  /** Page context — what the user is looking at */
  page: {
    route: string;              // e.g., '/schemas/purchase_request/abc123'
    schema?: string;            // 'purchase_request'
    recordId?: string;          // 'abc123'
    viewType?: string;          // 'list' | 'form' | 'dashboard'
    activeFilters?: unknown;    // current list filters
  };

  /** User context — who is asking */
  user: {
    actorId: string;
    roles: string[];
    permissions: string[];      // summarized, not full list
    tenantId?: string;
  };

  /** Conversation history — previous messages in this session */
  history: Array<{
    role: 'user' | 'assistant';
    content: string;
    timestamp: Date;
  }>;

  /** Recent user actions — what the user did recently */
  recentActions?: Array<{
    action: string;
    schema: string;
    timestamp: Date;
  }>;
}
```

### 5.2 Context Window Management

AI models have token limits. Strategy for managing context:

1. **System prompt** (always included): Ontology summary, user permissions, current page context. ~2000 tokens.
2. **Conversation history**: Last N messages, sliding window. Default: last 20 messages or 4000 tokens, whichever is smaller.
3. **Record data** (when on a detail page): Current record field values. ~500-1000 tokens.
4. **Summarization**: When history exceeds window, AI generates a summary of older messages. Summary replaces old messages.

```typescript
interface ContextWindowConfig {
  /** Max tokens for conversation history */
  maxHistoryTokens: number;         // default: 4000

  /** Max messages to keep before summarizing */
  maxHistoryMessages: number;       // default: 20

  /** Max tokens for system prompt (ontology + permissions) */
  maxSystemPromptTokens: number;    // default: 3000

  /** Whether to include record data in context */
  includeRecordData: boolean;       // default: true

  /** Whether to include recent user actions */
  includeRecentActions: boolean;    // default: true
  maxRecentActions: number;         // default: 10
}
```

### 5.3 Session Storage

Sessions are stored in-memory (server-side) with a TTL of 30 minutes (configurable). No database persistence needed — conversations are ephemeral.

```typescript
interface AISession {
  id: string;
  actorId: string;
  tenantId?: string;
  messages: ChatMessage[];
  context: AIConversationContext;
  createdAt: Date;
  lastActiveAt: Date;
  /** Summary of older messages (once history is truncated) */
  historySummary?: string;
}
```

### 5.4 Contextual Prompts

The AI receives different system prompts based on context:

| Context | System Prompt Focus |
|---------|-------------------|
| Schema list view | Schema overview, available actions, filter capabilities |
| Record detail view | Record data, related records, available state transitions |
| Dashboard | Summary statistics, recent activity, pending items |
| Admin pages | System configuration, execution logs, health metrics |

---

## 6. AI Navigation

AI responses include rich, interactive elements — not just plain text.

### 6.1 Rich Message Format

```typescript
interface AIRichMessage {
  /** Plain text content */
  text: string;

  /** Structured blocks embedded in the message */
  blocks?: AIMessageBlock[];
}

type AIMessageBlock =
  | { type: 'action_proposal'; data: IntentResolution }
  | { type: 'record_link'; data: { schema: string; id: string; label: string } }
  | { type: 'record_list'; data: { schema: string; records: Array<{ id: string; label: string; summary?: string }> } }
  | { type: 'data_table'; data: { columns: string[]; rows: unknown[][] } }
  | { type: 'chart'; data: { type: 'bar' | 'line' | 'pie'; labels: string[]; values: number[] } }
  | { type: 'navigation'; data: { url: string; label: string } }
  | { type: 'filter_link'; data: { schema: string; filter: unknown; label: string } }
  | { type: 'insight'; data: RecordInsight };
```

### 6.2 Examples

**Record links:**
```
AI: "I found 3 pending purchase requests over ¥10,000:"

[record_list block]
  - PR-2024-0042: Server equipment — ¥45,000
  - PR-2024-0051: Software licenses — ¥12,500
  - PR-2024-0053: Office furniture — ¥18,000

[filter_link block]
  "View all pending requests → /schemas/purchase_request?status=pending&amount_gte=10000"
```

**Data table:**
```
AI: "Here's the department spending summary for this quarter:"

[data_table block]
  | Department | Spending | Budget | Utilization |
  |------------|----------|--------|-------------|
  | IT         | ¥180,000 | ¥200,000 | 90% |
  | HR         | ¥45,000  | ¥100,000 | 45% |
  | Marketing  | ¥120,000 | ¥80,000  | 150% ⚠ |
```

### 6.3 UI Rendering

The AI chat panel (`AIAssistant` component) renders blocks using existing LinchKit UI components:
- `record_link` → clickable badge that navigates to record detail page
- `record_list` → compact list with click-to-navigate
- `data_table` → TanStack Table (compact mode)
- `chart` → lightweight chart component (Recharts or similar)
- `navigation` → styled link button
- `filter_link` → link that navigates to schema list with pre-applied filters
- `action_proposal` → ActionProposalCard (section 2.3)

### 6.4 AI → GraphQL Query Bridge

When AI needs to answer data questions, it generates GraphQL queries:

```
User: "How many purchase requests are pending approval?"
  ↓
AI generates: query { purchase_requests(where: { status: { eq: "pending_approval" } }) { id } }
  ↓
Server executes query (through user's permission scope)
  ↓
AI formats result: "There are 12 purchase requests pending approval."
  + [filter_link] "View them →"
```

The AI is given the GraphQL schema (auto-generated from EntityDefinition) as context. The generated query is validated and executed server-side. The AI never returns raw GraphQL to the client.

---

## 7. AI Proactive Suggestions

AI monitors patterns and surfaces timely suggestions without user prompting.

### 7.1 Suggestion Types

| Type | Trigger | Example |
|------|---------|---------|
| **Overdue items** | Items stuck in a state beyond SLA | "5 approvals pending > 3 days" |
| **Budget alerts** | Spending approaching or exceeding budget | "Marketing spending at 150% of Q1 budget" |
| **Pattern anomaly** | Unusual data patterns | "Vendor X prices increased 40% vs last order" |
| **Action reminder** | Incomplete workflows | "Draft purchase request not submitted for 7 days" |
| **Optimization** | Repeated user actions that could be automated | "You manually set department on every request — want to auto-fill based on your profile?" |

### 7.2 Suggestion Engine

```typescript
interface ProactiveSuggestion {
  /** Unique suggestion ID */
  id: string;

  /** Suggestion type */
  type: 'overdue' | 'budget' | 'anomaly' | 'reminder' | 'optimization';

  /** Severity determines UI prominence */
  severity: 'info' | 'warning' | 'urgent';

  /** Short title */
  title: string;

  /** Detailed description */
  description: string;

  /** Related schema/record */
  context?: {
    schema?: string;
    recordId?: string;
    url?: string;
  };

  /** Suggested action (if applicable) */
  action?: {
    name: string;
    label: string;
    input?: Record<string, unknown>;
  };

  /** When this suggestion was generated */
  createdAt: Date;

  /** Expiry time — dismiss automatically after this */
  expiresAt?: Date;

  /** Whether user has dismissed/snoozed this suggestion */
  status: 'active' | 'dismissed' | 'snoozed' | 'acted';
}
```

### 7.3 Generation Pipeline

Suggestions are generated via a scheduled Flow (not real-time):

```
Flow: ai_proactive_suggestions (schedule: every 4 hours)
  ↓
  Step 1: Collect metrics — overdue items, budget utilization, recent anomalies
  ↓
  Step 2: AI analysis — pattern detection, severity scoring
  ↓
  Step 3: Deduplicate — don't re-suggest dismissed/snoozed items
  ↓
  Step 4: Store — persist active suggestions
  ↓
  Step 5: Notify — push to UI via GraphQL subscription (if user is online)
```

### 7.4 User Controls

Users can:
- **Dismiss** a suggestion permanently (for that instance)
- **Snooze** a suggestion for N hours/days
- **Mute** a suggestion type entirely ("Stop telling me about overdue approvals")
- **Configure thresholds** per suggestion type ("Only alert me when spending exceeds 120% of budget")

Preferences stored per user:

```typescript
interface AISuggestionPreferences {
  /** Globally enable/disable proactive suggestions */
  enabled: boolean;

  /** Muted suggestion types */
  mutedTypes: string[];

  /** Custom thresholds */
  thresholds?: Record<string, number>;

  /** Quiet hours (no notifications during these periods) */
  quietHours?: { start: string; end: string };
}
```

### 7.5 UI: Suggestion Bell

A notification bell icon in the app header shows active suggestion count. Clicking opens a dropdown list of suggestions, each with:
- Title + severity badge
- Brief description
- Action buttons: "View" / "Dismiss" / "Snooze"

---

## 8. Security Model

### 8.1 Core Security Rules

1. **AI operates as the user.** Every AI action uses the requesting user's actor context. If the user cannot access a schema, AI cannot either.

2. **All writes go through CommandLayer.** AI-generated action calls use the standard `POST /api/actions/:name` endpoint, which runs the full 7-slot middleware pipeline (auth, permission, tenant, etc.).

3. **No privilege escalation.** AI cannot:
   - Access schemas/actions outside user's permission scope
   - Bypass approval workflows
   - Modify system configuration
   - Access other tenants' data

4. **Audit trail.** Every AI interaction is logged:
   ```typescript
   interface AIAuditEntry {
     type: 'intent_resolution' | 'action_execution' | 'record_analysis' | 'data_query' | 'suggestion';
     actorId: string;
     tenantId?: string;
     userMessage?: string;       // original natural language input
     resolvedAction?: string;    // what action was proposed
     executed: boolean;          // whether user confirmed execution
     result?: 'success' | 'failure';
     timestamp: Date;
     sessionId: string;
   }
   ```

5. **Input sanitization.** All user messages pass through `sanitizePrompt()` (existing implementation in `packages/core/src/ai/prompt-sanitizer.ts`) before being sent to the AI model. This defends against prompt injection.

6. **Output validation.** AI-generated action inputs are validated against the action's Zod schema. AI cannot inject invalid data.

### 8.2 Per-Schema AI Configuration

Schema authors can control AI behavior per schema:

```typescript
defineEntity({
  name: 'confidential_report',
  ai: {
    /** Whether AI can read records of this schema (for analysis, context) */
    readable: false,

    /** Whether AI can propose actions on this schema */
    actionable: false,

    /** Whether AI can include this schema in search results */
    searchable: false,

    /** Specific fields to exclude from AI context */
    excludeFields: ['internal_notes', 'salary'],

    /** Custom AI instructions for this schema */
    instructions: 'This schema contains confidential HR data. Never summarize or compare salaries.',
  },
})
```

Default: all schemas are AI-readable and AI-actionable, unless explicitly restricted.

### 8.3 Rate Limiting

AI deep integration endpoints share the existing `AIBoundary` rate limiting (spec 22). Additional limits specific to deep integration:

| Limit | Default | Configurable |
|-------|---------|-------------|
| Intent resolutions per minute per user | 10 | Yes |
| Record analyses per hour per user | 20 | Yes |
| Data quality scans per day per tenant | 5 | Yes |
| Suggestion generation runs per day | 6 | Yes |

### 8.4 Data Masking

When gathering record data for AI context, the existing data masking rules (spec 41b) apply. Masked fields are sent to AI as `"[MASKED]"`. AI is instructed to acknowledge masked fields without attempting to infer their values.

---

## 9. Implementation Architecture

### 9.1 New Modules

```
packages/core/src/ai/
  intent-resolver.ts        — Natural language → IntentResolution
  record-analyzer.ts        — Record context gathering + AI analysis
  data-quality-scanner.ts   — Data quality check orchestration
  suggestion-engine.ts      — Proactive suggestion generation
  conversation-manager.ts   — Session + context window management
  message-formatter.ts      — AIRichMessage construction + block extraction

capabilities/cap-adapter-server/src/
  ai-deep-routes.ts         — New API endpoints for deep integration

capabilities/cap-adapter-ui/src/components/
  action-proposal-card.tsx  — Action confirmation UI
  record-insights.tsx       — Insight panel for record detail
  data-quality-widget.tsx   — Dashboard quality score widget
  rich-message.tsx          — Rich message block renderer
  suggestion-bell.tsx       — Proactive suggestion notification
```

### 9.2 Server API Summary

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/ai/resolve-intent` | POST | Parse natural language → IntentResolution |
| `/api/ai/analyze-record` | POST | Analyze a specific record |
| `/api/ai/data-quality` | POST | Run data quality scan on a schema |
| `/api/ai/suggestions` | GET | Get active suggestions for current user |
| `/api/ai/suggestions/:id/dismiss` | POST | Dismiss a suggestion |
| `/api/ai/suggestions/:id/snooze` | POST | Snooze a suggestion |
| `/api/ai/chat` | POST | Enhanced chat (existing, upgraded with rich messages) |
| `/api/ai/auto-fill` | POST | Existing — no changes |
| `/api/ai/search` | POST | Existing — no changes |

### 9.3 GraphQL Extensions

```graphql
type Subscription {
  # Existing subscriptions ...
  aiSuggestions(userId: ID!): ProactiveSuggestion!
}

type Query {
  aiDataQuality(schemaName: String!): DataQualityReport
  aiSuggestions(status: SuggestionStatus): [ProactiveSuggestion!]!
}

type Mutation {
  aiResolveIntent(message: String!, context: AIContextInput): IntentResolution!
  aiAnalyzeRecord(schemaName: String!, recordId: ID!): RecordAnalysis!
  aiDismissSuggestion(id: ID!): Boolean!
  aiSnoozeSuggestion(id: ID!, duration: Int!): Boolean!
}
```

---

## 10. Implementation Priority

### P1 — Action Execution with Confirmation (M3)

**Goal:** User types natural language → AI proposes action → user confirms → action executes.

Deliverables:
- `intent-resolver.ts` — Intent parsing with OntologyRegistry context
- `POST /api/ai/resolve-intent` endpoint
- `ActionProposalCard` UI component
- Enhanced `AIAssistant` chat to render action proposals
- AI audit logging for intent resolution + execution
- Per-schema AI configuration (`ai.readable`, `ai.actionable`)

**Tests:**
- Intent resolution accuracy (unit tests with fixture prompts)
- Permission scoping (AI cannot propose actions user lacks permission for)
- Input validation (AI-generated input validated against Zod schema)
- Audit trail (every intent resolution logged)

### P2 — Record Analysis + Navigation Links (M3)

**Goal:** AI analyzes records and provides contextual insights with clickable navigation.

Deliverables:
- `record-analyzer.ts` — Context gathering + analysis prompt construction
- `POST /api/ai/analyze-record` endpoint
- `RecordInsights` panel component
- Rich message format (`AIRichMessage` with blocks)
- `RichMessage` renderer in AI chat
- Record links, data tables, filter links in AI responses

**Tests:**
- Analysis with data masking (masked fields not exposed)
- Rich message rendering (all block types)
- Navigation links (correct URL generation)

### P3 — Data Quality + Proactive Suggestions (M4)

**Goal:** Background data quality scanning and proactive AI-driven suggestions.

Deliverables:
- `data-quality-scanner.ts` — Quality check orchestration
- `suggestion-engine.ts` — Suggestion generation pipeline
- `DataQualityWidget` dashboard component
- `SuggestionBell` notification component
- GraphQL subscription for real-time suggestion delivery
- User preference management (mute, snooze, thresholds)
- Scheduled Flow for suggestion generation

**Tests:**
- Quality score calculation
- Suggestion deduplication
- User preference enforcement (muted types not shown)
- Rate limiting for quality scans

---

## 11. Competitive Reference

### 11.1 Odoo AI Assistant

Odoo's AI features (Odoo 17+):
- **AI-powered form filling**: On any form, user clicks "Generate" and AI fills fields based on context and partial input. LinchKit equivalent: existing `ai/auto-fill` + enhanced with intent-based filling.
- **Smart suggestions**: In Many2one fields, AI suggests related records based on context. LinchKit equivalent: ref field AI ranking in search (spec 15 §8.5).
- **Chatter AI**: AI summarizes communication history on records. LinchKit equivalent: `RecordAnalysis` with communication context.
- **What Odoo lacks**: No natural language action execution, no cross-record analysis, no proactive suggestions.

### 11.2 Salesforce Einstein

Salesforce Einstein features relevant to LinchKit:
- **Predictive scoring**: Lead scoring, opportunity scoring based on historical data. LinchKit equivalent: `RecordInsight` with `type: 'risk'` + prediction data. Needs historical data aggregation.
- **Next Best Action**: Recommends actions to users based on context. LinchKit equivalent: `ProactiveSuggestion` with `type: 'optimization'`.
- **Einstein Copilot**: Natural language → CRM actions. Very similar to LinchKit's Intent Resolution model. Key difference: Einstein has a fixed set of "Copilot Actions" while LinchKit auto-discovers actions from OntologyRegistry.
- **What Einstein lacks**: Open/extensible action registry (LinchKit's Capability model is more flexible), self-evolving rules (LinchKit's Proposal flow).

### 11.3 Modern AI Agent Patterns

Patterns from Claude Computer Use, OpenAI Assistants API, and similar:
- **Tool calling**: AI calls functions with structured parameters. LinchKit already has this via `ctx.ai` with Vercel AI SDK tool calling + action-as-tool pattern (spec 36 §8).
- **Confirmation loop**: Agents like Claude Computer Use show proposed actions before executing. LinchKit's `ActionProposalCard` follows this pattern.
- **Context grounding**: Agents work best when given structured context about the current state. LinchKit's `OntologyRegistry.describe()` provides excellent grounding.
- **Key learning**: Auto-execution without confirmation leads to user distrust. Always show intent before executing. Let users build trust incrementally.

### 11.4 Safety Pattern: AI → Action Execution

Best practices from industry:

```
┌─────────────────────────────────────────────────┐
│              AI Safety Ladder                    │
│                                                 │
│  Level 1: Read-only (queries, analysis)         │
│       ↓ User grants AI "read" access            │
│  Level 2: Propose (show what would happen)      │
│       ↓ User confirms individual action          │
│  Level 3: Execute with confirmation              │
│       ↓ User enables auto-execute for safe ops   │
│  Level 4: Auto-execute (read-only queries only)  │
│       ↓ Never: write operations without confirm  │
│  Level 5: ❌ Never reached — always human loop   │
└─────────────────────────────────────────────────┘
```

LinchKit implements Levels 1-4. Level 5 (full autonomy for writes) is explicitly excluded by design.

---

## 12. Open Questions

1. **Token cost management**: Deep integration generates significantly more AI calls than simple chat. Need clear cost visibility per-user and per-tenant. Existing `AIBoundary` budget tracking applies, but UI needs a "my AI usage" dashboard.

2. **Multi-model strategy for intent resolution**: Should intent resolution use a `fast` model (cheaper, lower latency) or `standard` model (more accurate)? Recommendation: start with `standard`, benchmark accuracy, drop to `fast` if accuracy stays above 90%.

3. **Offline / local model support**: For air-gapped deployments, intent resolution should work with local models (via `openai-compatible` provider). Accuracy will be lower — need to adjust confidence thresholds.

4. **AI feature flags**: Should AI deep integration features be individually toggleable? Recommendation: yes, via `linchkit.config.ts`:
   ```typescript
   ai: {
     deepIntegration: {
       intentResolution: true,
       recordAnalysis: true,
       dataQuality: false,        // opt-in
       proactiveSuggestions: false, // opt-in
     }
   }
   ```
