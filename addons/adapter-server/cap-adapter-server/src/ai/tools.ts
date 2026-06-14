/**
 * AI Assistant Tools — Vercel AI SDK tool definitions.
 *
 * Provides entity-aware tools that the AI can call during chat conversations.
 * All data access goes through DataProvider (respects tenant isolation).
 * All action execution goes through CommandLayer (respects permissions).
 *
 * AI SDK v6: uses `inputSchema` (not `parameters`) with Zod schemas.
 */

import type {
  Actor,
  CommandLayer,
  DataProvider,
  EntityRegistry,
  OntologyRegistry,
} from "@linchkit/core";
import { tool } from "ai";
import { z } from "zod";

export interface ToolContext {
  /** Data provider for querying records (tenant-scoped) */
  dataProvider?: DataProvider;
  /** Command layer for executing actions (permission-aware) */
  commandLayer?: CommandLayer;
  /** Entity registry for metadata lookups */
  entityRegistry?: EntityRegistry;
  /** Ontology registry for rich entity descriptions */
  ontologyRegistry?: OntologyRegistry;
  /** Current authenticated actor (for command layer execution) */
  actor?: Actor;
  /** Whether mutating action execution should be exposed to the AI */
  allowActionExecution?: boolean;
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
    const dp = ctx.dataProvider;

    tools.queryRecords = tool({
      description:
        "Search and query records from an entity. Returns matching records as JSON. " +
        "Use this to help users find, list, or analyze their data.",
      inputSchema: z.object({
        entity: z.string().describe("The entity name to query (e.g. 'purchase_order', 'product')"),
        limit: z
          .number()
          .optional()
          .default(10)
          .describe("Maximum number of records to return (default: 10, max: 50)"),
      }),
      execute: async (input: { entity: string; limit?: number }) => {
        try {
          const effectiveLimit = Math.min(input.limit ?? 10, 50);
          const allRecords = await dp.query(input.entity, {});
          const total = allRecords.length;
          const records = allRecords.slice(0, effectiveLimit);
          return {
            entity: input.entity,
            records,
            total,
            returned: records.length,
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
        "Get a single record by its ID from an entity. " +
        "Use this when the user asks about a specific record.",
      inputSchema: z.object({
        entity: z.string().describe("The entity name"),
        id: z.string().describe("The record ID"),
      }),
      execute: async (input: { entity: string; id: string }) => {
        try {
          const record = await dp.get(input.entity, input.id);
          return { entity: input.entity, record };
        } catch (error) {
          return {
            error: error instanceof Error ? error.message : "Failed to get record",
          };
        }
      },
    });
  }

  // ── Execute action tool ──────────────────────────────────
  if (ctx.commandLayer && ctx.allowActionExecution !== false) {
    const cl = ctx.commandLayer;
    const actor = ctx.actor ?? { type: "system" as const, id: "ai-assistant", groups: [] };

    tools.executeAction = tool({
      description:
        "Execute a business action through the command layer. " +
        "This respects all permission and validation rules. " +
        "Use this when the user wants to create, update, delete records or perform business operations.",
      inputSchema: z.object({
        action: z
          .string()
          .describe("The action name to execute (e.g. 'create_product', 'approve_order')"),
        input: z
          .record(z.string(), z.unknown())
          .describe("The action input data as key-value pairs"),
      }),
      execute: async (params: { action: string; input: Record<string, unknown> }) => {
        try {
          const result = await cl.execute({
            command: params.action,
            input: params.input,
            actor,
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

  // ── Describe entity tool ──────────────────────────────────
  if (ctx.ontologyRegistry) {
    const ontology = ctx.ontologyRegistry;

    tools.describeEntity = tool({
      description:
        "Get detailed information about an entity including its fields, actions, states, and relations. " +
        "Use this to understand the structure and capabilities of a data type.",
      inputSchema: z.object({
        name: z.string().describe("The entity name to describe"),
      }),
      execute: async (input: { name: string }) => {
        const descriptor = ontology.describe(input.name);
        if (!descriptor) {
          return { error: `Entity '${input.name}' not found` };
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
          })),
          relations: descriptor.relations.map((r) => ({
            label: r.label,
            targetEntity: r.targetEntity,
            cardinality: r.cardinality,
          })),
        };
      },
    });

    tools.listEntities = tool({
      description:
        "List all available entities in the system. " +
        "Use this to give the user an overview of what data types exist.",
      inputSchema: z.object({}),
      execute: async () => {
        const names = ontology.listEntities();
        const entities = names.map((name) => {
          const desc = ontology.describe(name);
          return {
            name,
            label: desc?.label,
            description: desc?.description,
            fieldCount: desc ? Object.keys(desc.fields).length : 0,
            actionCount: desc?.actions.length ?? 0,
          };
        });
        return { entities, total: entities.length };
      },
    });

    tools.searchEntities = tool({
      description:
        "Search entities by keyword. Matches against entity names, labels, descriptions, and field names.",
      inputSchema: z.object({
        query: z.string().describe("Search keyword"),
      }),
      execute: async (input: { query: string }) => {
        const results = ontology.searchEntities(input.query);
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
  } else if (ctx.entityRegistry) {
    // Fallback: use EntityRegistry directly if Ontology is not available
    const sr = ctx.entityRegistry;

    tools.describeEntity = tool({
      description: "Get information about an entity including its fields.",
      inputSchema: z.object({
        name: z.string().describe("The entity name to describe"),
      }),
      execute: async (input: { name: string }) => {
        const schema = sr.get(input.name);
        if (!schema) {
          return { error: `Entity '${input.name}' not found` };
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
    inputSchema: z.object({
      path: z
        .string()
        .describe("The application path (e.g. '/entities/product', '/entities/order/abc-123')"),
      label: z.string().describe("A human-readable label for the navigation link"),
    }),
    // No execute — this is a client-side tool rendered by the UI
  });

  return tools;
}

// ── proposeMutation — the AG-UI HITL propose tool (Spec 71 §4.3) ─────
//
// The mutating tool the AG-UI runner exposes is EXECUTE-LESS, mirroring the
// #550 frontend-tool precedent (`buildFrontendToolSet` / `navigateTo`): a tool
// with an `inputSchema` and NO `execute`. When the model calls it, the step
// ends with the proposal un-executed (AI SDK: an unexecuted tool call produces
// no tool result, so `streamText` starts no follow-up step — the stream
// completes), which is exactly the moment the runner emits the interrupt
// outcome. Proposing ≠ executing (§6.5): this tool NEVER calls CommandLayer;
// the human gate sits between propose and execute. It is distinct from
// `executeAction` (the direct-execute tool, which stays OFF on the assistant
// stream via `allowActionExecution:false`).

/**
 * The reserved AG-UI HITL propose tool name. The runner suppresses this tool's
 * call frames from the stream at the source (§4.5) and turns the call into an
 * interrupt outcome; P2b/P3 match on this exact name.
 */
export const PROPOSE_MUTATION_TOOL_NAME = "proposeMutation";

/**
 * Reserved tool-call-id prefix for `proposeMutation` (§4.2 / §4.5 fallback).
 * The runner mints the interrupt's `toolCallId` with this prefix so a future
 * client-side fallback can drop any stray frame synchronously by id (the
 * primary suppression is server-side at the source). P2b/P3 match on it.
 */
export const PROPOSE_MUTATION_TOOL_CALL_ID_PREFIX = "lk:propose-mutation:";

/** The `proposeMutation` input shape: `{ action, input }` the model proposes. */
export const proposeMutationInputSchema = z.object({
  action: z
    .string()
    .describe("The action name to propose (e.g. 'create_product', 'approve_order')"),
  input: z
    .record(z.string(), z.unknown())
    .optional()
    .default({})
    .describe("The proposed action input data as key-value pairs (omit for a no-argument action)"),
});

/** The decoded `proposeMutation` argument shape. */
export interface ProposeMutationArgs {
  action: string;
  input: Record<string, unknown>;
}

/**
 * Build the execute-less `proposeMutation` tool (Spec 71 §4.3). Returns a
 * single-key tool set the runner merges alongside the read-only tools. NO
 * `execute` — calling it ends the run with the proposal captured, never a DB
 * write. Kept a sibling of `executeAction` (which is unrelated and stays OFF).
 */
export function buildProposeMutationTool() {
  return {
    [PROPOSE_MUTATION_TOOL_NAME]: tool({
      description:
        "Propose a data mutation (create / update / delete a record via a business action) " +
        "for the human to review and approve. Use this whenever the user asks to change data: " +
        "the proposal is surfaced as an approval card — it does NOT execute until the human approves. " +
        "Provide the target action name and its input.",
      inputSchema: proposeMutationInputSchema,
      // No execute — proposing is not executing (§6.5). The runner captures the
      // call, suppresses its stream frames (§4.5), and emits an interrupt.
    }),
  };
}
