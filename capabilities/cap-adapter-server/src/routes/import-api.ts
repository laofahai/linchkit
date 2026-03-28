/**
 * Data import REST endpoint.
 *
 * - POST /api/schemas/:name/import — bulk import via JSON or CSV file upload
 */

import type { Elysia } from "elysia";
import type { ServerOptions } from "../server";
import { resolveActor, resolveRequestLocale } from "./shared";

export function mountImportRoutes(app: Elysia, options: ServerOptions): void {
  const executor = options.executor;
  const commandLayer = options.commandLayer;
  const schemaRegistry = options.schemaRegistry;
  const resolveRequestActor = options.resolveRequestActor;

  app
    // ── Data Import endpoint ────────────────────────────────
    // Accepts multipart form data with a JSON/CSV file, creates records via CommandLayer
    .post("/api/schemas/:name/import", async ({ params, request, set }) => {
      if (!commandLayer && !executor) {
        set.status = 500;
        return { success: false, error: { message: "Action executor not configured." } };
      }

      if (!schemaRegistry) {
        set.status = 500;
        return { success: false, error: { message: "Schema registry not configured." } };
      }

      const schema = schemaRegistry.get(params.name);
      if (!schema) {
        set.status = 404;
        return { success: false, error: { message: `Schema "${params.name}" not found.` } };
      }

      // Resolve actor
      const actor = await resolveActor(request, resolveRequestActor);
      const locale = resolveRequestLocale(request);

      try {
        // Parse multipart form data
        const formData = await request.formData();
        const file = formData.get("file") as File | null;
        const format = (formData.get("format") as string) ?? "json";

        if (!file) {
          set.status = 400;
          return { success: false, error: { message: "No file provided." } };
        }

        const content = await file.text();
        let records: Record<string, unknown>[];

        if (format === "csv") {
          // Parse CSV
          const lines = content.split(/\r?\n/).filter((l: string) => l.trim().length > 0);
          if (lines.length < 2) {
            set.status = 400;
            return {
              success: false,
              error: { message: "CSV file must have a header row and at least one data row." },
            };
          }
          const headerLine = lines[0] ?? "";
          const headers = headerLine.split(",").map((h: string) => h.trim());
          records = [];
          for (let i = 1; i < lines.length; i++) {
            const values = lines[i]?.split(",");
            const record: Record<string, unknown> = {};
            for (let j = 0; j < headers.length; j++) {
              record[headers[j] ?? ""] = values?.[j]?.trim() ?? "";
            }
            records.push(record);
          }
        } else {
          // Parse JSON
          const parsed = JSON.parse(content);
          records = Array.isArray(parsed) ? parsed : [parsed];
        }

        // Import records one by one through the action pipeline
        let imported = 0;
        const errors: Array<{ row: number; error: string }> = [];
        const createActionName = `create_${params.name}`;

        for (let i = 0; i < records.length; i++) {
          try {
            const input = records[i] ?? {};
            if (commandLayer) {
              const result = await commandLayer.execute({
                command: createActionName,
                input,
                actor,
                channel: "http",
                locale,
              });
              if (!result.success) {
                const errData = result.data as Record<string, unknown> | undefined;
                const msg = (errData?.error as string) ?? "Import failed";
                errors.push({ row: i + 1, error: msg });
                continue;
              }
            } else if (executor) {
              const result = await executor.execute(createActionName, input, actor, {
                channel: "http",
                locale,
              });
              if (!result.success) {
                const errData = result.data as Record<string, unknown> | undefined;
                const msg = (errData?.error as string) ?? "Import failed";
                errors.push({ row: i + 1, error: msg });
                continue;
              }
            }
            imported++;
          } catch (err) {
            errors.push({
              row: i + 1,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        return {
          success: true,
          data: { imported, errors },
        };
      } catch (err) {
        set.status = 400;
        return {
          success: false,
          error: {
            message: err instanceof Error ? err.message : "Failed to process import file.",
          },
        };
      }
    });
}
