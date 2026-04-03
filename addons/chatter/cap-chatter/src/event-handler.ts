/**
 * chatterAutoLog — auto-log event handler
 *
 * Generates log entries in the chatter timeline when records change.
 * Listens to record.created, record.updated, record.deleted, and
 * state.transition events from the EventBus.
 */

import type { EventHandlerDefinition } from "@linchkit/core";
import { defineEventHandler } from "@linchkit/core";
import type { ChatterService } from "./types";

// System fields excluded from change audit (noise reduction)
const EXCLUDED_SYSTEM_FIELDS = new Set([
  "updated_at",
  "_version",
  "created_at",
  "created_by",
  "updated_by",
  "is_deleted",
]);

// ── Field change formatter ──────────────────────────────────

function formatChangedFields(
  changedFields: string[],
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string {
  const lines = changedFields.map((field) => {
    const oldVal = before[field] ?? "(empty)";
    const newVal = after[field] ?? "(empty)";
    return `- **${field}**: ${oldVal} → ${newVal}`;
  });
  return `Updated ${changedFields.length} field(s):\n${lines.join("\n")}`;
}

// ── Event handler factory ───────────────────────────────────

/**
 * Create the chatter auto-log event handler.
 *
 * Takes a ChatterService instance as a dependency so the handler can
 * write messages without going through the CommandLayer.
 */
export function createChatterAutoLog(service: ChatterService): EventHandlerDefinition {
  return defineEventHandler({
    name: "chatter.auto_log",
    label: "Chatter Auto-Log",
    description: "Generates log entries in chatter when records change",

    listen: ["record.created", "record.updated", "record.deleted", "state.transition"],

    async handler(event, _ctx) {
      const schema = event.schema ?? (event.payload.schema as string | undefined);
      const recordId = event.recordId ?? (event.payload.recordId as string | undefined);

      if (!schema || !recordId) return;

      const actorId = event.actor.id;
      const actorType = event.actor.type;
      const tenantId = event.tenantId;

      type LogEntry = {
        body: string;
        logEvent: string;
        logMetadata: Record<string, unknown>;
      };

      let entry: LogEntry | null = null;

      switch (event.type) {
        case "record.created": {
          entry = {
            body: "Created this record.",
            logEvent: "record.created",
            logMetadata: {},
          };
          break;
        }

        case "record.updated": {
          // Support both payload conventions:
          // - changedFields + _old/_new (from build-crud-actions.ts)
          // - changedFields + before/after (from spec 53)
          const rawChanged = (event.payload.changedFields as string[] | undefined) ?? [];
          const oldData = (event.payload._old ?? event.payload.before) as
            | Record<string, unknown>
            | undefined;
          const newData = (event.payload._new ?? event.payload.after) as
            | Record<string, unknown>
            | undefined;

          const changedFields = rawChanged.filter((f) => !EXCLUDED_SYSTEM_FIELDS.has(f));

          if (changedFields.length === 0) return;

          const before: Record<string, unknown> = {};
          const after: Record<string, unknown> = {};
          for (const field of changedFields) {
            before[field] = oldData?.[field];
            after[field] = newData?.[field];
          }

          entry = {
            body: formatChangedFields(changedFields, before, after),
            logEvent: "record.updated",
            logMetadata: { changed_fields: changedFields, before, after },
          };
          break;
        }

        case "state.transition": {
          const from = event.payload.from as string | undefined;
          const to = event.payload.to as string | undefined;
          if (!from || !to) return;

          entry = {
            body: `Status: **${from}** → **${to}**`,
            logEvent: "state.transition",
            logMetadata: {
              from,
              to,
              action: event.payload.action,
            },
          };
          break;
        }

        case "record.deleted": {
          entry = {
            body: "Deleted this record.",
            logEvent: "record.deleted",
            logMetadata: {},
          };
          break;
        }

        default:
          return;
      }

      if (!entry) return;

      await service.createMessage({
        schemaName: schema,
        recordId,
        messageType: "log",
        body: entry.body,
        authorId: actorId,
        authorType: actorType,
        logEvent: entry.logEvent,
        logMetadata: entry.logMetadata,
        tenantId,
      });
    },
  });
}
