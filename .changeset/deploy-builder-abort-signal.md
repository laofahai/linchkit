---
"@linchkit/core": minor
---

feat(deployment): DeployBuilder now aborts subprocesses on timeout via AbortSignal.

`ProcessExecutor` signature gained an optional fourth parameter `options?: { signal?: AbortSignal }`. Custom executors implementing this type should forward the signal to their spawn mechanism (e.g., `child_process.spawn`'s `signal` option or `Bun.spawn`'s `signal` option) so timed-out processes get SIGTERM'd instead of leaking as orphans. Existing executors that ignore the new parameter remain functionally compatible but will continue to leak subprocesses on timeout.

The internal `withTimeout` helper now accepts a `(signal) => Promise<T>` callback rather than a bare `Promise<T>`. The default `Bun.spawn`-backed executor forwards the signal and translates an aborted run into a clear `Subprocess aborted` error instead of the previous opaque `exit 143: <empty>`.

Fixes #361.
