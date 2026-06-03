---
"@linchkit/core": minor
"@linchkit/cap-adapter-server": minor
"@linchkit/cli": patch
---

feat(core): wire require_approval + record-state into rule evaluation (Spec 23 §1.1, phase 2)

Builds on the phase-1 wiring (block/warn/enrich). The action executor now handles the `require_approval` rule effect and evaluates rule conditions against the pre-existing record.

**require_approval.** `createActionExecutor` gains an optional `approvalEngine` (`ActionApprovalSuspender`) plus a late-binding `executor.setApprovalEngine()` seam (the executor and the approval engine are mutually dependent — the engine re-executes actions via the executor). When a `require_approval` rule fires, the executor suspends the action: it calls `approvalEngine.createRequest({ action, input, actor, effect, triggerRules, ... })` and returns the `ApprovalPendingResult` instead of writing. `ApprovalEngine.approve()` later re-executes with `skipRules = triggerRules` so the approval rule does not re-fire. When no approval engine is wired, a `require_approval` effect lets the action proceed (best-effort gate, not a silent hard block).

**Record-state conditions.** Rule evaluation moved after provider setup so that, for updates (input carries an `id`), the executor reads the current record via the tenant-scoped provider and evaluates conditions against `{ ...record, ...input }`. Rules can now reference existing field values (e.g. "block edits when status is closed"), with input overriding record state. A read failure degrades to input-only.

**Wiring (all production paths).** CLI `dev` calls `executor.setApprovalEngine(approvalEngine)`. The adapter-server `createRuntimeContext` now constructs an approval engine (in-memory store; persistence via `DrizzleApprovalStore` is a boot-path follow-up), wires it both ways (executor ↔ engine, re-execution via the CommandLayer), and exposes it on `RuntimeContext`; `dev` / `dev-app` pass it to `createServer` so the approval API routes work. Previously the server had **no** approval engine, so server-side `require_approval` never functioned.

Tests: `action-engine-rule-integration.test.ts` adds require_approval (suspend → pending, no write; no-engine → proceeds; `setApprovalEngine` seam; skipRules bypass) and record-state (record-derived condition fires; input overrides record) cases — all through the real executor. Non-breaking: omitting `rules` / `approvalEngine` preserves prior behavior. No `any`/`!`.
