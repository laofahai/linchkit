# ACP (Agent Communication Protocol) — Research Findings

**Task:** linchkit-62e0
**Agent:** builder-acp-report
**Date:** 2026-03-29
**Status:** Research only — no code changes

---

## 1. Protocol Landscape Overview

There are 3 major agent interoperability protocols in the current AI ecosystem, plus an important disambiguation:

| Protocol | Creator | Layer | Purpose | Status |
|----------|---------|-------|---------|--------|
| MCP (Model Context Protocol) | Anthropic | AI Model ↔ Tools/Resources | Connect AI models to external tools, data sources, APIs | v1.0+, widely adopted, de facto standard |
| A2A (Agent-to-Agent Protocol) | Google | Agent ↔ Agent | Peer-to-peer collaboration between autonomous AI agents | Open source, growing adoption, now under Linux Foundation |
| ACP (Agent Communication Protocol) | IBM/BeeAI → Linux Foundation | Application ↔ Agent | REST-based protocol for connecting applications to AI agents | Early stage; **migrating to merge with A2A under Linux Foundation** |

**Critical disambiguation:** ACP and A2A are NOT the same protocol. ACP was created independently by IBM's BeeAI project. It is now converging with A2A under Linux Foundation governance — effectively ACP is being absorbed into the A2A ecosystem rather than remaining a standalone protocol.

---

## 2. ACP Deep Dive

### 2.1 Origin and Governance

ACP was developed by IBM's BeeAI project as an open protocol for agent interoperability under Linux Foundation governance. Its migration guide references "A2A under the Linux Foundation", confirming that the two protocols are merging. Community-driven governance, vendor-neutral.

### 2.2 Core Design Philosophy

- **REST-first**: Uses standard HTTP patterns, no specialized binary protocol or custom transport
- **Framework-agnostic**: Works with BeeAI, LangChain, CrewAI, and custom agent implementations
- **No SDK required**: Plain HTTP calls work; official Python and TypeScript SDKs are optional
- **Minimal specification**: Defines only what's needed for compatibility, does not dictate internals

### 2.3 Data Model

```
Agent
  └── exposes an AgentManifest (capabilities, metadata, supported content types)

Run (single execution)
  ├── status: created | in-progress | awaiting | cancelled | completed | failed
  ├── input: Message[]
  └── output: Message[]

Message
  ├── role: user | agent
  └── parts: MessagePart[]
        ├── type: text/plain | image/* | application/json | audio/* | video/* | ...
        ├── encoding: base64 | utf-8 | ...
        └── metadata: CitationMetadata | TrajectoryMetadata | ...

Session
  └── maintains state and history across multiple runs
```

### 2.4 REST API Endpoints

```
GET  /agents              — list available agents (with pagination)
GET  /agents/{name}       — get agent manifest and metadata
POST /runs                — create and start a new agent run
GET  /runs/{run_id}       — get run status and output
POST /runs/{run_id}       — resume an awaiting run
POST /runs/{run_id}/cancel — cancel active run
GET  /runs/{run_id}/events — stream events from a run
GET  /session/{session_id} — get session details
GET  /ping                 — health check
```

### 2.5 Communication Modes

| Mode | Description | Use Case |
|------|-------------|----------|
| Synchronous | POST /runs returns when complete | Short tasks, simple queries |
| Asynchronous | POST /runs returns immediately, poll GET /runs/{id} | Long-running tasks |
| Streaming | GET /runs/{id}/events via SSE | Real-time progress, partial results |

### 2.6 Key Concepts Unique to ACP

- **Await**: Agent pauses mid-execution to request additional information from caller before resuming
- **Trajectory Metadata**: Tracks reasoning steps and tool executions (useful for explainability)
- **Citation Metadata**: Source attribution with optional text ranges (useful for RAG scenarios)
- **Offline Discovery**: Agents remain discoverable even when not actively running
- **Distributed Sessions**: Session continuity across multiple server instances (via Redis/PostgreSQL)
- **Multimodal by default**: Every message part carries a MIME type — text, images, audio, video, code, JSON are all first-class

### 2.7 SDK Status

| SDK | Status | Notes |
|-----|--------|-------|
| Python | Complete — client + server | Reference implementation; BeeAI framework |
| TypeScript | Client only | "Server implementation coming soon" per docs |

---

## 3. Comparison: ACP vs MCP vs A2A

| Dimension | MCP | ACP | A2A |
|-----------|-----|-----|-----|
| **Creator** | Anthropic | IBM/BeeAI → Linux Foundation | Google → Linux Foundation |
| **Transport** | stdio, HTTP/SSE | REST/HTTP, SSE | HTTP/SSE |
| **Direction** | Model calls tools (client=model, server=tool) | App calls agent (client=app, server=agent) | Agent calls agent (peer-to-peer) |
| **Interaction model** | Request/response with tools | Runs with messages and sessions | Tasks with artifacts |
| **Discovery** | Tool list per server | `/agents` endpoint manifest | Agent Cards (JSON metadata file) |
| **Auth** | Bearer token, OAuth | Bearer token (minimal spec) | OAuth2 (recommended) |
| **Multimodal** | Text-first, resources for binary | Native via MIME types | Artifacts (typed outputs) |
| **Stateful sessions** | No native session concept | Yes, Sessions are first-class | Task persistence |
| **Streaming** | Native (stdio stream / HTTP SSE) | SSE via `/runs/{id}/events` | SSE via task updates |
| **Long-running tasks** | Limited | Native (async mode + Await) | Native (task lifecycle) |
| **TypeScript server SDK** | Mature (`@modelcontextprotocol/sdk`) | Not yet available (client only) | Growing |
| **Ecosystem maturity** | High (AI IDE plugins, Claude, etc.) | Early stage | Medium |
| **LinchKit current** | ✅ Implemented (`cap-adapter-mcp`) | ❌ Not implemented | ❌ Not implemented |

### Key Architectural Distinction

```
MCP model:  [AI Model / Agent] --> (calls tools) --> [MCP Server = LinchKit]
ACP model:  [Application / Orchestrator] --> (runs agents) --> [ACP Server = external agent]
A2A model:  [LinchKit Agent] <--> (collaborates) <--> [External Agent]
```

LinchKit with MCP acts as a **server** (tool provider) that AI models call into.
LinchKit with ACP would act as a **server** (agent provider) that applications or orchestrators call into.
LinchKit with A2A would act as a **peer agent** that collaborates with other agents.

---

## 4. How ACP Fits LinchKit's Capability-as-Adapter Model

### 4.1 Conceptual Fit

LinchKit's transport adapter pattern (`extensions.transports`) is purpose-built for protocols like ACP. The existing `cap-adapter-mcp` provides an ideal reference implementation template:

```typescript
// Hypothetical cap-adapter-acp
export default defineCapability({
  name: 'cap-adapter-acp',
  type: 'adapter',
  category: 'integration',
  version: '0.1.0',
  label: 'ACP Server',
  description: 'Expose LinchKit Actions as ACP Agents',

  extensions: {
    transports: [
      {
        name: 'acp',
        label: 'Agent Communication Protocol',
        factory: createAcpTransport,  // wraps Elysia routes for /agents, /runs
        routes: mountAcpRoutes,
        config: {
          bearerToken: { type: 'string', secret: true },
          port: { type: 'number', default: 8000 },
        },
      },
    ],
  },
})
```

### 4.2 Mapping LinchKit Concepts to ACP

| LinchKit | ACP Equivalent | Notes |
|----------|---------------|-------|
| Action | Agent | Each Action (or group of Actions per Schema) becomes an ACP Agent |
| CommandLayer.execute() | POST /runs | The ACP run invokes CommandLayer internally |
| Actor | Message role="user" | Caller identity passed as ACP message metadata |
| SchemaDefinition | AgentManifest | Schema metadata maps to agent capability description |
| Execution Log | Run lifecycle | ACP run status maps to LinchKit execution tracking |
| Streaming (GraphQL subscriptions) | SSE /runs/{id}/events | Real-time output via existing EventBus |

### 4.3 ACP vs MCP for LinchKit — Which to Prioritize?

**ACP strengths for LinchKit:**
- REST-native: easier for non-AI application integrators (vs stdio-based MCP)
- Multimodal output: LinchKit actions can return structured data, files, rich content
- Session management: aligns with LinchKit's multi-tenant, stateful execution model
- Long-running task support: maps to LinchKit's FlowEngine/Restate durable execution

**ACP weaknesses for LinchKit right now:**
- No TypeScript server SDK: LinchKit would need to implement the REST layer from OpenAPI spec directly
- Protocol is merging with A2A: implementing ACP today may require re-work as the convergence completes
- Ecosystem maturity: much smaller tooling ecosystem vs MCP (no IDE plugins, no native Claude support)
- Spec stability: unclear how the ACP→A2A migration affects existing API contracts

### 4.4 Recommendation

| Priority | Action | Rationale |
|----------|--------|-----------|
| **Short-term** | Monitor ACP/A2A convergence | Protocol is in flux; implementing now risks churn |
| **Medium-term** | Implement `cap-adapter-a2a` | A2A has Google backing + growing ecosystem + stable TypeScript SDKs |
| **Medium-term** | Implement `cap-adapter-acp` | REST-native makes it accessible for non-AI integrators; implement from OpenAPI spec |
| **Long-term** | Unify ACP+A2A into single adapter | If Linux Foundation completes the merger, a single `cap-adapter-agent-protocol` |

---

## 5. Implementation Feasibility Assessment

### 5.1 What Would `cap-adapter-acp` Need to Build

Since there is no TypeScript server SDK, implementation would use Elysia (already in use for `cap-adapter-server`) to expose ACP-compliant REST endpoints:

1. **`GET /agents`** — enumerate LinchKit Actions (filtered by `exposure.acp !== false`)
2. **`GET /agents/{name}`** — return AgentManifest built from ActionDefinition + SchemaDefinition
3. **`POST /runs`** — create a Run, invoke CommandLayer, return run ID
4. **`GET /runs/{run_id}`** — return Run status from ExecutionLog
5. **`GET /runs/{run_id}/events`** — SSE stream using existing PersistentEventBus

### 5.2 Effort Estimate (High Level)

| Component | Effort | Dependency |
|-----------|--------|------------|
| ACP REST routes (Elysia) | Medium | `cap-adapter-server` pattern |
| AgentManifest generation from SchemaDefinition | Low | Existing SchemaRegistry/OntologyRegistry |
| Run lifecycle (create/poll/cancel) | Medium | ExecutionLog (already exists) |
| SSE streaming | Low | PersistentEventBus (already exists) |
| Session management | High | New concept, no existing LinchKit equivalent |
| Auth (Bearer) | Low | Same pattern as MCP |
| Tests | Medium | Follow existing adapter test patterns |

### 5.3 Blockers and Open Questions

1. **TypeScript server SDK**: Must implement from OpenAPI spec directly or wait for SDK
2. **ACP→A2A merger timeline**: Unknown — may make current ACP spec obsolete
3. **Session semantics**: LinchKit has no first-class Session concept today (would need new capability or core addition)
4. **Action vs Agent cardinality**: Should one LinchKit Action = one ACP Agent, or one Schema = one Agent with multiple "tools"?

---

## 6. Summary and Recommended Next Steps

### What ACP Is
ACP is an IBM/BeeAI-originated, Linux Foundation-governed REST protocol for application-to-agent communication. It is currently in a transitional state, merging with Google's A2A protocol under Linux Foundation governance.

### Key Findings
1. ACP is REST-native and multimodal — a good fit for LinchKit's HTTP/Elysia stack
2. TypeScript server SDK does not yet exist — direct OpenAPI implementation required
3. ACP is converging with A2A; implementing ACP in isolation carries rework risk
4. LinchKit's `extensions.transports` pattern cleanly supports ACP with no core changes
5. The most valuable unique ACP features for LinchKit are: multimodal output, session continuity, and Await (mid-run pause for human-in-the-loop)

### Recommended Next Steps (for lead-acp-research)
1. **Decision needed**: Implement ACP standalone, implement A2A, or wait for merger completion
2. **If proceeding with ACP**: Start with a minimal Elysia implementation of `/agents` + `/runs` (no sessions); port to TypeScript server SDK when available
3. **Parallel track**: Evaluate `cap-adapter-a2a` since A2A has better TypeScript ecosystem maturity and is the likely survivor of the ACP/A2A convergence
4. **Monitor**: Track https://agentcommunicationprotocol.dev changelog and Linux Foundation A2A working group for merger progress

---

## References

- ACP spec and docs: https://agentcommunicationprotocol.dev
- ACP GitHub (i-am-bee): https://github.com/i-am-bee/acp
- ACP OpenAPI spec: https://github.com/i-am-bee/acp/blob/main/docs/spec/openapi.yaml
- LinchKit MCP adapter (reference implementation): `capabilities/cap-adapter-mcp/`
- LinchKit transport adapter pattern: `docs/specs/20_extension_mechanism.md §8.5`
- LinchKit capability adapter types: `docs/specs/01_capability_structure.md §7.2`
