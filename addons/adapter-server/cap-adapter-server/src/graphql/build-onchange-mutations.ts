/**
 * Auto-generated `<entity>_onchange` GraphQL mutations (Spec 64 §4.2).
 *
 * For each registered EntityDefinition that declares an `onchange` map, emit
 * one mutation field with the name `<entityName>_onchange`. The resolver
 * mirrors the REST endpoint's authorization + evaluation flow:
 *
 *   1. Dispatch through CommandLayer with `skipActionSlots: true` so the
 *      pre / auth / exposure / permission / tenant slots run, but
 *      pre-action / post-action do not (onchange is read-only — Spec 64 §4.3).
 *   2. On any pipeline failure, return a canonical AUTHZ_DENIED GraphQL
 *      error so the response cannot be used as a side-channel to enumerate
 *      which entities exist or have onchange hooks (Non-blocker 4 from PR #198).
 *   3. Run the OnchangeEvaluator with the resolved tenantId / actor and
 *      return `{ updates: <json>, warnings: [...] }`.
 *
 * GraphQL has no native JSON scalar in this codebase; following the existing
 * `executeAction` precedent, both the input `values` argument and the
 * `updates` output field are JSON-encoded strings. Clients `JSON.parse` to
 * obtain the object.
 */

import type { CommandLayer, EntityDefinition } from "@linchkit/core";
import type { OnchangeEvaluator } from "@linchkit/core/server";
import { consoleLogger, OnchangeEvaluatorError } from "@linchkit/core/server";
import {
  GraphQLError,
  type GraphQLFieldConfig,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
} from "graphql";
import { resolveStatusCode } from "../routes/shared";
import type { GraphQLContext } from "./build-schema";

const MAX_VALUES_LENGTH = 10_000;

/** Stable response type used by every auto-generated `<entity>_onchange` mutation. */
const OnchangeResponseType = new GraphQLObjectType({
  name: "OnchangeResponse",
  fields: {
    updates: {
      type: new GraphQLNonNull(GraphQLString),
      description: "JSON-encoded map of suggested field updates",
    },
    warnings: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))),
      description: "Non-blocking warnings to surface to the user",
    },
  },
});

export interface BuildOnchangeMutationsOptions {
  /** CommandLayer that will run pre/auth/exposure/permission/tenant slots. */
  commandLayer?: CommandLayer;
  /** OnchangeEvaluator for the actual computation. */
  onchangeEvaluator?: OnchangeEvaluator;
}

/**
 * Build the per-entity onchange mutation fields. Emits no fields when either
 * a CommandLayer or evaluator is missing (matches the REST `503` semantics —
 * the GraphQL surface simply omits the mutation rather than serving a broken
 * one). Entities without an `onchange` map are skipped.
 */
export function buildOnchangeMutationFields(
  entities: EntityDefinition[],
  options: BuildOnchangeMutationsOptions,
): Record<string, GraphQLFieldConfig<unknown, GraphQLContext>> {
  const { commandLayer, onchangeEvaluator } = options;
  if (!commandLayer || !onchangeEvaluator) return {};

  const fields: Record<string, GraphQLFieldConfig<unknown, GraphQLContext>> = {};

  for (const entity of entities) {
    if (!entity.onchange || Object.keys(entity.onchange).length === 0) continue;

    const entityName = entity.name;
    const fieldName = `${entityName}_onchange`;

    fields[fieldName] = {
      type: new GraphQLNonNull(OnchangeResponseType),
      description: `Compute suggested form-field updates for ${entityName} (Spec 64).`,
      args: {
        changedField: { type: new GraphQLNonNull(GraphQLString) },
        values: {
          type: new GraphQLNonNull(GraphQLString),
          description: "JSON-encoded map of current form values",
        },
      },
      resolve: async (
        _root: unknown,
        args: { changedField: string; values: string },
        ctx: GraphQLContext,
      ) => {
        // ── Run CommandLayer (auth/permission/tenant) FIRST ────────
        // Codex Round-1 P3: keep the uniform-denial property — input
        // validation runs AFTER auth so an unauthenticated probe cannot
        // distinguish "endpoint exists, request shape rejected" from
        // "endpoint denied". An attacker forging an oversized or malformed
        // `values` arg must hit the same canonical AUTHZ_DENIED as a
        // request that's well-formed but unauthorized.
        const commandResult = await commandLayer.execute({
          command: `${entityName}.onchange`,
          input: { entity: entityName, changedField: args.changedField },
          actor: ctx.actor,
          // Existing GraphQL mutations route as "http" — keep that convention
          // so per-channel exposure / metrics behave identically across REST
          // and GraphQL onchange calls.
          channel: "http",
          tenantId: ctx.tenantId,
          locale: ctx.locale,
          meta: {
            onchange: {
              entity: entityName,
              changedField: args.changedField,
            },
          },
          skipActionSlots: true,
        });

        if (!commandResult.success) {
          // Codex Round-1 P2: only canonicalize 401/403 to AUTHZ_DENIED.
          // Other pipeline failures (rate_limit.exceeded → 429, fail-closed
          // PERMISSION.MIDDLEWARE_MISSING → 500, etc.) carry meaningful
          // semantics that GraphQL clients need to distinguish — collapsing
          // every failure into 403 would mask retryable/operator-actionable
          // states behind RBAC denials.
          const errData = commandResult.data as Record<string, unknown> | undefined;
          const middlewareCode = (errData?.code as string) ?? "ONCHANGE.BLOCKED";
          const middlewareMessage = (errData?.error as string) ?? "Onchange request blocked";
          const status = resolveStatusCode(commandResult);

          if (status === 401 || status === 403) {
            consoleLogger.warn("onchange-graphql: authorization denied", {
              entity: entityName,
              changedField: args.changedField,
              actor: ctx.actor.id,
              middlewareCode,
              middlewareMessage,
            });
            throw new GraphQLError("Access denied", {
              extensions: { code: "AUTHZ_DENIED", http: { status: 403 } },
            });
          }

          // Non-auth pipeline failure: surface the structured code/message so
          // clients can branch on it (e.g. throttling → backoff). Operator
          // detail is preserved here — auth gates already passed if we got a
          // non-401/403 status, so leaking the code is safe.
          throw new GraphQLError(middlewareMessage, {
            extensions: { code: middlewareCode, http: { status } },
          });
        }

        // ── Post-auth: validate `values` JSON ───────────────────
        // Codex Round-1 P3: validation lives AFTER auth so that the
        // "endpoint exists" signal can only be observed by authorized
        // callers. Stable extension codes let clients distinguish bad
        // input shape from an unrecognized field or evaluator failure.
        if (args.values.length > MAX_VALUES_LENGTH) {
          throw new GraphQLError(
            `Argument "values" exceeds maximum allowed length of ${MAX_VALUES_LENGTH} characters`,
            { extensions: { code: "INVALID_REQUEST.VALUES_TOO_LARGE" } },
          );
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(args.values);
        } catch {
          throw new GraphQLError('Argument "values" contains invalid JSON', {
            extensions: { code: "INVALID_REQUEST.MALFORMED_VALUES" },
          });
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new GraphQLError('Argument "values" must be a JSON object', {
            extensions: { code: "INVALID_REQUEST.MALFORMED_VALUES" },
          });
        }
        const values = parsed as Record<string, unknown>;

        // ── Run evaluator ───────────────────────────────────────
        const resolvedContext =
          commandResult.data && typeof commandResult.data === "object"
            ? (commandResult.data as { tenantId?: string; locale?: string })
            : undefined;
        try {
          const result = await onchangeEvaluator.evaluate({
            entityName,
            changedField: args.changedField,
            values,
            actor: ctx.actor,
            tenantId: resolvedContext?.tenantId ?? ctx.tenantId,
          });
          return {
            updates: JSON.stringify(result.updates),
            warnings: result.warnings,
          };
        } catch (err) {
          if (err instanceof OnchangeEvaluatorError) {
            // Map evaluator codes to GraphQL extensions. The error message is
            // safe to expose post-auth (mirrors REST behavior).
            throw new GraphQLError(err.message, {
              extensions: { code: `ONCHANGE.${err.code}` },
            });
          }
          // Codex Round-1 P3: unknown failure — log full detail server-side
          // and return a fixed message so SQL driver / upstream HTTP error
          // strings can't leak through the client-visible GraphQL error.
          consoleLogger.warn("onchange-graphql: unexpected evaluator failure", {
            entity: entityName,
            changedField: args.changedField,
            actor: ctx.actor.id,
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          });
          throw new GraphQLError("Onchange evaluation failed", {
            extensions: { code: "ONCHANGE.EVALUATION_FAILED" },
          });
        }
      },
    };
  }

  return fields;
}
