/**
 * Interceptors (Spec 63 Phase 3).
 *
 * A strongly-typed, chainable, **value-returning** capability → core
 * extension mechanism. Unlike the `hooks` extension point (void, fire-and-
 * forget event reactions) and unlike CommandLayer middlewares (request/response
 * pipeline around an action), an Interceptor TRANSFORMS a specific in-flight
 * value at a named extension point inside a core engine and returns the
 * (possibly modified) value, which is threaded into the next interceptor.
 *
 * The set of extension points and their value/context types is the single
 * source of truth {@link InterceptorCatalog}. Adding a new point = adding one
 * entry there; the generic registry and `run<P>` typing follow automatically.
 *
 * Phase 3 PR-1 ships exactly one point: `field-lock-check`. The Action Engine
 * runs the field-lock violation set through it before throwing, so a policy
 * capability (e.g. cap-lock) can shadow / bypass / apply tolerance to
 * violations. When NO interceptor is registered, behavior is byte-for-byte
 * identical to Phase 1 (the registry's `run` is an identity).
 */

import type { Actor } from "../types/action";
import type { Logger } from "../types/logger";
import type { FieldLockViolation } from "./field-lock-checker";

/**
 * Context passed to a `field-lock-check` interceptor. Read-only inputs that
 * describe the in-flight update; the interceptor transforms the violation
 * VALUE (first argument of {@link Interceptor}), not this context.
 */
export interface FieldLockCheckContext {
  /** Entity name whose field locks are being evaluated. */
  entity: string;
  /** Actor performing the write. */
  actor: Actor;
  /** Existing persisted record (carries `created_at`, `status`, etc.). */
  record: Record<string, unknown>;
  /** The attempted write set (after system-field/status stripping). */
  input: Record<string, unknown>;
  /** Tenant scope of the write, when known. */
  tenantId?: string;
}

/**
 * A value-returning extension function. Receives the current `value` plus a
 * point-specific `context`, returns the (possibly transformed) value. May be
 * sync or async.
 */
export type Interceptor<In, Ctx, Out = In> = (value: In, context: Ctx) => Out | Promise<Out>;

/**
 * Single source of truth mapping each interceptor point name to its
 * `Interceptor<value, context>` signature. Adding a point here makes it
 * available end-to-end with full typing (registration, `run`, capability
 * declaration).
 */
export interface InterceptorCatalog {
  "field-lock-check": Interceptor<FieldLockViolation[], FieldLockCheckContext>;
}

/** Valid interceptor point names (keys of {@link InterceptorCatalog}). */
export type InterceptorPoint = keyof InterceptorCatalog;

/**
 * Registration record for one interceptor at one point. Declared by a
 * capability via `extensions.interceptors`, collected at startup, and
 * registered into the {@link InterceptorRegistry}.
 */
export interface InterceptorRegistration<P extends InterceptorPoint = InterceptorPoint> {
  /** Which extension point this interceptor attaches to. */
  point: P;
  /** Owning capability name (for diagnostics / fail-closed logging). */
  capability?: string;
  /** Ascending execution order within the point. Defaults to 100. */
  order?: number;
  /** The transform function — typed by {@link InterceptorCatalog}[P]. */
  handler: InterceptorCatalog[P];
}

/** Registry of interceptors grouped by point, executed in `order` ascending. */
export interface InterceptorRegistry {
  /** Register an interceptor; keeps each point sorted by `order` (stable). */
  register<P extends InterceptorPoint>(reg: InterceptorRegistration<P>): void;
  /** True iff at least one interceptor is registered for `point`. */
  has(point: InterceptorPoint): boolean;
  /**
   * Thread `value` through every interceptor at `point` in ascending `order`,
   * each handler's output feeding the next, and return the final value. With
   * no registrations, returns `value` unchanged (identity).
   */
  run<P extends InterceptorPoint>(
    point: P,
    value: Parameters<InterceptorCatalog[P]>[0],
    context: Parameters<InterceptorCatalog[P]>[1],
  ): Promise<Awaited<ReturnType<InterceptorCatalog[P]>>>;
}

/** Default execution order when a registration omits `order`. */
const DEFAULT_ORDER = 100;

/**
 * Produce a defensive clone of an interceptor's input value before handing it
 * to a handler. Handlers transform by RETURNING a value and must treat the
 * argument as immutable; cloning enforces that contract so a handler cannot
 * reach back into the authoritative value and mutate it in place.
 *
 * For `field-lock-check` the value is a `FieldLockViolation[]` — an ENFORCEMENT
 * set — so we deep-clone BOTH the array container AND each element. A shallow
 * `[...value]` would still share the individual violation OBJECTS, letting a
 * buggy or hostile handler do `violations[0].field = "allowed"` and then throw
 * (so the fail-closed path keeps the pre-handler value) while having silently
 * corrupted that pre-handler value — weakening the boundary. Cloning the
 * elements closes that hole.
 */
function cloneInterceptorInput<P extends InterceptorPoint>(
  point: P,
  value: Parameters<InterceptorCatalog[P]>[0],
): Parameters<InterceptorCatalog[P]>[0] {
  if (point === "field-lock-check" && Array.isArray(value)) {
    return value.map((violation) => ({ ...violation })) as Parameters<InterceptorCatalog[P]>[0];
  }
  return value;
}

/**
 * Default {@link InterceptorRegistry} implementation. A class keeps the
 * generic `run<P>` method on the prototype and the per-point registration
 * groups as private state.
 */
class DefaultInterceptorRegistry implements InterceptorRegistry {
  private readonly logger?: Logger;

  // Registrations grouped by point. Each group is kept sorted by `order`
  // ascending; ties preserve insertion order (stable sort).
  private readonly groups = new Map<InterceptorPoint, InterceptorRegistration[]>();

  constructor(logger?: Logger) {
    this.logger = logger;
  }

  register<P extends InterceptorPoint>(reg: InterceptorRegistration<P>): void {
    const list = this.groups.get(reg.point) ?? [];
    list.push(reg as InterceptorRegistration);
    // Stable sort by order — Array.prototype.sort is stable in modern engines,
    // so equal `order` values retain insertion order.
    list.sort((a, b) => (a.order ?? DEFAULT_ORDER) - (b.order ?? DEFAULT_ORDER));
    this.groups.set(reg.point, list);
  }

  has(point: InterceptorPoint): boolean {
    const list = this.groups.get(point);
    return list !== undefined && list.length > 0;
  }

  async run<P extends InterceptorPoint>(
    point: P,
    value: Parameters<InterceptorCatalog[P]>[0],
    context: Parameters<InterceptorCatalog[P]>[1],
  ): Promise<Awaited<ReturnType<InterceptorCatalog[P]>>> {
    type Out = Awaited<ReturnType<InterceptorCatalog[P]>>;
    const list = this.groups.get(point);
    // Identity fast-path: no registrations → return the value unchanged.
    if (!list || list.length === 0) {
      return value as unknown as Out;
    }

    let current: unknown = value;
    for (const reg of list) {
      // FAIL-CLOSED (security). field-lock-check is an ENFORCEMENT boundary:
      // a buggy or hostile policy capability must NEVER silently WEAKEN it.
      // Handlers transform by RETURNING a value and must treat the argument as
      // immutable. We hand each handler a defensive DEEP clone (array container
      // AND its elements — see `cloneInterceptorInput`), so a handler that
      // mutates its argument in place and THEN throws / returns null/undefined
      // cannot strip violations out from under us — on any failure the
      // authoritative `current` is left exactly as it was. A non-array return
      // where an array was expected is likewise treated as a failure, so an
      // invalid handler cannot corrupt the engine's downstream view of the
      // value. Failures are logged for visibility.
      const capabilityName = reg.capability || "unknown";
      const handlerInput = cloneInterceptorInput(
        point,
        current as Parameters<InterceptorCatalog[P]>[0],
      );
      try {
        const handler = reg.handler as Interceptor<unknown, unknown>;
        const next = await handler(handlerInput, context);
        if (
          next === null ||
          next === undefined ||
          (Array.isArray(current) && !Array.isArray(next))
        ) {
          this.logger?.error(
            `Interceptor "${capabilityName}" at point "${point}" returned an invalid value (${next === null ? "null" : typeof next}); keeping pre-handler value (fail-closed)`,
            { capability: capabilityName, point },
          );
          continue;
        }
        current = next;
      } catch (err) {
        this.logger?.error(
          `Interceptor "${capabilityName}" at point "${point}" threw; keeping pre-handler value (fail-closed)`,
          {
            capability: capabilityName,
            point,
            error: err instanceof Error ? err.message : String(err),
          },
        );
      }
    }

    return current as Out;
  }
}

/**
 * Create an {@link InterceptorRegistry}.
 *
 * @param opts.logger - Optional structured logger; receives fail-closed
 *   diagnostics. When omitted, fail-closed events are silent.
 */
export function createInterceptorRegistry(opts?: { logger?: Logger }): InterceptorRegistry {
  return new DefaultInterceptorRegistry(opts?.logger);
}
