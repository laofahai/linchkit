/**
 * @linchkit/cap-lock — Advanced field-lock policy capability (Spec 63 Phase 3).
 *
 * Layers shadow mode, bypass groups, a tolerance period, and an audit trail on
 * top of core's Phase 1 field-lock enforcement via a `field-lock-check`
 * interceptor. With default config it is a no-op over core (fail-closed).
 */

// Capability definition (static, default config)
export { capLock } from "./capability";
// Config schema + policy resolver
export type { CapLockPolicy } from "./config";
export { capLockConfig, resolveCapLockPolicy } from "./config";
// Factory (custom config + logger + clock injection)
export type { CapLockOptions } from "./factory";
export { createCapLock } from "./factory";
// Interceptor handler factory + types
export type {
  FieldLockInterceptorOptions,
  LockSuppressionReason,
} from "./field-lock-interceptor";
export { createFieldLockInterceptor } from "./field-lock-interceptor";
