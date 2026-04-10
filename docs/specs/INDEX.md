# LinchKit Spec Index

> 69 specs grouped by domain. Format: `[number] Title — one-line summary (milestone, status)`.
> **Status legend**: `Done` = implemented and tested, `Partial` = core done / details pending, `Draft` = spec only, not implemented, `Deprecated` = superseded by newer spec.
> **How to use**: Scan this index to locate relevant specs. Read specs on-demand by domain — do not read them all at once.

---

## Vision & Foundation

| # | Title | Summary | Milestone | Status |
|---|-------|---------|-----------|--------|
| [00](./00_tech_stack.md) | Tech Stack | Bun, Elysia, Drizzle, React 19, graphql-yoga, Restate — full-stack tech choices | M0 | Done |
| [00a](./00a_product_vision.md) | Product Vision | "User says, let there be light" — system grows from usage, five-layer life system | — | Draft |

## Meta-Model — Skeleton

LinchKit's 9 first-class building blocks.

| # | Title | Summary | Milestone | Status |
|---|-------|---------|-----------|--------|
| [03](./03_schema.md) | Entity | `defineEntity()` — field definitions, system fields, display config, usage | M0 | Done |
| [04](./04_action.md) | Action | `defineAction()` — CRUD + custom ops, handler, throttle, idempotency | M0 | Done |
| [05](./05_rule.md) | Rule | `defineRule()` — validation/gate/side-effect/approval, condition expressions, priority | M0 | Done |
| [06](./06_state.md) | State | `defineState()` — state machine, transitions, guards | M0 | Done |
| [07](./07_event.md) | Event | `defineEvent()` — domain events, naming conventions, payload definition | M0 | Done |
| [08](./08_event_handler_and_queue.md) | EventHandler & Queue | `defineEventHandler()` — sync/async, retry, dead letter, ordering guarantee | M0 | Done |
| [46](./46_link_type.md) | Relation Type | `defineRelation()` — relations as first-class citizens, FK/junction tables, bidirectional nav | M2 | Done |
| [61](./61_semantic_relation_unification.md) | Semantic Relation Unification | Unify ref/has_many/defineRelation into semantic defineRelation with fromName/toName | M5 | Done |
| [47](./47_schema_interface.md) | Entity Interface | InterfaceRegistry + `implements` — reusable field contracts, compliance checks | M2 | Done |
| [48](./48_derived_properties.md) | Derived Properties | `derived` config for computed fields, evaluated at query time | M2 | Done |
| [49](./49_schema_inheritance.md) | Entity Inheritance | Single-parent `extends`, field/Action/Rule/State inheritance chain | M2 | Done |
| [64](./64_entity_onchange.md) | Entity Onchange | Server-side form computation — interactive pre-save field updates via `onchange` hooks on Entity | M5 | Draft |

## Meta-Model — Life System

Five-layer evolution model (Sense → Memory → Awareness → Insight → Proposal).

| # | Title | Summary | Milestone | Status |
|---|-------|---------|-----------|--------|
| [55](./55_evolution_system.md) | Evolution System | Living software: sensors, baselines, importance graph, evidence-chain insights, gradual Proposals | M3–M6+ | Partial |

## Runtime Engines

How the meta-model executes at runtime.

| # | Title | Summary | Milestone | Status |
|---|-------|---------|-----------|--------|
| [02](./02_runtime_change.md) | Runtime Changes | Three-layer source of truth (design/deploy/runtime), tenant overrides | M0 | Done |
| [09](./09_proposal_validation_version.md) | Proposal & Validation | Proposal governance pipeline (draft→validated→approved→committed→deployed), 4-stage validation | M0 | Done |
| [16](./16_command_layer_and_api.md) | CommandLayer & API | 7-slot middleware pipeline, REST `/api/*`, GraphQL `/graphql`, error mapping | M0 | Done |
| [23](./23_rule_engine_and_flow.md) | Rule Engine & Flow | Rule evaluation order, Flow engine (Restate), step types, Saga compensation | M1 | Done |
| [26](./26_transaction_model.md) | Transaction Model | Action-level transactions, Flow-level Saga pattern, compensation | M1 | Partial |
| [32](./32_state_machine_implementation.md) | State Machine Impl | Transition validation, guard evaluation, auto-transitions, history records | M0 | Done |
| [39](./39_execution_contract.md) | Execution Contract | Input/output contracts, execution lifecycle, idempotency, parent-child executions | M0 | Done |
| [65](./65_execution_context.md) | Execution Context | `ExecutionMeta` — immutable metadata propagation through Action→EventHandler→nested Action chain | M5 | Draft |
| [40](./40_rule_execute_action_boundary.md) | Rule-Action Boundary | When rules trigger Actions vs passive checks | M1 | Done |
| [45](./45_reactive_automation.md) | Reactive Automation | `defineWatcher()` — data-condition triggers (threshold/staleness/set_change/schedule). AutomationEngine removed; WatcherEngine evaluates conditions via EventBus and executes effects through CommandLayer. | M5 | Partial |
| [59](./59_runtime_overlay.md) | Runtime Overlay | Additive runtime entity changes (field add, enum extend) via ProposalEngine, promotion to code | M3 | Done |

## Capability System

Capability definition, extension, composition, and distribution.

| # | Title | Summary | Milestone | Status |
|---|-------|---------|-----------|--------|
| [01](./01_capability_structure.md) | Capability Structure | `defineCapability()` — standard/adapter/bridge types, lifecycle, dependencies | M0 | Done |
| [14](./14_system_capabilities.md) | System Capabilities | Built-in capabilities (auth, permission, MCP, UI), cold-start packs | M0 | Partial |
| [20](./20_extension_mechanism.md) | Extension Mechanism | `extensions` — schemas/actions/rules/views/middlewares/transports/fieldTypes/services/hooks | M0 | Done |
| [21](./21_capability_ecosystem.md) | Capability Ecosystem | Capability lifecycle, publishing, version management, compatibility matrix | M1 | Partial |
| [21b](./21_capability_hub.md) | Capability Hub | Discovery, registration, installation, dependency resolution | M2+ | Draft |
| [57](./57_addon_architecture.md) | Addon Architecture | OCA pattern — addons/ grouping, autoInstall, graphqlExtensions, Panel registration | M2 | Done |

## Configuration

| # | Title | Summary | Milestone | Status |
|---|-------|---------|-----------|--------|
| [42](./42_config_center.md) | Config Center | Static config (linchkit.config.ts + Zod) + runtime config registry + define-config-schema | M0a/M1 | Done |

## Data, Storage & Multi-Tenancy

| # | Title | Summary | Milestone | Status |
|---|-------|---------|-----------|--------|
| [11](./11_execution_log.md) | Execution Log | ExecutionLogger interface, in-memory + Drizzle backends, audit chain | M0 | Done |
| [30](./30_multi_tenancy.md) | Multi-Tenancy | tenant_id isolation, row-level security, tenant config overrides | M0 | Done |
| [34](./34_cache_strategy.md) | Cache Strategy | CacheManager, in-memory cache, PostgreSQL invalidation, TTL, tenant isolation | M1 | Done |
| [41a](./41_data_security_and_masking.md) | Data Security & Masking | Field-level masking rules, MaskingEngine, permission-based display | M1 | Done |
| [51](./51_data_i18n.md) | Data i18n | JSONB translation storage, shared i18n package, messageKey API (supersedes spec 41 i18n) | M1 | Done |
| [63](./63_field_immutability_and_locking.md) | Field Immutability & Locking | Immutable fields, state-driven conditional locks, core enforcement + cap-lock capability | M5 | Draft |

> **Note**: `41_data_i18n.md` is deprecated, superseded by `51_data_i18n.md` — do not implement based on 41.

## AI

| # | Title | Summary | Milestone | Status |
|---|-------|---------|-----------|--------|
| [15](./15_ai_developer_experience.md) | AI Developer Experience | Builder/Evolver Agent, MCP tools, AI-assisted Capability development | M1 | Partial |
| [22](./22_ai_rule_boundary.md) | AI-Rule Boundary | AI boundary enforcement, guardrails, human-in-the-loop requirements | M1 | Done |
| [27](./27_ai_security.md) | AI Security | Prompt injection defense, output validation, audit chain, rate limiting | M1 | Done |
| [36](./36_ai_service.md) | AI Service Layer | `ctx.ai.complete()` — multi-provider, model aliases, cost control, BYOK, Vercel AI SDK | M1 | Done |
| [52](./52_ai_deep_integration.md) | AI Deep Integration | AI as primary interface — NL → defineXxx(), intent parsing, conversational Flow | M2+ | Draft |
| [58](./58_mcp_client_registry.md) | MCP Client Registry | AI Agent access management — client registration, per-client auth, tool visibility, management UI | M2 | Done |
| [60](./60_ai_workspace.md) | AI Workspace | Two-layer AI architecture (dev-time + runtime), AGENTS.md generation, MCP integration | M3 | Partial |

## Frontend & Views

| # | Title | Summary | Milestone | Status |
|---|-------|---------|-----------|--------|
| [13](./13_view_and_ui.md) | Views & UI | `defineView()` — AutoList, AutoForm, Widget registry, SearchBar, state colors | M0 | Done |
| [44](./44_realtime_subscription.md) | Realtime Subscription | GraphQL SSE subscriptions, PersistentEventBus integration, per-entity change streams | M2/M5 | Partial |
| [53](./53_chatter_and_collaboration.md) | Unified Record Timeline | Chatter — field audit + execution log + comments + AI conversation unified timeline (Capability) | M3 | Done |
| [54](./54_advanced_ui_features.md) | Advanced UI Features | Kanban, calendar, timeline views, drag-and-drop, dashboard builder | M2+ | Partial |

## Authentication & Permission

| # | Title | Summary | Milestone | Status |
|---|-------|---------|-----------|--------|
| [10](./10_actor_permission.md) | Actor & Permission | Actor model, RBAC, permission groups, field-level control, CommandLayer integration | M0 | Done |
| [10a](./10a_authentication.md) | Authentication | Better Auth Provider, JWT, sessions, OAuth, multi-tenant auth | M0 | Done |
| [35](./35_approval_mechanism.md) | Approval Mechanism | ApprovalEngine, multi-level approval, timeout policies, permission integration | M1 | Done |

## Observability & Quality

| # | Title | Summary | Milestone | Status |
|---|-------|---------|-----------|--------|
| [28](./28_observability.md) | Observability | Structured logging, metrics, trace context, alert engine, health checks | M1 | Done |
| [33](./33_error_handling.md) | Error Handling | 7 error types → HTTP status codes, LinchKitError hierarchy, error codes | M0 | Done |
| [18](./18_testing.md) | Testing | bun test, test toolkit, fixture helpers, Capability test mode | M0 | Done |
| [31](./31_code_quality.md) | Code Quality | Biome, TypeScript strict, commit conventions, pre-commit hooks | M0 | Done |

## Governance & Process

| # | Title | Summary | Milestone | Status |
|---|-------|---------|-----------|--------|
| [25](./25_documentation.md) | Documentation | Auto-generated API docs, Entity docs, Capability docs | M1 | Draft |
| [29](./29_methodology_and_sop.md) | Methodology & SOP | Development methodology, Capability dev SOP, release process | M0 | Done |
| [37](./37_documentation_governance.md) | Documentation Governance | Documentation standards, review process, versioned lifecycle | M1 | Draft |
| [38](./38_release_compatibility.md) | Release Compatibility | Semantic versioning rules, migration guides, breaking change strategy | M1 | Partial |
| [56](./56_core_slimming.md) | Core Slimming | Three-party audit consensus: ~17 files safe to extract, life-system engines stay in core, interface+impl split | M3 | Partial |

## Deployment & Migration

| # | Title | Summary | Milestone | Status |
|---|-------|---------|-----------|--------|
| [12](./12_deployment.md) | Deployment | Deployment strategy, environment config, health checks, graceful shutdown | M1 | Partial |
| [17](./17_legacy_system_migration.md) | Legacy System Migration | Data import, progressive migration, entity mapping, version registry (cap-migration) | M2+ | Done |
| [62](./62_ai_proposal_migration.md) | AI Proposal Data Migration | AI Proposal → migration detection, plan generation, safety validation, governed execution | M7+ | Draft |

## Semantic Layer

| # | Title | Summary | Milestone | Status |
|---|-------|---------|-----------|--------|
| [24](./24_relation_graph.md) | Relation Graph | Entity relation visualization, semantic inference, impact analysis, mermaid export | M2 | Done |
| [43](./43_ontology_layer.md) | Ontology Layer | OntologyRegistry — unified read-only facade, describe(), searchEntities(), toJSON() | M2 | Done |

## Initialization

| # | Title | Summary | Milestone | Status |
|---|-------|---------|-----------|--------|
| [19](./19_initialization.md) | Initialization | `linch init` mode (bare/minimal/pack), boot sequence, admin creation | M0 | Done |

## Milestones

| # | Title | Summary | Milestone | Status |
|---|-------|---------|-----------|--------|
| [50](./50_milestone_m1_plan.md) | M1 Plan | M1 scope, deliverables, task breakdown | M1 | Done |

---

## File Naming Notes

- `21_capability_hub.md` is labeled **21b** in this index (Hub is a sub-topic of Ecosystem)
- `41_data_i18n.md` is **deprecated**, superseded by `51_data_i18n.md` — do not implement based on 41
- `41_data_security_and_masking.md` is labeled **41a** in this index (to distinguish from 41 i18n)

## Quick Lookup: Find Specs by Task

| What you want to do | Specs to read |
|---------------------|---------------|
| Develop a new Capability | 01, 20, 42, 39, 04, 57 |
| Entity/field changes | 03, 46, 47, 48, 49, 59, 64 |
| Rules & automation | 05, 23, 40, 45, 65 |
| API/GraphQL changes | 16, 44 |
| UI component development | 13, 54 |
| AI features | 36, 15, 22, 27, 52, 60 |
| Auth/permission | 10, 10a, 35 |
| Multi-tenancy | 30, 42 |
| Evolution system | 00a, 55, 62 |
| Core slimming/module split | 56, 01, 20 |
| Chatter/record timeline/audit | 53, 11 |
| Data security | 41a, 30 |
| Testing | 18, 31 |
| Deployment | 12, 19 |
| MCP / AI agent access | 58, 60 |
| Runtime overlay | 59, 09 |
| Legacy migration | 17, 62 |

## Statistics

| Status | Count |
|--------|-------|
| Done | 48 |
| Partial | 12 |
| Draft | 9 |
| **Total** | **69** unique specs |

### Change Log

| Date | Change |
|------|--------|
| 2026-04-10 | Audit fix: Spec 44 Done→Partial (issue #136 SSE event push still open); Spec 45 milestone M3→M5, Spec 61 milestone M3→M5 (match GitHub issue milestones); Stats updated (Done 49→48, Partial 11→12) |
| 2026-04-10 | Spec 61 → Done (old field type refs cleaned); Spec 56 → Partial (Phase 1 AI exports removed from core) |
| 2026-04-09 | Expanded spec 10 (Permission Groups planned API), spec 28 (Observability PII/trace fixes), added spec 63 content (Field Immutability & Locking) |
| 2026-04-09 | Added specs 64 (Entity Onchange), 65 (Execution Context); updated spec 45 (AutomationEngine removed, Watcher remains) |
| 2026-04-09 | Added spec 62 (AI Proposal Data Migration) |
| 2026-04-08 | Full audit: aligned all statuses with codebase reality; added specs 59 & 60 |
