/**
 * createCapLock — Factory that wires the cap-lock policy + logger into a
 * `field-lock-check` interceptor and produces a fully-wired
 * CapabilityDefinition (mirrors cap-permission's factory pattern).
 *
 * The interceptor is registered via `extensions.interceptors` with
 * `{ point: "field-lock-check", capability: "lock", handler }`; core's startup
 * collects it into the InterceptorRegistry and the Action Engine threads
 * computed violations through it before enforcing.
 */

import type { CapabilityDefinition, InterceptorRegistration, Logger } from "@linchkit/core";
import { defineCapability } from "@linchkit/core";
import { type CapLockPolicy, capLockConfig, resolveCapLockPolicy } from "./config";
import type { LockOverrideEvent } from "./events";
import { createFieldLockInterceptor } from "./field-lock-interceptor";
import { buildLockGraphQLExtension } from "./graphql";

export interface CapLockOptions {
  /**
   * Declarative configuration — validated/normalized via the capLockConfig
   * schema. Partial; omitted knobs fall back to safe defaults (shadow off,
   * no bypass groups, no tolerance).
   */
  config?: Partial<CapLockPolicy>;
  /**
   * Structured logger for the audit trail. Injected the same way cap-permission
   * receives its programmatic dependencies. When omitted, suppressions are
   * silent (policy decisions are unaffected).
   */
  logger?: Logger;
  /**
   * Injectable wall-clock source (epoch ms) for deterministic tolerance
   * evaluation. Defaults to `Date.now` inside the interceptor.
   */
  now?: () => number;
  /**
   * Optional sink for `lock.override` events (Spec 63 §4.2 Notification). Wired
   * the same way as `logger`. When omitted, no events are emitted. cap-lock takes
   * no notification/event-bus dependency — the host decides where the event goes.
   * May be sync or async; the interceptor isolates both throws and rejections.
   */
  emitEvent?: (event: LockOverrideEvent) => void | Promise<void>;
}

export function createCapLock(options?: CapLockOptions): CapabilityDefinition {
  const policy: CapLockPolicy = resolveCapLockPolicy(options?.config);

  const handler = createFieldLockInterceptor({
    policy,
    logger: options?.logger,
    now: options?.now,
    emitEvent: options?.emitEvent,
  });

  const interceptors: InterceptorRegistration[] = [
    {
      point: "field-lock-check",
      capability: "lock",
      handler,
    },
  ];

  return defineCapability({
    name: "cap-lock",
    label: "Field Lock Policy",
    description:
      "Advanced field-lock policy: shadow mode, bypass groups, tolerance period, audit trail, and override notifications over core field-lock enforcement",
    type: "standard",
    category: "system",
    version: "1.0.0",
    coreVersion: "^0.2.0",

    configSchema: capLockConfig.schema,
    config: policy,

    extensions: {
      interceptors,
      // Read-side IoC counterpart to the interceptor: a single `fieldLockBypass`
      // query the auto-form uses to render an unlock affordance for
      // bypass-eligible actors. Core's `GraphQLExtensionRegistration` only
      // carries `queryFields`/`mutationFields` (no `types`); the
      // `FieldLockBypass` object type is reachable from the field's return type,
      // so graphql-js registers it automatically.
      graphqlExtensions: { queryFields: buildLockGraphQLExtension({ policy }).queryFields },
    },

    systemPermissions: ["database.read"],
  });
}
