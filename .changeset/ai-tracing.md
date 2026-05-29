---
"@linchkit/core": minor
"@linchkit/cap-ai-provider": minor
---

Add in-house "Langfuse-class" AI tracing (Spec 69 Phase 3, PR-1): trace data
model + provider instrumentation.

`@linchkit/core`:

- New `AITrace` / `AIGeneration` / `AITraceContext` data model plus
  `RedactionPolicy`, `AITraceSamplingConfig`, and the `AITraceSink` interface
  (`packages/core/src/observability/ai-trace.ts`).
- `redactPromptMessages` / `redactContent` helpers (built on the existing
  masking engine) supporting `none` / `mask` / `hash` / `drop` modes, plus
  `shouldSample` for sampling.
- `InMemoryAITraceStore` ring-buffer sink mirroring `AIActionAuditStore`
  (capacity trim, tenant isolation, aggregate roll-up) and a module-level
  `getAITraceSink()` / `setAITraceSink()` / `resetAITraceSink()` registry
  mirroring the observability registry
  (`packages/core/src/observability/ai-trace-store.ts`).
- Optional non-breaking `trace?: AITraceContext` field on
  `AICompletionOptions`.

`@linchkit/cap-ai-provider`:

- `createAIService` now records one `AIGeneration` per `complete()` call —
  opening a tracer span and writing to the active `AITraceSink` with redaction
  (mask for production origin, verbatim for eval origin) and sampling applied.
  The provider error string is redacted with the SAME policy as
  prompts/completions (and length-capped) so a 4xx that echoes the request body
  or auth headers cannot leak under the production `mask` policy.
- A parent `AITrace` wraps `executeWithFallback` so retries + fallback land
  under one trace. The sampling decision is resolved ONCE per trace and threaded
  into every child generation, so a fractional rate can never sample a
  generation in under a sampled-out parent (or vice-versa). All span/sink calls
  are strictly non-throwing: a misbehaving tracer or sink never breaks a real AI
  call.
- A fallback-served success now records `fallbackUsed` on its generation.
- The streaming path records a best-effort `partial` generation at stream open
  (token-accurate streaming accounting is deferred to a later PR).
- `resolveIntent` accepts and forwards an optional `trace` context; the intent
  eval scenario attaches `origin: "eval"` provenance per fixture.
