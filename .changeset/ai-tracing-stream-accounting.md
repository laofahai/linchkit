---
"@linchkit/cap-ai-provider": minor
---

Accurate streaming-path token/cost accounting for AI tracing (Spec 69 Phase 3,
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
