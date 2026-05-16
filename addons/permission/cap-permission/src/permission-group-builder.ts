/**
 * permissionGroup — Chain-style builder for Phase 1 of spec 10 §2.1
 *
 * Provides an IDE-guided, "multiple-choice" alternative to `definePermissionGroup()`.
 * Produces an identical plain `PermissionGroupDefinition` object (deep-equal to the
 * object-style entry for equivalent input), so both styles serialize the same row
 * to `_linchkit.permission_groups`.
 *
 * Design notes:
 *   - `.build()` is idempotent: each call returns a fresh deep-clone, the internal
 *     state is never mutated by `build()`, and the returned object shares no
 *     references with the builder.
 *   - `.on(entity)` switches the "current entity" context. Subsequent grant
 *     mutations (`.allow`, `.deny`, `.readAll`, `.writeAll`, `.ownRecords`) apply
 *     to that entity. Calling `.on(otherEntity)` switches context without losing
 *     prior entities.
 *   - `.implies(...)` accumulates across calls; duplicates are de-duped.
 *   - `ownRecords()` resolves to a `$actor.id` filter against `created_by`,
 *     matching spec 10 §2.1 helper-function reference.
 */

import type {
  DataAccessCondition,
  EntityGrant,
  GrantMap,
  PermissionConstraints,
  PermissionGroupDefinition,
} from "./define-permission-group";

// ── Builder interface ───────────────────────────────────────

export interface PermissionGroupBuilder {
  /** Set human-readable label */
  label(label: string): PermissionGroupBuilder;
  /** Set long-form description */
  description(description: string): PermissionGroupBuilder;
  /** Set UI category */
  category(category: string): PermissionGroupBuilder;
  /** Append one or more inherited group names (de-duplicated) */
  implies(...names: string[]): PermissionGroupBuilder;
  /** Mark as system_admin (spec 10 §7.4) */
  systemAdmin(): PermissionGroupBuilder;
  /** Attach actor constraints */
  constraints(constraints: PermissionConstraints): PermissionGroupBuilder;
  /** Switch grant target to the given entity name */
  on(entity: string): PermissionGroupBuilder;
  /** Grant one or more actions on the current entity */
  allow(...actions: string[]): PermissionGroupBuilder;
  /** Explicitly deny one or more actions on the current entity */
  deny(...actions: string[]): PermissionGroupBuilder;
  /** Grant unrestricted read on the current entity */
  readAll(): PermissionGroupBuilder;
  /** Grant unrestricted write on the current entity */
  writeAll(): PermissionGroupBuilder;
  /** Restrict read+write to records the actor created */
  ownRecords(field?: string): PermissionGroupBuilder;
  /** Mark fields as visible (whitelist) on the current entity */
  visibleFields(...fields: string[]): PermissionGroupBuilder;
  /** Mark fields as hidden (blacklist) on the current entity */
  hiddenFields(...fields: string[]): PermissionGroupBuilder;
  /** Materialize the definition. Idempotent — each call returns a fresh clone. */
  build(): PermissionGroupDefinition;
}

// ── Factory ─────────────────────────────────────────────────

/**
 * Start building a permission group.
 *
 * @example
 * ```ts
 * const purchaseManager = permissionGroup('purchase_manager')
 *   .label('采购管理员')
 *   .category('purchase_management')
 *   .implies('purchase_user')
 *   .on('purchase_request')
 *     .allow('approve_request', 'reject_request')
 *     .readAll()
 *   .build();
 * ```
 */
export function permissionGroup(name: string): PermissionGroupBuilder {
  if (!name || typeof name !== "string") {
    throw new Error("permissionGroup: `name` is required and must be a string");
  }

  // ── Internal mutable state ────────────────────────────
  const state: {
    name: string;
    label?: string;
    description?: string;
    category?: string;
    implies: string[];
    grant: GrantMap;
    systemLevel?: "admin";
    constraints?: PermissionConstraints;
  } = {
    name,
    implies: [],
    grant: {},
  };

  /** Tracks the entity currently being configured via `.on(...)`. */
  let currentEntity: string | undefined;

  /**
   * Get-or-create the grant entry for the current entity.
   * Throws if `.on(...)` has not been called yet.
   */
  const requireEntity = (op: string): EntityGrant => {
    if (!currentEntity) {
      throw new Error(`permissionGroup("${name}").${op}() requires a prior .on(entity) call`);
    }
    let entry = state.grant[currentEntity];
    if (!entry) {
      entry = {};
      state.grant[currentEntity] = entry;
    }
    return entry;
  };

  const ensureActions = (entry: EntityGrant): Record<string, true | false | undefined> => {
    if (!entry.actions) {
      entry.actions = {};
    }
    return entry.actions;
  };

  const ensureData = (entry: EntityGrant): NonNullable<EntityGrant["data"]> => {
    if (!entry.data) {
      entry.data = {};
    }
    return entry.data;
  };

  const ensureFields = (entry: EntityGrant): NonNullable<EntityGrant["fields"]> => {
    if (!entry.fields) {
      entry.fields = {};
    }
    return entry.fields;
  };

  // ── Builder implementation ────────────────────────────
  const builder: PermissionGroupBuilder = {
    label(label) {
      state.label = label;
      return builder;
    },

    description(description) {
      state.description = description;
      return builder;
    },

    category(category) {
      state.category = category;
      return builder;
    },

    implies(...names) {
      for (const n of names) {
        if (!n || typeof n !== "string") continue;
        if (!state.implies.includes(n)) {
          state.implies.push(n);
        }
      }
      return builder;
    },

    systemAdmin() {
      state.systemLevel = "admin";
      return builder;
    },

    constraints(constraints) {
      state.constraints = constraints;
      return builder;
    },

    on(entity) {
      if (!entity || typeof entity !== "string") {
        throw new Error(`permissionGroup("${name}").on() requires a non-empty entity name`);
      }
      currentEntity = entity;
      // Ensure an entry exists even if no grant methods are called.
      if (!state.grant[entity]) {
        state.grant[entity] = {};
      }
      return builder;
    },

    allow(...actions) {
      const entry = requireEntity("allow");
      const map = ensureActions(entry);
      for (const action of actions) {
        if (!action || typeof action !== "string") continue;
        map[action] = true;
      }
      return builder;
    },

    deny(...actions) {
      const entry = requireEntity("deny");
      const map = ensureActions(entry);
      for (const action of actions) {
        if (!action || typeof action !== "string") continue;
        map[action] = false;
      }
      return builder;
    },

    readAll() {
      const data = ensureData(requireEntity("readAll"));
      data.read = "all";
      return builder;
    },

    writeAll() {
      const data = ensureData(requireEntity("writeAll"));
      data.write = "all";
      return builder;
    },

    ownRecords(field = "created_by") {
      const data = ensureData(requireEntity("ownRecords"));
      const condition: DataAccessCondition = {
        field,
        operator: "eq",
        value: "$actor.id",
      };
      data.read = { condition };
      data.write = { condition: { ...condition } };
      return builder;
    },

    visibleFields(...fields) {
      const f = ensureFields(requireEntity("visibleFields"));
      const list = f.visible ?? [];
      for (const name of fields) {
        if (!name || typeof name !== "string") continue;
        if (!list.includes(name)) list.push(name);
      }
      f.visible = list;
      return builder;
    },

    hiddenFields(...fields) {
      const f = ensureFields(requireEntity("hiddenFields"));
      const list = f.hidden ?? [];
      for (const name of fields) {
        if (!name || typeof name !== "string") continue;
        if (!list.includes(name)) list.push(name);
      }
      f.hidden = list;
      return builder;
    },

    build() {
      return materialize(state);
    },
  };

  return builder;
}

// ── Materialization (deep clone, omit empty optionals) ──────

function materialize(state: {
  name: string;
  label?: string;
  description?: string;
  category?: string;
  implies: string[];
  grant: GrantMap;
  systemLevel?: "admin";
  constraints?: PermissionConstraints;
}): PermissionGroupDefinition {
  const out: PermissionGroupDefinition = { name: state.name };

  if (state.label !== undefined) out.label = state.label;
  if (state.description !== undefined) out.description = state.description;
  if (state.category !== undefined) out.category = state.category;
  if (state.implies.length > 0) out.implies = [...state.implies];

  const grantKeys = Object.keys(state.grant);
  if (grantKeys.length > 0) {
    out.grant = cloneGrant(state.grant);
  }

  if (state.systemLevel !== undefined) out.systemLevel = state.systemLevel;
  if (state.constraints !== undefined) {
    // Constraints are user-supplied plain objects; structuredClone is safe and
    // deep so multiple `.build()` calls don't share references.
    out.constraints = structuredClone(state.constraints);
  }

  return out;
}

function cloneGrant(grant: GrantMap): GrantMap {
  const out: GrantMap = {};
  for (const [entity, entry] of Object.entries(grant)) {
    out[entity] = cloneEntry(entry);
  }
  return out;
}

function cloneEntry(entry: EntityGrant): EntityGrant {
  const cloned: EntityGrant = {};
  if (entry.actions) {
    cloned.actions = { ...entry.actions };
  }
  if (entry.data) {
    cloned.data = {};
    if (entry.data.read !== undefined) {
      cloned.data.read =
        typeof entry.data.read === "string"
          ? entry.data.read
          : { condition: { ...entry.data.read.condition } };
    }
    if (entry.data.write !== undefined) {
      cloned.data.write =
        typeof entry.data.write === "string"
          ? entry.data.write
          : { condition: { ...entry.data.write.condition } };
    }
  }
  if (entry.fields) {
    cloned.fields = {};
    if (entry.fields.visible) cloned.fields.visible = [...entry.fields.visible];
    if (entry.fields.hidden) cloned.fields.hidden = [...entry.fields.hidden];
    if (entry.fields.unmask) cloned.fields.unmask = [...entry.fields.unmask];
  }
  return cloned;
}
