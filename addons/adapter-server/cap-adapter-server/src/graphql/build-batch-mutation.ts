/**
 * GraphQL `batch_actions` mutation (Spec 04 §8).
 *
 * Mirrors the REST `POST /api/actions/batch` contract:
 * - per-item shape: { name, input } (input as JSON-encoded string for parity
 *   with the existing `executeAction` mutation — graphql-js code-first has no
 *   built-in JSON scalar, and stringly-encoded payloads keep us off a new
 *   runtime dep).
 * - response shape: full `BatchActionsResult` with succeeded / failed /
 *   rolledBack / summary, with per-item `data` and `record` JSON-encoded.
 *
 * Requires a CommandLayer because executing without the permission slot would
 * silently bypass auth — same guard the REST handler enforces. `all_or_nothing`
 * strategy further requires a TransactionManager (either passed via this
 * option or set on the CommandLayer); without one the engine returns a
 * structured `BATCH_TX_MANAGER_REQUIRED` failure.
 */

import type {
  BatchActionItem,
  BatchActionsInput,
  BatchActionsResult,
  BatchTransactionStrategy,
  CommandLayer,
  TransactionManager,
} from "@linchkit/core";
import {
  GraphQLBoolean,
  GraphQLError,
  type GraphQLFieldConfig,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
} from "graphql";
import { sanitizeBatchResult } from "../lib/sanitize-batch-result";
import type { GraphQLContext } from "./build-schema";
import { safeParseJSON } from "./json-arg";

// ── Batch action GraphQL types (Spec 04 §8) ──────────────────

const BatchActionInputItemType = new GraphQLInputObjectType({
  name: "BatchActionInputItem",
  description: "A single action invocation within a batch (Spec 04 §8.1).",
  fields: {
    name: {
      type: new GraphQLNonNull(GraphQLString),
      description: "Action name (verb_noun).",
    },
    input: {
      type: GraphQLString,
      description:
        "JSON-encoded action input object. Optional — omit (or send null) to invoke an action that takes no input, matching the REST batch contract.",
    },
  },
});

const BatchSucceededItemType = new GraphQLObjectType({
  name: "BatchSucceededItem",
  fields: {
    index: { type: new GraphQLNonNull(GraphQLInt) },
    executionId: { type: new GraphQLNonNull(GraphQLString) },
    data: { type: GraphQLString, description: "JSON-encoded handler return value" },
    record: { type: GraphQLString, description: "JSON-encoded persisted record" },
    warnings: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
  },
});

const BatchFailedItemErrorType = new GraphQLObjectType({
  name: "BatchFailedItemError",
  fields: {
    code: { type: new GraphQLNonNull(GraphQLString) },
    message: { type: new GraphQLNonNull(GraphQLString) },
    field: { type: GraphQLString },
  },
});

const BatchFailedItemType = new GraphQLObjectType({
  name: "BatchFailedItem",
  fields: {
    index: { type: new GraphQLNonNull(GraphQLInt) },
    executionId: { type: GraphQLString },
    error: { type: new GraphQLNonNull(BatchFailedItemErrorType) },
  },
});

const BatchActionsSummaryType = new GraphQLObjectType({
  name: "BatchActionsSummary",
  fields: {
    total: { type: new GraphQLNonNull(GraphQLInt) },
    succeeded: { type: new GraphQLNonNull(GraphQLInt) },
    failed: { type: new GraphQLNonNull(GraphQLInt) },
  },
});

const BatchActionsResultType = new GraphQLObjectType({
  name: "BatchActionsResult",
  fields: {
    success: { type: new GraphQLNonNull(GraphQLBoolean) },
    parentExecutionId: { type: new GraphQLNonNull(GraphQLString) },
    strategy: {
      type: new GraphQLNonNull(GraphQLString),
      description: "Strategy actually used: 'all_or_nothing' or 'partial'.",
    },
    succeeded: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(BatchSucceededItemType))),
    },
    failed: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(BatchFailedItemType))),
    },
    rolledBack: {
      type: new GraphQLList(new GraphQLNonNull(BatchSucceededItemType)),
      description:
        "Items that succeeded but were rolled back when a later item failed (all_or_nothing only).",
    },
    summary: { type: new GraphQLNonNull(BatchActionsSummaryType) },
  },
});

/**
 * Serialize a BatchActionsResult into the GraphQL output shape — `data` and
 * `record` are JSON-encoded so callers can decode arbitrary handler payloads
 * without us guessing a scalar shape.
 */
function serializeBatchResult(result: BatchActionsResult): {
  success: boolean;
  parentExecutionId: string;
  strategy: BatchTransactionStrategy;
  succeeded: Array<{
    index: number;
    executionId: string;
    data: string | null;
    record: string | null;
    warnings: string[] | null;
  }>;
  failed: Array<{
    index: number;
    executionId: string | null;
    error: { code: string; message: string; field: string | null };
  }>;
  rolledBack: Array<{
    index: number;
    executionId: string;
    data: string | null;
    record: string | null;
    warnings: string[] | null;
  }> | null;
  summary: { total: number; succeeded: number; failed: number };
} {
  const encodeSucceeded = (item: BatchActionsResult["succeeded"][number]) => ({
    index: item.index,
    executionId: item.executionId,
    data: item.data !== undefined ? JSON.stringify(item.data) : null,
    record: item.record ? JSON.stringify(item.record) : null,
    warnings: item.warnings && item.warnings.length > 0 ? item.warnings : null,
  });
  return {
    success: result.success,
    parentExecutionId: result.parentExecutionId,
    strategy: result.strategy,
    succeeded: result.succeeded.map(encodeSucceeded),
    failed: result.failed.map((item) => ({
      index: item.index,
      executionId: item.executionId ?? null,
      error: {
        code: item.error.code,
        message: item.error.message,
        field: item.error.field ?? null,
      },
    })),
    rolledBack: result.rolledBack ? result.rolledBack.map(encodeSucceeded) : null,
    summary: result.summary,
  };
}

export interface BuildBatchMutationFieldOptions {
  /**
   * CommandLayer pipeline. Required at runtime — without it the resolver
   * throws a GraphQLError because executing without the permission slot
   * would silently bypass auth (same guard the REST handler enforces).
   */
  commandLayer?: CommandLayer;
  /**
   * Transaction manager — used by the `batch_actions` mutation when the
   * caller chooses the `all_or_nothing` strategy (Spec 04 §8.2). When omitted
   * the CommandLayer's own default TM (set on `createCommandLayer`) is used;
   * if neither is available, `all_or_nothing` requests return a structured
   * `BATCH_TX_MANAGER_REQUIRED` failure — `partial` strategy still works.
   */
  transactionManager?: TransactionManager;
}

/**
 * Build the `batch_actions` GraphQL mutation field (Spec 04 §8).
 *
 * Mirrors `POST /api/actions/batch`: accepts an `actions` array of
 * { name, input } items plus optional `strategy` and `meta`, and returns
 * the full `BatchActionsResult` envelope.
 */
export function buildBatchMutationField(
  options: BuildBatchMutationFieldOptions,
): GraphQLFieldConfig<unknown, GraphQLContext> {
  const { commandLayer, transactionManager: batchTransactionManager } = options;
  return {
    type: new GraphQLNonNull(BatchActionsResultType),
    description:
      "Execute multiple actions in one call (Spec 04 §8). Mirrors POST /api/actions/batch.",
    args: {
      actions: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(BatchActionInputItemType))),
      },
      strategy: {
        type: GraphQLString,
        description:
          "Transaction strategy: 'all_or_nothing' (default) or 'partial' (Spec 04 §8.2).",
      },
      meta: {
        type: GraphQLString,
        description: "JSON-encoded execution meta applied to every batch item (Spec 65 §3.2)",
      },
    },
    resolve: commandLayer
      ? async (
          _root: unknown,
          args: {
            actions: Array<{ name: string; input?: string | null }>;
            strategy?: string;
            meta?: string;
          },
          ctx: GraphQLContext,
        ) => {
          // Validate strategy at the GraphQL boundary so callers get a clear
          // error instead of relying on the engine's runtime check (which
          // would still catch it but with a less specific code).
          if (
            args.strategy !== undefined &&
            args.strategy !== "all_or_nothing" &&
            args.strategy !== "partial"
          ) {
            throw new GraphQLError("Argument \"strategy\" must be 'all_or_nothing' or 'partial'.");
          }
          // Decode each item's JSON input — reject any malformed item early
          // so a single bad payload doesn't poison the whole batch with an
          // engine-level "invalid input" code. `input` is optional to mirror
          // the REST contract (POST /api/actions/batch normalizes a missing
          // input to `{}`); null / undefined here means "no input".
          const items: BatchActionItem[] = args.actions.map((raw, index) => ({
            name: raw.name,
            input:
              raw.input !== undefined && raw.input !== null
                ? safeParseJSON(raw.input, `actions[${index}].input`)
                : {},
          }));
          const meta =
            args.meta !== undefined && args.meta !== null
              ? safeParseJSON(args.meta, "meta")
              : undefined;
          const batchInput: BatchActionsInput = { actions: items };
          if (args.strategy !== undefined) {
            batchInput.strategy = args.strategy as BatchTransactionStrategy;
          }
          const result = await commandLayer.executeBatch({
            input: batchInput,
            actor: ctx.actor,
            channel: "http",
            tenantId: ctx.tenantId,
            locale: ctx.locale,
            headers: ctx.headers,
            transactionManager: batchTransactionManager,
            meta,
          });
          // Apply the same prod-mode sanitization the REST handler uses
          // — see `lib/sanitize-batch-result.ts` for the contract.
          return serializeBatchResult(sanitizeBatchResult(result));
        }
      : () => {
          throw new GraphQLError(
            "batch_actions mutation requires a CommandLayer to enforce permissions.",
          );
        },
  };
}
