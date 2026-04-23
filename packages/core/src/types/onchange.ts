/**
 * Onchange type definitions (Spec 64).
 *
 * Onchange hooks compute suggested field values while the user is still editing
 * a form — BEFORE any Action is submitted. They are triggered by the form UI
 * (via `POST /api/entities/:name/onchange`) and return a partial record the
 * client can apply to the unsaved form state.
 *
 * Onchange is NOT part of the Action Engine write path. It requires read-level
 * permission only and never writes to the database.
 *
 * See: docs/specs/64_entity_onchange.md
 */

import type { Actor } from "./action";

/**
 * Runtime context passed to every onchange `compute` function.
 *
 * The only data-access helpers exposed are `lookup` and `query`. They must be
 * backed by a permission-scoped DataProvider so the caller's tenant and
 * read-permissions are enforced — no write methods are exposed.
 */
export interface OnchangeContext {
  /** The field that triggered this onchange evaluation. */
  changedField: string;

  /** New value of the changed field (as supplied by the form). */
  value: unknown;

  /**
   * All current form values, including prior onchange results merged in during
   * chained evaluation. Safe to read, must not be mutated.
   */
  values: Record<string, unknown>;

  /** Authenticated actor performing the edit. */
  actor: Actor;

  /** Tenant ID of the current session (when multi-tenant). */
  tenantId?: string;

  /**
   * Fetch a single field value from another entity record.
   * Equivalent to: SELECT `<field>` FROM `<entity>` WHERE id = `<id>`.
   * Returns `undefined` when the record / field cannot be read (permission or
   * not found) — it never throws.
   */
  lookup(entity: string, id: string, field: string): Promise<unknown>;

  /**
   * Fetch a list of records from another entity.
   * Results are read-only and permission-scoped via the DataProvider.
   */
  query(entity: string, filter: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
}

/**
 * Structured result produced by a single onchange hook and returned to the UI.
 */
export interface OnchangeResult {
  /** Field values to apply to the form. Only fields in the hook's `updates` allowlist survive. */
  updates: Record<string, unknown>;

  /** Optional non-blocking warnings surfaced to the UI. */
  warnings?: string[];
}

/**
 * Declarative onchange hook attached to an entity definition.
 *
 * Keys on `EntityDefinition.onchange` are either a single field name (e.g.
 * `"product_id"`) or a comma-separated list of field names (e.g.
 * `"quantity,unit_price"`). A comma-key hook fires when ANY listed field is
 * the triggering change.
 */
export interface OnchangeDefinition {
  /**
   * Field names this hook is allowed to update. Any field returned outside of
   * this allowlist is silently dropped (Spec 64 §9.3).
   */
  updates: string[];

  /**
   * Per-hook timeout in milliseconds. When omitted the evaluator default
   * (2000 ms, Spec 64 §9.4) applies. Exceeding the timeout produces a warning
   * and an empty update set for this hook.
   */
  timeout?: number;

  /**
   * Pure read-only computation. May return either a plain record (treated as
   * `{ updates: <record> }`) or a full `OnchangeResult` with warnings.
   */
  compute: (
    ctx: OnchangeContext,
  ) =>
    | OnchangeResult
    | Promise<OnchangeResult>
    | Record<string, unknown>
    | Promise<Record<string, unknown>>;
}
