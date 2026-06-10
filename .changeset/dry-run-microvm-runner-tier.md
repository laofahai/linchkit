---
"@linchkit/cap-dry-run": minor
---

Spec 70 P5: microVM runner tier + OS-enforced resource limits for the execution
dry-run sandbox.

- New `createDryRunner({ runner: "subprocess" | "microvm" })` factory (default
  `"subprocess"`; `createSubprocessDryRunner` stays exported as a back-compat
  alias). The launcher (harness files + args) is IDENTICAL across tiers — only
  the spawn wrapper differs, per Spec 70 §4.
- `"microvm"` tier: runs the launcher behind a gVisor KERNEL boundary via the
  production runsc integration — `docker run --runtime=runsc --network=none
  --read-only --cap-drop=ALL --pids-limit --memory=<limit>` with the per-run
  temp dir as the only writable bind (mounted at the same absolute path so the
  result file round-trips). Detection requires `docker` + `runsc` on PATH and a
  `runsc` runtime in the daemon's runtime table (`docker info` probe, memoized).
  When configured and unavailable it FAILS CLOSED (`infra_error`, nothing runs)
  — it never silently degrades to the subprocess tier. Timeout/OOM reaping also
  `docker kill`s the named container (killing the attached client alone would
  leave it running).
- OS-enforced memory cap for the subprocess tier on Linux: when `prlimit` is
  available the spawn is wrapped `prlimit --data=<memoryBytes> -- <sandbox
  argv>` (outermost, so the rlimit inherits into the sandboxed bun).
  `RLIMIT_DATA` over `RLIMIT_AS` because JS engines reserve multi-GiB virtual
  address space at startup; the cross-platform RSS-polling guard stays as
  defense in depth and keeps the precise `oom` classification.
- New injectable seams for host-independent tests: `spawn` (records argv,
  runs nothing) and `microvmProbe`; everything stays argv-array based — no
  shell interpolation anywhere.
