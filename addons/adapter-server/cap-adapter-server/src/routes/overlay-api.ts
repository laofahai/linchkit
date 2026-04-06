/**
 * REST endpoints for managing field overlays.
 *
 * - GET    /api/overlays/:entityName              — list overlay fields for entity
 * - POST   /api/overlays/:entityName              — add overlay field
 * - PUT    /api/overlays/:entityName/:fieldName   — update overlay field
 * - DELETE /api/overlays/:entityName/:fieldName   — deprecate overlay field
 */

import type { FieldOverlayRecord, OverlayFieldType } from "@linchkit/core";
import type { OverlayRegistry } from "@linchkit/core/server";
import type { Elysia } from "elysia";
import { badRequest, notFound } from "./shared";

/** Valid overlay field types */
const VALID_FIELD_TYPES = new Set<OverlayFieldType>([
  "string",
  "number",
  "boolean",
  "date",
  "enum",
  "json",
]);

/** System field names that cannot be used as overlay field names */
const RESERVED_NAMES = new Set([
  "id",
  "tenant_id",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
  "_version",
  "_extensions",
]);

export interface OverlayApiOptions {
  overlayRegistry: OverlayRegistry;
  /** Entity names that exist in the system (for validation) */
  entityNames?: Set<string>;
  /** Callback invoked after overlay CRUD to trigger schema rebuild */
  onOverlayChange?: (entityName: string) => void;
}

export function mountOverlayRoutes(app: Elysia, options: OverlayApiOptions): void {
  const { overlayRegistry, entityNames, onOverlayChange } = options;

  // GET /api/overlays/:entityName — list overlay fields for an entity
  app.get("/api/overlays/:entityName", ({ params }) => {
    const overlays = overlayRegistry.overlaysFor(params.entityName);
    return {
      success: true,
      data: overlays.map(serializeOverlay),
    };
  });

  // POST /api/overlays/:entityName — add overlay field
  app.post("/api/overlays/:entityName", async ({ params, body, set }) => {
    const entityName = params.entityName;

    // Validate entity exists (if entityNames set is provided)
    if (entityNames && !entityNames.has(entityName)) {
      return notFound(set, `Entity "${entityName}" not found.`);
    }

    const input = body as Record<string, unknown> | null;
    if (!input) {
      return badRequest(set, "Request body is required.");
    }

    // Validate required fields
    const fieldName = input.fieldName as string | undefined;
    const fieldType = input.fieldType as string | undefined;

    if (!fieldName || typeof fieldName !== "string") {
      return badRequest(set, "fieldName is required and must be a string.");
    }
    if (!fieldType || !VALID_FIELD_TYPES.has(fieldType as OverlayFieldType)) {
      return badRequest(
        set,
        `fieldType must be one of: ${Array.from(VALID_FIELD_TYPES).join(", ")}`,
      );
    }

    // Validate field name is not reserved
    if (RESERVED_NAMES.has(fieldName)) {
      set.status = 409;
      return {
        success: false,
        error: {
          message: `Field name "${fieldName}" is reserved and cannot be used as an overlay.`,
        },
      };
    }

    // Validate field name format (GraphQL-safe)
    if (!/^[_a-zA-Z][_a-zA-Z0-9]*$/.test(fieldName)) {
      return badRequest(
        set,
        `Field name "${fieldName}" must match GraphQL naming rules: start with letter or underscore, contain only alphanumerics and underscores.`,
      );
    }

    const config = (input.config as Record<string, unknown>) ?? {};

    try {
      const record = await overlayRegistry.register({
        entityName,
        fieldName,
        fieldType: fieldType as OverlayFieldType,
        config: {
          label: config.label as Record<string, string> | undefined,
          description: config.description as string | undefined,
          required: config.required as boolean | undefined,
          defaultValue: config.defaultValue,
          enumValues: config.enumValues as string[] | undefined,
          min: config.min as number | undefined,
          max: config.max as number | undefined,
          maxLength: config.maxLength as number | undefined,
        },
        status: "active",
      });

      onOverlayChange?.(entityName);

      set.status = 201;
      return { success: true, data: serializeOverlay(record) };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create overlay";
      // Duplicate field name → conflict
      if (message.includes("already exists")) {
        set.status = 409;
        return { success: false, error: { message } };
      }
      set.status = 500;
      return { success: false, error: { message } };
    }
  });

  // PUT /api/overlays/:entityName/:fieldName — update overlay field
  app.put("/api/overlays/:entityName/:fieldName", async ({ params, body, set }) => {
    const { entityName, fieldName } = params;

    // Find the overlay by entityName + fieldName
    const overlays = overlayRegistry.overlaysFor(entityName);
    const existing = overlays.find((o) => o.fieldName === fieldName);
    if (!existing) {
      return notFound(set, `Overlay field "${fieldName}" not found on entity "${entityName}".`);
    }

    const input = body as Record<string, unknown> | null;
    if (!input) {
      return badRequest(set, "Request body is required.");
    }

    const updates: Partial<Pick<FieldOverlayRecord, "fieldType" | "config">> = {};
    if (input.fieldType) {
      if (!VALID_FIELD_TYPES.has(input.fieldType as OverlayFieldType)) {
        return badRequest(
          set,
          `fieldType must be one of: ${Array.from(VALID_FIELD_TYPES).join(", ")}`,
        );
      }
      updates.fieldType = input.fieldType as OverlayFieldType;
    }
    if (input.config) {
      updates.config = input.config as FieldOverlayRecord["config"];
    }

    try {
      const record = await overlayRegistry.update(existing.id, updates);
      onOverlayChange?.(entityName);
      return { success: true, data: serializeOverlay(record) };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to update overlay";
      set.status = 500;
      return { success: false, error: { message } };
    }
  });

  // DELETE /api/overlays/:entityName/:fieldName — deprecate overlay field
  app.delete("/api/overlays/:entityName/:fieldName", async ({ params, set }) => {
    const { entityName, fieldName } = params;

    const overlays = overlayRegistry.overlaysFor(entityName);
    const existing = overlays.find((o) => o.fieldName === fieldName);
    if (!existing) {
      return notFound(set, `Overlay field "${fieldName}" not found on entity "${entityName}".`);
    }

    try {
      await overlayRegistry.deprecate(existing.id);
      onOverlayChange?.(entityName);
      return { success: true, data: { message: `Overlay field "${fieldName}" deprecated.` } };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to deprecate overlay";
      set.status = 500;
      return { success: false, error: { message } };
    }
  });
}

/** Serialize a FieldOverlayRecord for JSON response */
function serializeOverlay(record: FieldOverlayRecord): Record<string, unknown> {
  return {
    id: record.id,
    entityName: record.entityName,
    fieldName: record.fieldName,
    fieldType: record.fieldType,
    config: record.config,
    status: record.status,
    createdBy: record.createdBy,
    proposalId: record.proposalId,
    createdAt: record.createdAt instanceof Date ? record.createdAt.toISOString() : record.createdAt,
    updatedAt: record.updatedAt instanceof Date ? record.updatedAt.toISOString() : record.updatedAt,
  };
}
