/**
 * Build the runtime interceptor registry from collected capability
 * registrations (Spec 63 Phase 3).
 */

import {
  consoleLogger,
  createInterceptorRegistry,
  type InterceptorRegistration,
  type InterceptorRegistry,
} from "@linchkit/core/server";

/**
 * Create an {@link InterceptorRegistry} and register every collected
 * interceptor. Logs a one-line summary when at least one is registered.
 */
export function buildInterceptorRegistry(
  interceptors: InterceptorRegistration[] = [],
): InterceptorRegistry {
  const registry = createInterceptorRegistry({ logger: consoleLogger });
  for (const reg of interceptors) {
    registry.register(reg);
  }
  if (interceptors.length > 0) {
    consoleLogger.info(
      `Registered ${interceptors.length} interceptor(s): ${interceptors
        .map((i) => `${i.capability}[${i.point}]`)
        .join(", ")}`,
    );
  }
  return registry;
}
