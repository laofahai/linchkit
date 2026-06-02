/**
 * cap-lock GraphQL extension — the read-side IoC counterpart to the
 * `field-lock-check` interceptor (Spec 63 §5.2).
 *
 * Registers a single GLOBAL query:
 *   fieldLockBypass: FieldLockBypass!
 *
 * The field-lock UI (#441) renders a lock icon on locked fields but has no way
 * to know whether the CURRENT actor is allowed to override those locks — that
 * decision lives only in this capability's runtime interceptor. This extension
 * surfaces it as a query so the UI can show an "unlock" affordance, WITHOUT
 * `adapter-server` / `adapter-ui` ever depending on cap-lock: adapter-server
 * auto-collects `graphqlExtensions` from installed capabilities via its
 * `assemble-schema.ts`, mirroring how cap-search / cap-chatter contribute
 * theirs.
 *
 * The query represents the actor's GLOBAL (policy-wide) bypass eligibility —
 * cap-lock policy is NOT per-entity, so the field takes no arguments. It reuses
 * the SHARED {@link evaluateActorBypass} predicate, so the hint can never drift
 * from the interceptor's actual enforcement (actor-level subset; tolerance is
 * intentionally excluded — see `./bypass`).
 */

import type { Actor } from "@linchkit/core";
import type { GraphQLFieldConfig, GraphQLResolveInfo } from "graphql";
import { GraphQLBoolean, GraphQLNonNull, GraphQLObjectType, GraphQLString } from "graphql";
import { type ActorBypassResult, evaluateActorBypass } from "./bypass";
import type { CapLockPolicy } from "./config";

// ── GraphQL types ───────────────────────────────────────────

const FieldLockBypassType = new GraphQLObjectType({
  name: "FieldLockBypass",
  description:
    "Whether the current actor may bypass field locks (cap-lock policy-wide). " +
    "Mirrors the actor-level subset of the `field-lock-check` interceptor decision.",
  fields: {
    canBypass: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: "True if the current actor may override field locks.",
    },
    reason: {
      type: GraphQLString,
      description:
        'Why the actor may bypass: "shadow" (shadow mode) or "bypass" ' +
        "(group membership). Null when `canBypass` is false.",
    },
  },
});

// ── Resolver context shape ──────────────────────────────────

interface LockResolverContext {
  actor?: Actor;
}

/** Anonymous fallback actor used when the resolver context carries none. */
const ANONYMOUS_ACTOR: Actor = { type: "system", id: "anonymous", groups: [] };

// ── Extension builder ───────────────────────────────────────

export interface LockGraphQLExtensionOptions {
  /** Resolved, fully-defaulted cap-lock policy (see `resolveCapLockPolicy`). */
  policy: CapLockPolicy;
}

export interface LockGraphQLExtension {
  /** GraphQL types contributed by cap-lock. */
  types: GraphQLObjectType[];
  /** Query fields to merge into the root Query type. */
  queryFields: Record<string, GraphQLFieldConfig<unknown, unknown>>;
}

/**
 * Build the GraphQL extension for cap-lock.
 *
 * Returns a single `fieldLockBypass` query field (no args). Its resolver reads
 * `ctx.actor` from the request context (set by the adapter's yoga context
 * factory) and returns the shared {@link evaluateActorBypass} result. The
 * resolver NEVER throws: when no actor is present it falls back to an anonymous,
 * empty-groups actor, which yields `{ canBypass: false, reason: null }` unless
 * shadow mode is on policy-wide.
 *
 * The `FieldLockBypass` object type is reachable from this field's return type,
 * so graphql-js registers it automatically — only `queryFields` need to be
 * threaded into the capability manifest. `types` is returned for symmetry with
 * the sibling extensions and for direct testability.
 */
export function buildLockGraphQLExtension(
  options: LockGraphQLExtensionOptions,
): LockGraphQLExtension {
  const { policy } = options;

  const fieldLockBypass: GraphQLFieldConfig<unknown, unknown> = {
    type: new GraphQLNonNull(FieldLockBypassType),
    description:
      "Whether the current actor may bypass field locks (cap-lock policy-wide). " +
      "Used by the auto-form to show an unlock affordance on locked fields.",
    resolve: (
      _source: unknown,
      _args: Record<string, never>,
      context: unknown,
      _info: GraphQLResolveInfo,
    ): ActorBypassResult => {
      const ctx = (context ?? {}) as LockResolverContext;
      const actor = ctx.actor ?? ANONYMOUS_ACTOR;
      return evaluateActorBypass(actor, policy);
    },
  };

  return {
    types: [FieldLockBypassType],
    queryFields: { fieldLockBypass },
  };
}
