/**
 * AI Assistant Tools — Vercel AI SDK tool definitions.
 *
 * Provides schema-aware tools that the AI can call during chat conversations.
 * All data access goes through DataProvider (respects tenant isolation).
 * All action execution goes through CommandLayer (respects permissions).
 */

import type {
  Actor,
  CommandLayer,
  DataProvider,
  OntologyRegistry,
  SchemaRegistry,
} from "@linchkit/core";
import { tool } from "ai";
import { z } from "zod";

export interface ToolContext {
  /** Data provider for querying records (tenant-scoped) */
  dataProvider?: DataProvider;
  /** Command layer for executing actions (permission-aware) */
  commandLayer?: CommandLayer;
  /** Schema registry for metadata lookups */
  schemaRegistry?: SchemaRegistry;
  /** Ontology registry for rich schema descriptions */
  ontologyRegistry?: OntologyRegistry;
  /** Current authenticated actor (for command layer execution) */
  actor?: Actor;
}

/**
 * Build AI tools based on available context.
 * Only includes tools for which the required dependencies are available.
 */
export function buildTools(ctx: ToolContext) {
  // biome-ignore lint/suspicious/noExplicitAny: Vercel AI SDK tool types are complex
  const tools: Record<string, any> = {};

  // ── Query records tool ──────────────────────────────────
  if (ctx.dataProvider) {
    tools.queryRecords = tool({
      description:
        "Search and query records from a schema. Returns matching records as JSON. " +
        "Use this to help users find, list, or analyze their data.",
      parameters: z.object({
        schema: z.string().describe("The schema name to query (e.g. 'purchase_order', 'product')"),
        limit: z
          .number()
          .optional()
          .default(10)
          .describe("Maximum number of records to return (default: 10, max: 50)"),
        offset: z
          .number()
          .optional()
          .default(0)
          .describe("Number of records to skip for pagination"),
      }),
      execute: async ({ schema, limit, offset }) => {
        try {
          const effectiveLimit = Math.min(limit ?? 10, 50);
          const result = await ctx.dataProvider!.list(schema, {
            limit: effectiveLimit,
            offset: offset ?? 0,
          });
          return {
            schema,
            records: result.records,
            total: result.total,
            returned: result.records.length,
          };
        } catch (error) {
          return {
            error: error instanceof Error ? error.message : "Failed to query records",
          };
        }
      },
    });

    // ── Get single record tool ──────────────────────────────
    tools.getRecord = tool({
      description:
        "Get a single record by its ID from a schema. " +
        "Use this when the user asks about a specific record.",
      parameters: z.object({
        schema: z.string().describe("The schema name"),
        id: z.string().describe("The record ID"),
      }),
      execute: async ({ schema, id }) => {
        try {
          const record = await ctx.dataProvider!.get(schema, id);
          if (!record) {
            return { error: `Record ${id} not found in ${schema}` };
          }
          return { schema, record };
        } catch (error) {
          return {
            error: error instanceof Error ? error.message : "Failed to get record",
          };
        }
      },
    });
  }

  // ── Execute action tool ──────────────────────────────────
  if (ctx.commandLayer) {
    tools.executeAction = tool({
      description:
        "Execute a business action through the command layer. " +
        "This respects all permission and validation rules. " +
        "Use this when the user wants to create, update, delete records or perform business operations.",
      parameters: z.object({
        action: z.string().describe("The action name to execute (e.g. 'create_product', 'approve_order')"),
        input: z
          .record(z.unknown())
          .describe("The action input data as key-value pairs"),
      }),
      execute: async ({ action, input }) => {
        try {
          const result = await ctx.commandLayer!.execute(action, input, {
            actor: ctx.actor ?? { type: "system", id: "ai-assistant", groups: [] },
          });
          return {
            success: result.success,
            data: result.data,
            error: result.success ? undefined : "Action failed",
          };
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : "Action execution failed",
          };
        }
      },
    });
  }

  // ── Describe schema tool ──────────────────────────────────
  if (ctx.ontologyRegistry) {
    tools.describeSchema = tool({
      description:
        "Get detailed information about a schema including its fields, actions, states, and relations. " +
        "Use this to understand the structure and capabilities of a data type.",
      parameters: z.object({
        name: z.string().describe("The schema name to describe"),
      }),
      execute: async ({ name }) => {
        const descriptor = ctx.ontologyRegistry!.describe(name);
        if (!descriptor) {
          return { error: `Schema '${name}' not found` };
        }
        return {
          name: descriptor.name,
          label: descriptor.label,
          description: descriptor.description,
          fields: Object.entries(descriptor.fields).map(([fieldName, field]) => ({
            name: fieldName,
            type: field.type,
            label: field.label,
            required: field.required,
          })),
          actions: descriptor.actions.map((a) => ({
            name: a.name,
            label: a.label,
            type: a.type,
          })),
          relations: descriptor.relations.map((r) => ({
            label: r.label,
            relatedSchema: r.relatedSchema,
            cardinality: r.cardinality,
          })),
        };
      },
    });

    tools.listSchemas = tool({
      description:
        "List all available schemas in the system. " +
        "Use this to give the user an overview of what data types exist.",
      parameters: z.object({}),
      execute: async () => {
        const names = ctx.ontologyRegistry!.listSchemas();
        const schemas = names.map((name) => {
          const desc = ctx.ontologyRegistry!.describe(name);
          return {
            name,
            label: desc?.label,
            description: desc?.description,
            fieldCount: desc ? Object.keys(desc.fields).length : 0,
            actionCount: desc?.actions.length ?? 0,
          };
        });
        return { schemas, total: schemas.length };
      },
    });

    tools.searchSchemas = tool({
      description:
        "Search schemas by keyword. Matches against schema names, labels, descriptions, and field names.",
      parameters: z.object({
        query: z.string().describe("Search keyword"),
      }),
      execute: async ({ query }) => {
        const results = ctx.ontologyRegistry!.searchSchemas(query);
        return {
          results: results.map((d) => ({
            name: d.name,
            label: d.label,
            description: d.description,
          })),
          total: results.length,
        };
      },
    });
  } else if (ctx.schemaRegistry) {
    // Fallback: use SchemaRegistry directly if Ontology is not available
    tools.describeSchema = tool({
      description: "Get information about a schema including its fields.",
      parameters: z.object({
        name: z.string().describe("The schema name to describe"),
      }),
      execute: async ({ name }) => {
        const schema = ctx.schemaRegistry!.get(name);
        if (!schema) {
          return { error: `Schema '${name}' not found` };
        }
        return {
          name: schema.name,
          label: schema.label,
          fields: Object.entries(schema.fields).map(([fieldName, field]) => ({
            name: fieldName,
            type: field.type,
            label: field.label,
            required: field.required,
          })),
        };
      },
    });
  }

  // ── Navigate tool (client-side, no execute) ──────────────
  tools.navigateTo = tool({
    description:
      "Suggest navigation to a specific page in the application. " +
      "Use this when the user wants to view a list, form, or specific record. " +
      "The result will be rendered as a clickable link in the chat.",
    parameters: z.object({
      path: z.string().describe("The application path (e.g. '/schemas/product', '/schemas/order/abc-123')"),
      label: z.string().describe("A human-readable label for the navigation link"),
    }),
    // No execute — this is a client-side tool rendered by the UI
  });

  return tools;
}
