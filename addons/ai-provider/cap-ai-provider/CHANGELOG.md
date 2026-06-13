# @linchkit/cap-ai-provider

## 2.0.0

### Minor Changes

- d3bbc69: Accurate streaming-path token/cost accounting for AI tracing (Spec 69 Phase 3,
  follow-up to PR-1).

  `completeStream()` previously recorded only a zero-token, best-effort `partial`
  generation at stream OPEN — usage / cost / completion text are unknown until the
  Vercel AI SDK stream fully drains. It now wraps the SDK `textStream` and records
  exactly ONE token-accurate generation when the stream finishes:

  - A CLEAN drain records a `partial: false` / `status: "ok"` generation with the
    correct `inputTokens` / `outputTokens` (read from the SDK's post-drain
    `totalUsage` accessor), cost (computed with the SAME `CostEstimator` the
    completion path uses), full completion text (from the SDK `text` accessor,
    falling back to the accumulated chunks), and latency.
  - An ABORTING / erroring stream records a single `partial: true` /
    `status: "error"` record (zero tokens, partial text captured so far) and
    re-throws the original error to the consumer.
  - A parent `AITrace` now wraps the stream (mirroring the completion path) so the
    trace's token/cost rollup is correct, with the sampling decision resolved once
    and threaded into the child generation.

  The finish-hook recording is STRICTLY non-throwing: any tracing failure
  (including awaiting the SDK usage/text promises) is swallowed and logged once,
  and the wrapped stream yields the same chunks in the same order — a tracing
  failure can never break or alter the consumer's stream, output, or timing. The
  SDK runner is now reachable through the existing `runStreamText` injectable test
  seam.

- aa4fe90: Add in-house "Langfuse-class" AI tracing (Spec 69 Phase 3, PR-1): trace data
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

- f191193: G5 Phase 1 — implement the `CodeGenerationProvider` seam.

  `@linchkit/core` previously declared a `CodeGenerationProvider` interface
  ("implemented by cap-ai-provider") but no implementation existed and the type was
  not exported from any public barrel. This adds:

  - `@linchkit/core/server` now exports the `CodeGenerationProvider`,
    `CodeGenerationResult`, `ProjectContext`, and `QualityGateRunner` types so a
    capability can implement the seam.
  - `@linchkit/cap-ai-provider` exports `createCodeGenerationProvider(ai, options)`
    — a thin adapter over the configured `AIService` (GLM/zhipu/etc. per
    `linchkit.config`) that turns a prompt (+ optional context) into generated
    TypeScript source.

  This is the foundation for AI code generation of the irreducibly-code parts of a
  proposal (action / event-handler / flow logic bodies). It only PRODUCES candidate
  source as a string — it never writes files, runs code, or touches the approval /
  graduation path. Generated source still flows through validation and double human
  review (draft + graduation PR) before it can land.

### Patch Changes

- 6ba3f7e: Wire pattern-detector `state_flow` fixtures and bring eval-runner adapters into typecheck (#393, #394). `PatternExecLogInput` gains optional top-level `recordId` / `stateTransition` fields the detector reads for state-flow analysis, and the pattern-detector scenario adapter now maps them (plus fixes an invalid `ActorType` cast and a `PatternDetectorConfig` argument mismatch). Root `tsconfig.json` now includes `addons/*/cap-*/eval-runner/**` so `bun run typecheck` validates the scenario adapters going forward.
- Updated dependencies [aa4fe90]
- Updated dependencies [74ea5ba]
- Updated dependencies [f0aa51c]
- Updated dependencies [0357153]
- Updated dependencies [3b59ddd]
- Updated dependencies [a41b02f]
- Updated dependencies [7bc18f3]
- Updated dependencies [833e1ad]
- Updated dependencies [ee51432]
- Updated dependencies [64ad4c0]
- Updated dependencies [738d9e9]
- Updated dependencies [4c19796]
- Updated dependencies [eae84e7]
- Updated dependencies [efdfe74]
- Updated dependencies [30f08e7]
- Updated dependencies [f191193]
- Updated dependencies [51ecca1]
- Updated dependencies [e91e3f2]
- Updated dependencies [745debd]
- Updated dependencies [4b4f259]
- Updated dependencies [ca5417e]
- Updated dependencies [bb2ec5e]
- Updated dependencies [587f2c9]
- Updated dependencies [13696ca]
- Updated dependencies [d844445]
- Updated dependencies [4475a69]
- Updated dependencies [13696ca]
- Updated dependencies [59aea2e]
- Updated dependencies [e969502]
- Updated dependencies [e13e172]
- Updated dependencies [7929b5b]
- Updated dependencies [d817334]
- Updated dependencies [13696ca]
- Updated dependencies [7ab2986]
- Updated dependencies [e4e6a18]
- Updated dependencies [94d6962]
- Updated dependencies [90bd84b]
- Updated dependencies [0802b40]
- Updated dependencies [5108a65]
- Updated dependencies [106e926]
- Updated dependencies [ebac7d6]
- Updated dependencies [d6b250d]
- Updated dependencies [9f00487]
- Updated dependencies [5f9ff43]
- Updated dependencies [5d8d2d5]
- Updated dependencies [e1f16e8]
- Updated dependencies [9626920]
- Updated dependencies [a1f2bba]
- Updated dependencies [685ccc1]
- Updated dependencies [76511f7]
- Updated dependencies [db10790]
  - @linchkit/core@0.3.0

## 1.0.0

### Minor Changes

- b117c2c: Initial public release — M3 milestone

  - Runtime Entity Overlay (Spec 59): JSONB \_extensions, overlay registry, GraphQL hot-reload
  - AI Workspace (Spec 60): linch doctor, linch info, linch agents-md, linch mcp-dev
  - Core i18n: capability-owned translations, resolveLabel for CLI/MCP
  - Publishing infrastructure: tsup builds, OCA source addons, changesets

### Patch Changes

- Updated dependencies [b117c2c]
  - @linchkit/core@0.2.0
