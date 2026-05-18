/**
 * AI BYOK (Bring Your Own Key) + Usage REST endpoints — Spec 36 M2+.
 *
 * Routes (all tenant-scoped via the request actor + tenant resolver):
 *   - POST   /api/ai/byok/keys              — register / overwrite a key
 *   - DELETE /api/ai/byok/keys/:provider    — revoke a key
 *   - GET    /api/ai/byok/keys              — list metadata for tenant
 *   - GET    /api/ai/byok/usage             — aggregate usage for tenant
 *
 * Security:
 *   - Tenant is resolved from the trusted request context via
 *     `options.resolveRequestTenantId`. It is NEVER read from the body.
 *   - Authentication is mandatory — anonymous requests are rejected
 *     with HTTP 401. BYOK is a per-tenant write surface and dev-mode
 *     `NO_AUTH_ACTOR` would happily expose every tenant's keys.
 *   - The store is opaque to the caller: only `encryptedKeyRef` is
 *     accepted on PUT. Plaintext keys never enter the request body.
 *   - List responses redact `encryptedKeyRef` so an inadvertent log
 *     of the response body cannot leak the KMS lookup token.
 *
 * Wiring:
 *   The route reads `options.byokKeyStore` and `options.usageMeter`
 *   (added to `ServerOptions` as optional dependencies). When either
 *   is absent the corresponding endpoints return HTTP 503 with a
 *   structured envelope — same posture as the other AI endpoints.
 */

import type { Elysia } from "elysia";
import type { ServerOptions } from "../server";
import { ANONYMOUS_ACTOR, badRequest, NO_AUTH_ACTOR, serviceUnavailable } from "./shared";

// ── Input validation helpers ────────────────────────────────

// Hard cap on string field lengths so a pathological payload can't
// blow out memory or the audit log. Generous enough for any real
// provider id / alias / KMS ref.
const MAX_FIELD_LENGTH = 256;
const MAX_KEY_REF_LENGTH = 1024;

function isNonEmptyShortString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

interface PutKeyBody {
  provider?: unknown;
  keyAlias?: unknown;
  encryptedKeyRef?: unknown;
}

interface ValidatedPutKey {
  provider: string;
  keyAlias: string;
  encryptedKeyRef: string;
}

interface ValidationOk<T> {
  ok: true;
  value: T;
}
interface ValidationErr {
  ok: false;
  field: string;
  message: string;
}

function validatePutKeyBody(
  body: PutKeyBody | undefined,
): ValidationOk<ValidatedPutKey> | ValidationErr {
  if (!body || typeof body !== "object") {
    return { ok: false, field: "body", message: "request body must be a JSON object" };
  }
  if (!isNonEmptyShortString(body.provider, MAX_FIELD_LENGTH)) {
    return {
      ok: false,
      field: "provider",
      message: `provider must be a non-empty string up to ${MAX_FIELD_LENGTH} chars`,
    };
  }
  if (!isNonEmptyShortString(body.keyAlias, MAX_FIELD_LENGTH)) {
    return {
      ok: false,
      field: "keyAlias",
      message: `keyAlias must be a non-empty string up to ${MAX_FIELD_LENGTH} chars`,
    };
  }
  if (!isNonEmptyShortString(body.encryptedKeyRef, MAX_KEY_REF_LENGTH)) {
    return {
      ok: false,
      field: "encryptedKeyRef",
      message: `encryptedKeyRef must be a non-empty string up to ${MAX_KEY_REF_LENGTH} chars`,
    };
  }
  return {
    ok: true,
    value: {
      provider: body.provider,
      keyAlias: body.keyAlias,
      encryptedKeyRef: body.encryptedKeyRef,
    },
  };
}

/** Strip the KMS reference before returning a key record to a client. */
function redactKey(
  record: import("@linchkit/core/ai").BYOKKeyRecord,
): Omit<import("@linchkit/core/ai").BYOKKeyRecord, "encryptedKeyRef"> {
  const { encryptedKeyRef: _ref, ...rest } = record;
  return rest;
}

/**
 * Resolve the trusted tenant for a request. Returns either the
 * tenant id or a `Response` envelope describing the failure mode so
 * the route handlers can early-return uniformly.
 */
async function resolveTenantContext(
  request: Request,
  options: ServerOptions,
  set: { status?: number | string | undefined },
): Promise<{ ok: true; tenantId: string } | { ok: false; response: unknown }> {
  const resolveRequestActor = options.resolveRequestActor;
  const resolveRequestTenantId = options.resolveRequestTenantId;

  // BYOK is sensitive — reject dev-mode no-auth. Without a real auth
  // resolver any caller would get the elevated NO_AUTH_ACTOR identity
  // and be able to enumerate every tenant's keys.
  if (!resolveRequestActor) {
    set.status = 503;
    return {
      ok: false,
      response: {
        success: false,
        error: {
          code: "AUTH.REQUIRED",
          message:
            "BYOK endpoints require an authenticated request — configure resolveRequestActor",
        },
      },
    };
  }

  const actor = (await resolveRequestActor(request)) ?? ANONYMOUS_ACTOR;
  if (actor === ANONYMOUS_ACTOR || actor === NO_AUTH_ACTOR || actor.id === "anonymous") {
    set.status = 401;
    return {
      ok: false,
      response: {
        success: false,
        error: { code: "AUTH.REQUIRED", message: "Authentication required" },
      },
    };
  }

  const tenantId = resolveRequestTenantId
    ? await resolveRequestTenantId(request, actor)
    : undefined;
  if (!tenantId) {
    set.status = 400;
    return {
      ok: false,
      response: {
        success: false,
        error: {
          code: "TENANT.REQUIRED",
          message: "BYOK endpoints require a tenant-scoped request",
        },
      },
    };
  }
  return { ok: true, tenantId };
}

export function mountAIByokRoutes(app: Elysia, options: ServerOptions): void {
  // ── POST /api/ai/byok/keys ────────────────────────────────
  app.post("/api/ai/byok/keys", async ({ body, request, set }) => {
    const store = options.byokKeyStore;
    if (!store) {
      return serviceUnavailable(set, "BYOK key store not configured");
    }

    const tenantCtx = await resolveTenantContext(request, options, set);
    if (!tenantCtx.ok) return tenantCtx.response;

    const validated = validatePutKeyBody(body as PutKeyBody | undefined);
    if (!validated.ok) {
      set.status = 400;
      return {
        success: false,
        error: {
          code: "VALIDATION.FAILED",
          field: validated.field,
          message: validated.message,
        },
      };
    }

    try {
      await store.putKey({
        tenantId: tenantCtx.tenantId,
        provider: validated.value.provider,
        keyAlias: validated.value.keyAlias,
        encryptedKeyRef: validated.value.encryptedKeyRef,
      });
      return { success: true, data: { ok: true } };
    } catch (err) {
      set.status = 500;
      const message =
        process.env.NODE_ENV === "production"
          ? "Failed to register BYOK key"
          : err instanceof Error
            ? err.message
            : String(err);
      return { success: false, error: { code: "BYOK.PUT_FAILED", message } };
    }
  });

  // ── DELETE /api/ai/byok/keys/:provider ────────────────────
  app.delete("/api/ai/byok/keys/:provider", async ({ params, request, set }) => {
    const store = options.byokKeyStore;
    if (!store) {
      return serviceUnavailable(set, "BYOK key store not configured");
    }

    const provider = params.provider;
    if (!isNonEmptyShortString(provider, MAX_FIELD_LENGTH)) {
      return badRequest(set, "provider path parameter must be a non-empty short string");
    }

    const tenantCtx = await resolveTenantContext(request, options, set);
    if (!tenantCtx.ok) return tenantCtx.response;

    try {
      await store.revokeKey({ tenantId: tenantCtx.tenantId, provider });
      return { success: true, data: { ok: true } };
    } catch (err) {
      set.status = 500;
      const message =
        process.env.NODE_ENV === "production"
          ? "Failed to revoke BYOK key"
          : err instanceof Error
            ? err.message
            : String(err);
      return { success: false, error: { code: "BYOK.REVOKE_FAILED", message } };
    }
  });

  // ── GET /api/ai/byok/keys ─────────────────────────────────
  app.get("/api/ai/byok/keys", async ({ request, set }) => {
    const store = options.byokKeyStore;
    if (!store) {
      return serviceUnavailable(set, "BYOK key store not configured");
    }

    const tenantCtx = await resolveTenantContext(request, options, set);
    if (!tenantCtx.ok) return tenantCtx.response;

    try {
      const records = await store.listKeys({ tenantId: tenantCtx.tenantId });
      return { success: true, data: { keys: records.map(redactKey) } };
    } catch (err) {
      set.status = 500;
      const message =
        process.env.NODE_ENV === "production"
          ? "Failed to list BYOK keys"
          : err instanceof Error
            ? err.message
            : String(err);
      return { success: false, error: { code: "BYOK.LIST_FAILED", message } };
    }
  });

  // ── GET /api/ai/byok/usage?since=ISO&until=ISO ────────────
  app.get("/api/ai/byok/usage", async ({ query, request, set }) => {
    const meter = options.usageMeter;
    if (!meter) {
      return serviceUnavailable(set, "Usage meter not configured");
    }

    const tenantCtx = await resolveTenantContext(request, options, set);
    if (!tenantCtx.ok) return tenantCtx.response;

    // Elysia parses the query string for us — read `since` / `until`
    // off the destructured `query` object instead of re-parsing the
    // request URL. Values arrive as `string | undefined` (or arrays
    // when repeated); we accept only the single-string form.
    const { since, until } = query as { since?: unknown; until?: unknown };
    if (typeof since !== "string" || typeof until !== "string" || !since || !until) {
      return badRequest(set, "'since' and 'until' query parameters are required (ISO-8601)");
    }
    const sinceMs = Date.parse(since);
    const untilMs = Date.parse(until);
    if (Number.isNaN(sinceMs) || Number.isNaN(untilMs)) {
      return badRequest(set, "'since' and 'until' must be valid ISO-8601 timestamps");
    }
    if (untilMs < sinceMs) {
      return badRequest(set, "'until' must be greater than or equal to 'since'");
    }

    try {
      const aggregate = await meter.aggregate({
        tenantId: tenantCtx.tenantId,
        since,
        until,
      });
      return {
        success: true,
        data: {
          tenantId: tenantCtx.tenantId,
          since,
          until,
          ...aggregate,
        },
      };
    } catch (err) {
      set.status = 500;
      const message =
        process.env.NODE_ENV === "production"
          ? "Failed to aggregate usage"
          : err instanceof Error
            ? err.message
            : String(err);
      return { success: false, error: { code: "BYOK.USAGE_FAILED", message } };
    }
  });
}
