/**
 * @linchkit/cap-lock — Advanced field-lock policy capability (Spec 63 Phase 3).
 *
 * Layers shadow mode, bypass groups, a tolerance period, and an audit trail on
 * top of core's Phase 1 field-lock enforcement via a `field-lock-check`
 * interceptor. With default config it is a no-op over core (fail-closed).
 */

// Shared actor-level bypass predicate (used by interceptor + GraphQL extension)
export type { ActorBypassReason, ActorBypassResult } from "./bypass";
export { evaluateActorBypass } from "./bypass";
// Capability definition (static, default config)
export { capLock } from "./capability";
// Config schema + policy resolver
export type { CapLockPolicy } from "./config";
export { capLockConfig, resolveCapLockPolicy } from "./config";
// Override notification event (Spec 63 §4.2) — dependency-free emit seam
export type { LockOverrideEvent } from "./events";
export { buildLockOverrideEvent, LOCK_OVERRIDE_EVENT } from "./events";
// Factory (custom config + logger + clock injection)
export type { CapLockOptions } from "./factory";
export { createCapLock } from "./factory";
// Interceptor handler factory + types
export type {
  FieldLockInterceptorOptions,
  LockSuppressionReason,
} from "./field-lock-interceptor";
export { createFieldLockInterceptor } from "./field-lock-interceptor";
// GraphQL extension (read-side IoC counterpart to the interceptor)
export type { LockGraphQLExtension, LockGraphQLExtensionOptions } from "./graphql";
export { buildLockGraphQLExtension } from "./graphql";
