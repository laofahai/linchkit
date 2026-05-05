---
"@linchkit/core": minor
---

feat(core): idempotency cache key now folds in behavior-affecting `ctx.meta` keys (Spec 65 §5)

Two requests with the same idempotency key but different behavior-affecting meta
(`dry_run`, `skip_notifications`, `bulk`, any `default.*`) no longer shortcircuit to
the cached result — they re-execute, since meta changes the operation's intent.
Observational meta (`lang`, `tz`, `source_view`, …) and `_`-prefixed system keys
are excluded from the hash so they do not fragment the cache. Effective key is
unchanged for callers that pass no behavior-affecting meta.
