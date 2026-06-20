# LinchKit Spec Index

> 74 specs grouped by domain. Format: `[number] Title — one-line summary (milestone, status)`.
> **Status legend**: `Done` = implemented and tested, `Partial` = core done / details pending, `Draft` = spec only, not implemented, `Deprecated` = superseded by newer spec.
> **How to use**: Scan this index to locate relevant specs. Read specs on-demand by domain — do not read them all at once.

---

## Vision & Foundation

| # | Title | Summary | Milestone | Status |
|---|-------|---------|-----------|--------|
| [00](./00_tech_stack.md) | Tech Stack | Bun, Elysia, Drizzle, React 19, graphql-yoga, Restate — full-stack tech choices | M0 | Done |
| [00a](./00a_product_vision.md) | Product Vision | §0 = locked identity: governance & evolution substrate (intent-bound, human-gated, provable); honest 浪漫/内核 split. Original "let there be light" narrative kept below as north-star | — | Draft |
| [72](./72_procurement_north_star_scenario.md) | Procurement North-Star Scenario | One real procurement-approval story (cap-purchase-demo) composing rule-in-action enforcement, governance, graduation PR, and AI tracing; acceptance bar = live multi-channel walkthroughs (browser/REST/MCP/AI assistant) with role-gated blocks and all AI calls visible in `/admin/ai-traces` — not green tests | M6–M7 | Draft |

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
| [64](./64_entity_onchange.md) | Entity Onchange | Server-side form computation — interactive pre-save field updates via `onchange` hooks on Entity | M5 | Done |

## Meta-Model — Life System

Five-layer evolution model (Sense → Memory → Awareness → Insight → Proposal).

| # | Title | Summary | Milestone | Status |
|---|-------|---------|-----------|--------|
| [55](./55_evolution_system.md) | Evolution System | Living software: sensors, baselines, importance graph, evidence-chain insights, gradual Proposals. §7.7 G5 code materialization implemented (CodeGenerationProvider + materializeProposalChanges + Phase-2 build gate + Phase-4 contract check + live `POST /api/proposals/:id/materialize`); sensing/cadence still gated | M3–M6+ | Partial |
| [70](./70_execution_dry_run_sandbox.md) | Execution Dry-Run Sandbox | Run AI-generated handler source in a locked-down sandbox as an opt-in, infra-gated validation Phase 5 — the execution counterpart to Spec 55 §7.7's static Phase 4. Fully implemented P2–P5: core seam + durable `dryRunStatus` + sync `validatePhase5` (#523), hardened Bun-subprocess runner (#524) wired into materialize (#526), forbidden-op kinds + UI (#529), `strictExecutionDryRun` opt-in block gate (#530), gVisor microVM tier + `prlimit` memory rlimit (#531) | M6–M7+ | Done |

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
| [65](./65_execution_context.md) | Execution Context | `ExecutionMeta` — immutable metadata propagation through Action→EventHandler→nested Action chain | M5 | Done |
| [40](./40_rule_execute_action_boundary.md) | Rule-Action Boundary | When rules trigger Actions vs passive checks | M1 | Done |
| [45](./45_reactive_automation.md) | Data-Condition Watcher | `defineWatcher()` — threshold / staleness / set_change / schedule triggers; WatcherEngine fires effects through CommandLayer. Complement to EventHandler, not a replacement. | M5 | Partial |
| [59](./59_runtime_overlay.md) | Runtime Overlay | Additive runtime entity changes (field add, enum extend) via ProposalEngine, promotion to code | M3 | Done |

## Capability System

Capability definition, extension, composition, and distribution.

| # | Title | Summary | Milestone | Status |
|---|-------|---------|-----------|--------|
| [01](./01_capability_structure.md) | Capability Structure | `defineCapability()` — standard/adapter/bridge types, lifecycle, dependencies | M0 | Done |
| [14](./14_system_capabilities.md) | System Capabilities | Built-in capabilities (auth, permission, MCP, UI), cold-start packs | M0 | Partial |
| [20](./20_extension_mechanism.md) | Extension Mechanism | `extensions` — schemas/actions/rules/views/middlewares/transports/fieldTypes/services/hooks | M0 | Done |
| [21](./21_capability_ecosystem.md) | Capability Ecosystem | Capability lifecycle, publishing, version management, compatibility matrix. Implemented: §7.2 runtime-honored standalone `capability.json`, §9.1 `linch lint-capability` quality checks, §10.1 `coreVersion` compatibility declaration + consistency. Pending: Hub (21b) + `@linchkit/starter-*` bundles | M1 | Partial |
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
| [63](./63_field_immutability_and_locking.md) | Field Immutability & Locking | Immutable fields, state-driven conditional locks, core enforcement + cap-lock capability | M5 | Partial |
| [66](./66_event_lifecycle_management.md) | Event Lifecycle Management | Event deduplication, archival/retention (hot/warm/cold), replay tooling, execution log governance | M5–M7 | Draft |

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
| [69](./69_ai_evaluation_framework.md) | AI Evaluation Framework | Cross-scenario prompt-quality regression + cost-governed live evals; fixture schema, matcher catalog, BAML/Mastra decision matrices | M5–M7 | Draft |
| [71](./71_agui_hitl_governance.md) | AG-UI HITL Governance | Native protocol-governed assistant write path: model proposes a runtime-data mutation mid-run → `RUN_FINISHED` interrupt outcome → existing `ActionProposalCard` → human approve → CommandLayer execute → `resume[]` finishes the run. Unifies the two parallel write paths (stream + `resolveIntent` side channel) into one AG-UI stream; dismantles the side channel. Distinct from Spec 55's code-graduation ProposalEngine | M6–M7+ | Draft |

## Frontend & Views

| # | Title | Summary | Milestone | Status |
|---|-------|---------|-----------|--------|
| [13](./13_view_and_ui.md) | Views & UI | `defineView()` — AutoList, AutoForm, Widget registry, SearchBar, state colors | M0 | Done |
| [44](./44_realtime_subscription.md) | Realtime Subscription | GraphQL SSE subscriptions, PersistentEventBus integration, per-entity change streams | M2/M5 | Done |
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
| [56](./56_core_slimming.md) | Core Slimming | Phase 1 file extraction done (#249); Phase 2 Step 2a life-system abstractions done (#255); Step 2b AI helpers consolidated to cap-ai-provider (#257); Step 2c Detector/Watcher impl move pending | M3 | Partial |

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
| [67](./67_meta_model_semantics.md) | Meta-Model Semantics | `MetaSemantics` on every defineXxx() — intent/domain/summary/tags + per-type extensions (rule regulation+riskLevel, action scope, etc.) + structural inference; consumed by evolution, NL→defineXxx, conflict detection | M5–M6 | Partial |

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
| AI features | 36, 15, 22, 27, 52, 60, 69 |
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
| Done | 52 |
| Partial | 13 |
| Draft | 9 |
| **Total** | **74** unique specs |

### Change Log

| Date | Change |
|------|--------|
| 2026-06-11 | Added Spec 72 (Procurement North-Star Scenario — Draft) — ONE real product story every capability must serve: operator says "以后采购超过1万才走经理审批" → governed rule-change proposal → human approval → graduation PR → post-merge enforcement verified live from every channel (browser UI / REST / MCP / AI assistant), with all AI calls visible in `/admin/ai-traces`. Acceptance bar = live multi-channel walkthroughs, not green tests. Phase 1 (threshold-as-rule + spoof-proof `record` rule seam) ships with this spec. Stats: Total 74→75, Draft 9→10. |
| 2026-06-10 | Added Spec 71 (AG-UI HITL Governance — Draft) — make the assistant's write path natively governed through AG-UI's interrupt/resume protocol (`@ag-ui/core@0.0.56`): model proposes a runtime-data mutation mid-run → `RUN_FINISHED` interrupt outcome → existing `ActionProposalCard` → human approve → CommandLayer execute → `resume[]` finishes the run. Unifies the two parallel write paths (AG-UI stream + the `resolveIntent`→`ActionProposalCard` side channel that bypasses the stream) into ONE stream path; P4 dismantles the side channel. Distinct from Spec 55's code-graduation ProposalEngine (naming-collision trap called out). Stats: Total 73→74, Draft 8→9. |
| 2026-06-10 | Spec 70 **COMPLETE — Draft→Done** (Stats: Done 51→52, Draft 9→8). P3 subprocess sandbox runner `@linchkit/cap-dry-run` (#524) wired into the materialize path behind `LINCHKIT_EXECUTION_DRY_RUN=1` (#526); P4 forbidden-op kind inference + `DryRunOutcomesPanel` UI (#529); P5 `features.strictExecutionDryRun` opt-in block gate — never derived from `isProduction` (#530) + gVisor microVM runner tier (`runner: "subprocess" \| "microvm"`, fail-closed, `docker run --runtime=runsc`) + Linux `prlimit --data` OS memory rlimit (#531). microvm tier is argv-verified; validate on a real gVisor host before production reliance. |
| 2026-06-09 | Spec 70 **P2 landed** + §5/§7 refined to the **durable-signal** architecture: the async dry-run runs in the (already-async) materialize path and stamps a durable `dryRunStatus`; validation **Phase 5 is synchronous** and only reads it (mirrors Phase 4 reading `materializationStatus`), so `validateProposal`/`submitProposal` stay sync. P2 ships core `dry-run.ts` types + `ExecutionDryRunProvider` seam + `ProposalChange.dryRunStatus`/`dryRunOutcomes` + `ValidationPhase`→`1–5` + `validatePhase5`. |
| 2026-06-09 | Added Spec 70 (Execution Dry-Run Sandbox — Draft) — designs the deferred execution counterpart to Spec 55 §7.7's static Phase 4: run AI-generated handler source in a hardened Bun-subprocess sandbox as an opt-in, infra-gated validation Phase 5. Threat model + sandbox tech comparison + phased rollout. Stats: Total 72→73, Draft +1. |
| 2026-06-07 | Spec 55 §7.7 代码物化 added — G5 materialization (provider #494, materializer+build-gate #495, live endpoint+UI #496) documented; old §7.7 反馈回路 renumbered to §7.8. |
| 2026-06-01 | Spec 45 progress: `schedule` trigger implemented (croner, PR #439) + `_linchkit.watcher_state` debounce persistence (`WatcherStateStore` InMemory default + Drizzle PG backend) — restart-safe `once_until_reset`. Status stays Partial: the watcher admin UI `EntityDefinition` (§7.1) is still deferred. |
| 2026-06-01 | Spec 63 Phase 2 shipped: GraphQL field-lock introspection (PR #437) + auto-form field-lock UI reusing core's `matchesLockCondition` (PR #441). Status stays Partial — Phase 3 `cap-lock` needs a returning-value hook/slot extension mechanism (design decision) before it can be built. |
| 2026-06-01 | Spec 56 Step 2c complete: removed the dead 0-byte `automation-engine`/`automation-registry` stubs from core (PR #436); the Detector/Watcher implementations already live in cap-ai-provider. |
| 2026-05-19 | Spec 69 Phase 2 closed: Phase 2b hands-on BAML spike (PR #356) measured zero strict-pass improvement + zero parser rescues → REJECT (#357). All 3 candidates rejected; keep in-house Vercel AI SDK + Zod pipeline. §10.5 + §11 + baml-evaluation.md §6 updated with measured cells. |
| 2026-05-19 | Spec 69 Phase 2a (tool decision documentation review): rejected `@mastra/evals` + Promptfoo on structural grounds; BAML proceeds to Phase 2b hands-on spike; added research docs `docs/research/baml-evaluation.md` + `docs/research/promptfoo-evaluation.md`; §10 sub-sections renumbered. |
| 2026-05-18 | Added Spec 69 (AI Evaluation Framework — Draft); companion research doc `docs/research/mastra-evaluation.md`; Stats updated: Draft 7→8, Total 71→72 |
| 2026-05-16 | Added Spec 67 (Meta-Model Semantics — Partial; Phase 1 types + structural inference + OntologyRegistry semantic API landed via PR #308); Stats updated: Partial 12→13, Total 70→71 |
| 2026-05-11 | Added Spec 66 (Event Lifecycle Management — Draft); Stats updated: Draft 6→7, Total 69→70 |
| 2026-05-08 | Spec 45 rewritten: title "Reactive Automation" → "Data-Condition Watcher"; AutomationEngine sections dropped (removed in PR #146); spec now scoped to `defineWatcher` only (issue #150) |
| 2026-05-07 | Spec 64 Draft→Done (M5 core+API+GraphQL via #191/#198/#206; M6 frontend via #235; issues #148/#207 closed) |
| 2026-05-07 | Spec 65 Draft→Done (Phase 1 #201, transports/log #213, idempotency #227, MCP §3.3 #231, CLI §3.5 #232, rule §6 #233, EventHandler §7 #229, masked keys #220; all Spec 65 issues closed) |
| 2026-05-07 | Spec 63 Draft→Partial (Phase 1 core enforcement done via #203 #202 #253; Phase 2 UI integration + GraphQL field introspection NOT yet shipped; Phase 3 cap-lock capability not built) |
| 2026-05-07 | Spec 44 Partial→Done (#136 SSE event push closed via #178 Last-Event-ID reconnection replay; record-level filtering + tenant isolation in SubscriptionManager) |
| 2026-05-07 | Spec 56 Partial note updated: Phase 1 file extraction done (#249); Phase 2 Step 2a life-system abstractions done (#255); Step 2b partial — AI helpers consolidated (#257), but PatternDetector/AnomalyDetector/WatcherEngine impls (Step 2c) still in core |
| 2026-05-07 | Stats updated: Done 48→51, Draft 9→6, Partial unchanged (12) |
| 2026-04-10 | Audit fix: Spec 44 Done→Partial (issue #136 SSE event push still open); Spec 45 milestone M3→M5 (issue #150), Spec 61 milestone M3→M5 (issue #87); Stats updated (Done 49→48, Partial 11→12) |
| 2026-04-10 | Spec 61 → Done (old field type refs cleaned); Spec 56 → Partial (Phase 1 AI exports removed from core) |
| 2026-04-09 | Expanded spec 10 (Permission Groups planned API), spec 28 (Observability PII/trace fixes), added spec 63 content (Field Immutability & Locking) |
| 2026-04-09 | Added specs 64 (Entity Onchange), 65 (Execution Context); updated spec 45 (AutomationEngine removed, Watcher remains) |
| 2026-04-09 | Added spec 62 (AI Proposal Data Migration) |
| 2026-04-08 | Full audit: aligned all statuses with codebase reality; added specs 59 & 60 |