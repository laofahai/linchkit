# @linchkit/cap-dry-run

## 1.0.0

### Minor Changes

- f86561b: Spec 70 P5: microVM runner tier + OS-enforced resource limits for the execution
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

### Patch Changes

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
