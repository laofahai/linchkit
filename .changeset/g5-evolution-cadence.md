---
"@linchkit/core": minor
"@linchkit/cap-adapter-server": patch
---

Add `createEvolutionScheduler` (Spec 55 §7) — an opt-in cadence engine for the
evolution cycle. It runs a caller-provided tick (typically "run one cycle →
persist its proposals as governance DRAFTS") on a fixed interval, with
non-overlapping ticks, an interval floor (`MIN_INTERVAL_MS`), caught tick errors,
and `start`/`stop`/`runOnce` lifecycle. It is inert until started and produces
DRAFTS only — approval and graduation stay human-gated. Exported from
`@linchkit/core/server`.

`@linchkit/cap-adapter-server` wires it as an opt-in server cadence
(`EVOLUTION_CADENCE_INTERVAL_MS`, off by default; `EVOLUTION_CADENCE_TENANT_IDS`
to scope per tenant), started/stopped with the server lifecycle.
