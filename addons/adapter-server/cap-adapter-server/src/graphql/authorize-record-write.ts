/**
 * Build a standalone "may this actor WRITE this record's entity" permission
 * gate, backed by the CommandLayer.
 *
 * Some capability-contributed GraphQL mutations are NOT backed by a meta-model
 * Action and therefore cannot route through `dispatchAction → commandLayer`
 * (which is how every CRUD / action mutation gets the permission slot). The
 * canonical example is cap-chatter's `chatterAddMessage`: it posts a comment by
 * writing a plain Drizzle row, not by executing an Action. Raw-merging that
 * resolver into the schema would let the write skip the permission slot — the
 * exact invariant ("All API endpoints go through CommandLayer") this guards.
 *
 * The CommandLayer already exposes a standalone authorization seam: a non-action
 * dispatch (`skipActionSlots: true`) runs `pre → auth → permission → tenant`
 * WITHOUT executing an action, and the permission middleware resolves a
 * `meta.recordWrite = { entity }` target to an entity-level WRITE check
 * (mirroring the onchange `meta.onchange` read-target). This helper drives that
 * seam: it returns a hook the GraphQL context carries, which the chatter resolver
 * calls before writing. A denial surfaces as a non-success ActionResult; the hook
 * throws so the resolver aborts the write.
 */

import type { Actor, CommandLayer } from "@linchkit/core";

/** Input to the record-write authorization gate. */
export interface AuthorizeRecordWriteInput {
  /** Entity the record belongs to (the write is gated on WRITE access to this). */
  entityName: string;
  /** Record id within that entity (forwarded for tracing / future row-level gates). */
  recordId: string;
  /** Request actor, already resolved by the auth slot upstream. */
  actor: Actor;
  /** Tenant scope for the write, when present. */
  tenantId?: string;
}

/**
 * Create the record-write authorization hook from a CommandLayer.
 *
 * The returned function runs a non-action CommandLayer dispatch that exercises
 * the real permission slot and THROWS when the actor is not permitted. The
 * synthetic command name is for metrics/tracing only — the authoritative target
 * is published in `meta.recordWrite`, so a group never has to grant the
 * synthetic name.
 */
export function createAuthorizeRecordWrite(
  commandLayer: CommandLayer,
): (input: AuthorizeRecordWriteInput) => Promise<void> {
  return async ({ entityName, recordId, actor, tenantId }) => {
    const result = await commandLayer.execute({
      command: `${entityName}.record_write`,
      input: { entity: entityName, recordId },
      actor,
      channel: "http",
      tenantId,
      meta: {
        recordWrite: { entity: entityName, recordId },
      },
      skipActionSlots: true,
    });

    if (!result.success) {
      const errData = result.data as Record<string, unknown> | undefined;
      const message =
        (errData?.error as string | undefined) ??
        `Permission denied: cannot write to "${entityName}".`;
      throw new Error(message);
    }
  };
}
