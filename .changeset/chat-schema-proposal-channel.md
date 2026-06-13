---
"@linchkit/cap-adapter-ui": minor
---

Make the in-product AI chat assistant the 4th "say→exists" channel (alongside REST, UI-form, and MCP). When a chat utterance is not a runtime action, the assistant now falls back to `resolveSchemaIntent`; a `proposal_draft` (or `entity_proposal_draft`) renders a new `SchemaProposalCard` — an approvable card (no Execute button) that drives Approve → `approveProposal` → Open PR → `graduateProposal` and surfaces the resulting PR link. Pure routing/state helpers (`decideSchemaFallback`, `schema-proposal-card-helpers`) keep the logic unit-testable. Reuses the existing `resolve-schema-intent` / proposal-approve / proposal-graduate endpoints — no backend changes. New `ai.schemaChange` / `ai.approveSchema` / `ai.graduatePr` + `schemaProposal.*` i18n keys (en + zh-CN).
