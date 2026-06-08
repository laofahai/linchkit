---
"@linchkit/core": minor
"@linchkit/cap-adapter-server": minor
---

Make the autonomous evolution cadence loop observable (Spec 55 §7). An operator
could start the cadence scheduler but had no way to see whether it was actually
alive — ticking, idle, or stuck on a repeating error.

`EvolutionScheduler` gains a read-only `getStatus(): EvolutionSchedulerStatus`
liveness snapshot (running, clamped intervalMs, ticksStarted/ticksCompleted,
last-tick timestamps + duration, lastError, consecutiveErrors). The counters are
tracked inside the non-overlapping tick runner; the snapshot clones its `Date`s
so callers cannot mutate scheduler state. A successful tick clears the error
streak; a thrown tick still "completes" and increments `consecutiveErrors`.

The adapter-server exposes it at `GET /api/evolution/scheduler-status`, dispatched
through the **same CommandLayer permission path** as `/api/evolution/run-cycle`
(synthetic `evolution.scheduler_status` command, `skipActionSlots`): 503 when no
CommandLayer is configured, 401/403 canonical `AUTHZ_DENIED` on denial, `200
{ configured: false }` when cadence is disabled, and `200 { configured: true,
...status }` (Date fields as ISO strings) when a scheduler is wired. Permission
runs before anything is reported, so an unauthorized caller cannot even learn
whether cadence is configured.

A real-`createServer` smoke test drives the endpoint through the canonical server
factory (the same assembly `http-transport` boots), advances the scheduler with
`runOnce()`, reads the live state back over HTTP, and asserts the read fails
closed (`PERMISSION.MIDDLEWARE_MISSING`) when no permission middleware is present.
