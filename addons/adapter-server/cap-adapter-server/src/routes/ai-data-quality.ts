/**
 * POST /api/ai/data-quality — Rule-based data quality scan for an entity schema.
 *
 * Extracted from ai-api.ts to keep file size manageable.
 *
 * Security (Spec 52 §1.1 — "AI sees only what the user sees"):
 *   - Actor is resolved from the trusted request context via
 *     `options.resolveRequestActor` (NEVER read from body).
 *   - Tenant is resolved via `options.resolveRequestTenantId` and wrapped
 *     around the raw DataProvider with `createTenantAwareDataProvider`, so
 *     the underlying `query()` call cannot leak rows across tenants.
 *   - This mirrors the pattern used by `/api/ai/chat` and
 *     `/api/ai/resolve-intent` in this addon. When auth middleware is not
 *     wired (dev mode), the actor falls back to `NO_AUTH_ACTOR` and no
 *     tenant filter is applied — same posture as those endpoints.
 */

import type { Elysia } from "elysia";
import type { ServerOptions } from "../server";
import { ANONYMOUS_ACTOR, NO_AUTH_ACTOR } from "./shared";

// Hard ceiling on user-supplied numeric options. Anything beyond this is
// either an abuse attempt or a misconfiguration — reject instead of clamping
// so callers learn about the bound.
const MAX_RECORDS_CEILING = 10_000;
const DEFAULT_MAX_RECORDS = 1_000;
// 10 years is far beyond any realistic freshness threshold; treat anything
// larger as bad input.
const MAX_FRESHNESS_THRESHOLD_MS = 10 * 365 * 24 * 60 * 60 * 1000;
// Z-score above ~10 is effectively "never flag" — keep the bound generous
// but finite so NaN/Infinity get rejected.
const MAX_OUTLIER_Z_THRESHOLD = 100;

function isPositiveInteger(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0
  );
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

interface ScanOptionsInput {
  freshnessThresholdMs?: unknown;
  outlierZThreshold?: unknown;
  maxRecords?: unknown;
}

interface ValidatedScanOptions {
  maxRecords: number;
  freshnessThresholdMs?: number;
  outlierZThreshold?: number;
}

interface ValidationFailure {
  ok: false;
  field: string;
  message: string;
}
interface ValidationSuccess {
  ok: true;
  value: ValidatedScanOptions;
}

function validateScanOptions(
  raw: ScanOptionsInput | undefined,
): ValidationSuccess | ValidationFailure {
  // maxRecords: must be a positive integer ≤ ceiling. Default applies when omitted.
  let maxRecords = DEFAULT_MAX_RECORDS;
  if (raw?.maxRecords !== undefined) {
    if (!isPositiveInteger(raw.maxRecords)) {
      return {
        ok: false,
        field: "maxRecords",
        message: "maxRecords must be a positive integer",
      };
    }
    if (raw.maxRecords > MAX_RECORDS_CEILING) {
      return {
        ok: false,
        field: "maxRecords",
        message: `maxRecords must not exceed ${MAX_RECORDS_CEILING}`,
      };
    }
    maxRecords = raw.maxRecords;
  }

  // freshnessThresholdMs: optional, must be a non-negative finite number ≤ ceiling.
  // Zero is valid: it marks every timestamped record as stale (useful for testing).
  let freshnessThresholdMs: number | undefined;
  if (raw?.freshnessThresholdMs !== undefined) {
    if (!isNonNegativeFiniteNumber(raw.freshnessThresholdMs)) {
      return {
        ok: false,
        field: "freshnessThresholdMs",
        message: "freshnessThresholdMs must be a non-negative finite number",
      };
    }
    if (raw.freshnessThresholdMs > MAX_FRESHNESS_THRESHOLD_MS) {
      return {
        ok: false,
        field: "freshnessThresholdMs",
        message: `freshnessThresholdMs must not exceed ${MAX_FRESHNESS_THRESHOLD_MS}`,
      };
    }
    freshnessThresholdMs = raw.freshnessThresholdMs;
  }

  // outlierZThreshold: optional, must be a positive finite number ≤ ceiling.
  let outlierZThreshold: number | undefined;
  if (raw?.outlierZThreshold !== undefined) {
    if (!isPositiveFiniteNumber(raw.outlierZThreshold)) {
      return {
        ok: false,
        field: "outlierZThreshold",
        message: "outlierZThreshold must be a positive finite number",
      };
    }
    if (raw.outlierZThreshold > MAX_OUTLIER_Z_THRESHOLD) {
      return {
        ok: false,
        field: "outlierZThreshold",
        message: `outlierZThreshold must not exceed ${MAX_OUTLIER_Z_THRESHOLD}`,
      };
    }
    outlierZThreshold = raw.outlierZThreshold;
  }

  return {
    ok: true,
    value: { maxRecords, freshnessThresholdMs, outlierZThreshold },
  };
}

export function mountDataQualityRoute(app: Elysia, options: ServerOptions): void {
  const entityRegistry = options.entityRegistry;

  app.post("/api/ai/data-quality", async ({ body, request, set }) => {
    const { entityName, options: scanOptions } = (body ?? {}) as {
      entityName?: string;
      options?: ScanOptionsInput;
    };

    if (!entityName || typeof entityName !== "string") {
      set.status = 400;
      return {
        success: false,
        error: { message: "entityName is required and must be a string" },
      };
    }

    // Validate user-supplied scan options up front. Reject (HTTP 400) on
    // non-integers, NaN, negatives, or anything exceeding the safe ceiling.
    const validated = validateScanOptions(scanOptions);
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
    const { maxRecords, freshnessThresholdMs, outlierZThreshold } = validated.value;

    const rawDataProvider = options.dataProvider;
    if (!rawDataProvider) {
      set.status = 500;
      return { success: false, error: { message: "Data provider not configured." } };
    }

    const entityDef = entityRegistry?.get(entityName);
    if (!entityDef) {
      set.status = 404;
      return { success: false, error: { message: `Entity "${entityName}" not found.` } };
    }

    try {
      // Resolve actor + tenant from the trusted request context. This mirrors
      // `/api/ai/chat` and `/api/ai/resolve-intent`: the actor is reserved for
      // future per-action permission scoping; the tenant id is used IMMEDIATELY
      // below to wrap the data provider so cross-tenant reads are impossible.
      const resolveRequestActor = options.resolveRequestActor;
      const resolveRequestTenantId = options.resolveRequestTenantId;

      const actor = resolveRequestActor
        ? ((await resolveRequestActor(request)) ?? ANONYMOUS_ACTOR)
        : NO_AUTH_ACTOR;
      // `actor` is intentionally retained for upcoming per-action gating
      // (Spec 52 §4.5 — only scan entities the caller can read).
      void actor;

      const tenantId = resolveRequestTenantId
        ? await resolveRequestTenantId(request, actor)
        : undefined;

      const { createTenantAwareDataProvider } = await import("@linchkit/core/server");
      const scopedProvider =
        tenantId && rawDataProvider
          ? createTenantAwareDataProvider(rawDataProvider, tenantId)
          : rawDataProvider;

      const records = await scopedProvider.query(entityName, { limit: maxRecords });

      const { scanDataQuality } = await import("@linchkit/core/ai");
      const report = scanDataQuality(records, entityDef, {
        maxRecords,
        freshnessThresholdMs,
        outlierZThreshold,
      });

      return { success: true, data: report };
    } catch (err) {
      const errorMessage =
        process.env.NODE_ENV === "production"
          ? "Data quality scan failed."
          : err instanceof Error
            ? err.message
            : String(err);
      set.status = 500;
      return { success: false, error: { message: errorMessage } };
    }
  });
}
