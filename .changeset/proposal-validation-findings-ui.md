---
"@linchkit/cap-adapter-ui": minor
---

Surface proposal validation findings in the proposal review UI. A new read-only `ProposalValidationFindings` component renders each non-skipped validation phase's errors (blocking, destructive styling) and warnings (advisory, amber styling) with their code + message, emphasizing Phase 3 (compatibility / breaking-reference checks) — sorted first with a distinct icon — so a reviewer can see when a proposal would break existing references. The inline `validationResult` shape on `Proposal` is extracted into reusable exported types. Defensive against missing/partial validation data; purely presentational (never approves/applies). Pre-analysis (dedup/impact) is not yet plumbed to the client and is out of scope.
