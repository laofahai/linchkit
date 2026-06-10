---
"@linchkit/core": patch
"@linchkit/cap-adapter-server": patch
---

feat(core,adapter-server): `strictExecutionDryRun` feature flag — opt-in gate that escalates execution dry-run findings from warnings to blocking validation errors (Spec 70 P5a, #522)

`EnvironmentFeatureFlags.strictExecutionDryRun` exposes the existing Phase 5
warn→block escalation as a configurable flag. Unlike `strictCompatibility` /
`strictGeneratedContract` it is **opt-in everywhere — NOT derived from
`isProduction`**: the dry-run depends on external sandbox infrastructure, so
auto-blocking in prod on an un-configured or flaky sandbox would wedge
graduation. It defaults to `false` in every environment and flips on only via
the explicit `LINCHKIT_STRICT_EXECUTION_DRY_RUN=1` override (mirroring the
materialize-path `LINCHKIT_EXECUTION_DRY_RUN=1` opt-in), once an operator has
confirmed the sandbox is healthy. Infra failures (`infra_error`) remain
warnings regardless of the flag.

adapter-server threads the flag from `detectEnvironment().features` into the
proposal-validation context next to the other strict flags, so submit-time
Phase 5 honors it end-to-end.
