/**
 * POST /api/ai/data-quality — Rule-based data quality scan for an entity schema.
 * Extracted from ai-api.ts to keep file size manageable.
 */

import type { Elysia } from "elysia";
import type { ServerOptions } from "../server";

export function mountDataQualityRoute(app: Elysia, options: ServerOptions): void {
  const entityRegistry = options.entityRegistry;

  app.post("/api/ai/data-quality", async ({ body, set }) => {
    const { entityName, options: scanOptions } = (body ?? {}) as {
      entityName?: string;
      options?: {
        freshnessThresholdMs?: number;
        outlierZThreshold?: number;
        maxRecords?: number;
      };
    };

    if (!entityName) {
      set.status = 400;
      return { success: false, error: { message: "entityName is required" } };
    }

    const dataProvider = options.dataProvider;
    if (!dataProvider) {
      set.status = 500;
      return { success: false, error: { message: "Data provider not configured." } };
    }

    const entityDef = entityRegistry?.get(entityName);
    if (!entityDef) {
      set.status = 404;
      return { success: false, error: { message: `Entity "${entityName}" not found.` } };
    }

    try {
      const rawMax = scanOptions?.maxRecords;
      const maxRecords =
        typeof rawMax === "number" && Number.isFinite(rawMax) && rawMax > 0
          ? Math.min(Math.floor(rawMax), 10000)
          : 1000;

      const validatedOptions = {
        maxRecords,
        freshnessThresholdMs:
          typeof scanOptions?.freshnessThresholdMs === "number" &&
          Number.isFinite(scanOptions.freshnessThresholdMs) &&
          scanOptions.freshnessThresholdMs > 0
            ? scanOptions.freshnessThresholdMs
            : undefined,
        outlierZThreshold:
          typeof scanOptions?.outlierZThreshold === "number" &&
          Number.isFinite(scanOptions.outlierZThreshold) &&
          scanOptions.outlierZThreshold > 0
            ? scanOptions.outlierZThreshold
            : undefined,
      };

      const records = await dataProvider.query(entityName, { limit: maxRecords });

      const { scanDataQuality } = await import("@linchkit/core/ai");
      const report = scanDataQuality(records, entityDef, validatedOptions);

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
