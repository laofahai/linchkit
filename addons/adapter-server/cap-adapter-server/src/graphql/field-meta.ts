/**
 * Field-lock introspection metadata (Spec 63 §6, Phase 2).
 *
 * Exposes the STATIC, declarative lock metadata of an entity's fields in the
 * generated GraphQL schema so clients can pre-compute which fields are
 * immutable / conditionally locked without trial-and-error mutations.
 *
 * This is schema metadata only — it does NOT evaluate a lock condition against
 * a live record. Resolving "is this field locked for THIS record right now?"
 * is the Phase-1 runtime engine's job (`matchesLockCondition`) and the UI's
 * job (Spec 63 §5.1). Here we only surface the declared rules:
 *
 *  - per-field `immutable` (and the deprecated `readonly` alias, which the
 *    engine treats as immutable — see Spec 63 §8)
 *  - per-field `lockWhen` (a {@link LockCondition})
 *  - entity-level `lockAllWhen` + `lockAllowFields` (the `__all__` shorthand)
 *
 * The vocabulary mirrors core's declarations exactly (`state`, `not`,
 * `domain`, `lockAllWhen`, `lockAllowFields`) so clients can reason about the
 * metadata with the same model the engine uses.
 */

import type { EntityDefinition, LockCondition } from "@linchkit/core";
import {
  GraphQLBoolean,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  type GraphQLOutputType,
  GraphQLString,
} from "graphql";

/**
 * The same system-field set the Phase-1 checker auto-exempts from
 * `lockAllWhen` (`packages/core/src/engine/field-lock-checker.ts`). We mirror
 * it here so the introspected "effective lock condition" of a field matches
 * what the runtime engine will actually enforce: a system field is never
 * covered by `lockAllWhen`, even though an explicit per-field `lockWhen` on it
 * still applies. Kept in sync manually — core does not export this set.
 */
const SYSTEM_FIELD_NAMES = new Set([
  "id",
  "tenant_id",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
  "_version",
  "deleted_at",
  "status",
]);

/**
 * Serializable projection of a {@link LockCondition} for GraphQL.
 *
 * `LockCondition.state` is a union (`string | string[] | { not }`) that has no
 * single clean GraphQL scalar, so it is flattened into two list fields plus a
 * JSON fallback that preserves the exact authored shape:
 *
 *  - `stateIn`    — states that LOCK the field (positive form: `"submitted"`
 *                   or `["submitted","approved"]`). Null for the `not` form.
 *  - `stateNotIn` — states that, when current, do NOT lock; i.e. the field is
 *                   locked when status is anything EXCEPT these (`{ not }`
 *                   form). Null for the positive form.
 *  - `domain`     — JSON-encoded `domain` clause (Spec 63 reserves it for a
 *                   future phase; surfaced verbatim so clients can detect it).
 *  - `raw`        — JSON of the entire LockCondition, for forward-compat with
 *                   clauses this projection does not yet model.
 */
export interface LockConditionMeta {
  stateIn: string[] | null;
  stateNotIn: string[] | null;
  domain: string | null;
  raw: string;
}

/**
 * Static lock metadata for a single field (Spec 63 §6 `FieldMeta`).
 *
 * `lockWhen` is the field's EFFECTIVE static lock condition: the per-field
 * `lockWhen` if declared, otherwise the entity-level `lockAllWhen` when the
 * field is covered by it (i.e. not in `lockAllowFields` and not a system
 * field). This matches the resolution order the Phase-1 engine uses, so a
 * client reading `FieldMeta.lockWhen` sees the same rule the engine enforces.
 *
 * `lockSource` reports WHERE that effective condition came from so clients can
 * distinguish a deliberate per-field rule from the entity-wide shorthand.
 */
export interface FieldMeta {
  name: string;
  immutable: boolean;
  lockWhen: LockConditionMeta | null;
  lockSource: FieldMetaLockSource;
}

export type FieldMetaLockSource = "none" | "field" | "entity";

/**
 * Project a {@link LockCondition} into its serializable GraphQL form. The
 * authored vocabulary is preserved verbatim in `raw`; the convenience list
 * fields are derived from `state` only.
 */
export function toLockConditionMeta(condition: LockCondition): LockConditionMeta {
  let stateIn: string[] | null = null;
  let stateNotIn: string[] | null = null;

  const spec = condition.state;
  if (typeof spec === "string") {
    stateIn = [spec];
  } else if (Array.isArray(spec)) {
    stateIn = [...spec];
  } else if (spec && typeof spec === "object") {
    const excluded = spec.not;
    stateNotIn = typeof excluded === "string" ? [excluded] : [...excluded];
  }

  return {
    stateIn,
    stateNotIn,
    domain: condition.domain ? JSON.stringify(condition.domain) : null,
    raw: JSON.stringify(condition),
  };
}

/**
 * Resolve the EFFECTIVE static lock condition for a field, applying the same
 * precedence the Phase-1 engine uses:
 *
 *  1. an explicit per-field `lockWhen` always wins (source = "field");
 *  2. otherwise the entity-level `lockAllWhen` applies, UNLESS the field is in
 *     `lockAllowFields` or is a system field (source = "entity");
 *  3. otherwise no lock condition (source = "none").
 */
function resolveLockCondition(
  fieldName: string,
  fieldLockWhen: LockCondition | undefined,
  entity: EntityDefinition,
): { condition: LockCondition | undefined; source: FieldMetaLockSource } {
  if (fieldLockWhen) {
    return { condition: fieldLockWhen, source: "field" };
  }
  const exempt = entity.lockAllowFields?.includes(fieldName) || SYSTEM_FIELD_NAMES.has(fieldName);
  if (!exempt && entity.lockAllWhen) {
    return { condition: entity.lockAllWhen, source: "entity" };
  }
  return { condition: undefined, source: "none" };
}

/**
 * Build the static {@link FieldMeta} list for every user-defined field of an
 * entity. System fields are not included — they are framework-managed and
 * never user-writable, so their lock state is not actionable for clients.
 *
 * Pure function of the {@link EntityDefinition}: no live record is consulted.
 */
export function buildFieldMetaList(entity: EntityDefinition): FieldMeta[] {
  const metas: FieldMeta[] = [];

  for (const [fieldName, field] of Object.entries(entity.fields)) {
    const immutable = field.immutable === true || field.readonly === true;
    const { condition, source } = resolveLockCondition(fieldName, field.lockWhen, entity);

    metas.push({
      name: fieldName,
      immutable,
      lockWhen: condition ? toLockConditionMeta(condition) : null,
      lockSource: source,
    });
  }

  return metas;
}

// ── GraphQL types ────────────────────────────────────────────────

let lockConditionMetaType: GraphQLObjectType | undefined;
let fieldMetaType: GraphQLObjectType | undefined;

/** Build (once) the shared `LockConditionMeta` GraphQL object type. */
function getLockConditionMetaType(): GraphQLObjectType {
  if (lockConditionMetaType) return lockConditionMetaType;

  lockConditionMetaType = new GraphQLObjectType({
    name: "LockConditionMeta",
    description:
      "Serializable projection of a Spec 63 LockCondition. Lists are derived " +
      "from the `state` clause; `raw` preserves the authored condition verbatim.",
    fields: {
      stateIn: {
        type: new GraphQLList(new GraphQLNonNull(GraphQLString)),
        description: "States that LOCK the field (positive `state` form). Null for the `not` form.",
      },
      stateNotIn: {
        type: new GraphQLList(new GraphQLNonNull(GraphQLString)),
        description:
          "States excluded by the `{ not }` form — the field is locked when " +
          "status is anything except these. Null for the positive form.",
      },
      domain: {
        type: GraphQLString,
        description: "JSON-encoded `domain` clause (reserved by Spec 63 for a future phase).",
      },
      raw: {
        type: new GraphQLNonNull(GraphQLString),
        description: "JSON of the entire LockCondition, for forward-compatibility.",
      },
    },
  });

  return lockConditionMetaType;
}

/**
 * Build (once) the shared `FieldMeta` GraphQL object type exposing a field's
 * static lock metadata (Spec 63 §6).
 */
export function getFieldMetaType(): GraphQLObjectType {
  if (fieldMetaType) return fieldMetaType;

  const lockConditionType: GraphQLOutputType = getLockConditionMetaType();

  fieldMetaType = new GraphQLObjectType({
    name: "FieldMeta",
    description:
      "Static field-lock metadata (Spec 63 §6). Declarative rules only — does " +
      "not evaluate locks against a live record.",
    fields: {
      name: {
        type: new GraphQLNonNull(GraphQLString),
        description: "Field name.",
      },
      immutable: {
        type: new GraphQLNonNull(GraphQLBoolean),
        description:
          "Whether the field cannot change once set (`immutable: true`, or the " +
          "deprecated `readonly: true` alias).",
      },
      lockWhen: {
        type: lockConditionType,
        description:
          "Effective static lock condition: the per-field `lockWhen` if declared, " +
          "otherwise the entity-level `lockAllWhen` when this field is covered by " +
          "it. Null when the field has no lock condition.",
      },
      lockSource: {
        type: new GraphQLNonNull(GraphQLString),
        description: 'Where `lockWhen` originates: "field", "entity", or "none".',
      },
    },
  });

  return fieldMetaType;
}

/**
 * Reset the cached GraphQL types. Test-only — mirrors `clearEnumTypeCache` so
 * suites that build multiple schemas don't reuse a stale type instance.
 */
export function clearFieldMetaTypeCache(): void {
  lockConditionMetaType = undefined;
  fieldMetaType = undefined;
}
