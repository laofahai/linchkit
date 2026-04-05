/**
 * ConfigStore — dynamic KV config store with versioning and scope support.
 *
 * Complements the static ConfigRegistry (startup-time, Zod-validated, frozen)
 * with a runtime-mutable layer for admin-managed config values (spec 42 §9.1).
 */

/** Scope hierarchy for config value resolution */
export type ConfigScope = "global" | "tenant" | "department" | "user";

/** A scoped config key reference */
export interface ConfigScopeRef {
  type: ConfigScope;
  /** Scope entity ID: tenant_id, dept_id, or user_id. Omit for global. */
  id?: string;
}

/** A stored config entry */
export interface ConfigEntry {
  id: string;
  namespace: string;
  key: string;
  value: unknown;
  scope: ConfigScope;
  scopeId?: string;
  encrypted: boolean;
  createdAt: Date;
  updatedAt: Date;
  updatedBy?: string;
}

/** A versioned snapshot of a config entry */
export interface ConfigVersion {
  id: string;
  configId: string;
  namespace: string;
  key: string;
  value: unknown;
  scope: ConfigScope;
  scopeId?: string;
  version: number;
  changedBy?: string;
  changedAt: Date;
  changeReason?: string;
}

/** Options for setting a config value */
export interface SetConfigOptions {
  scope?: ConfigScopeRef;
  encrypted?: boolean;
  changedBy?: string;
  changeReason?: string;
}

/**
 * ConfigStore — the runtime-mutable configuration backend.
 *
 * Implementations: InMemoryConfigStore (dev/test), DrizzleConfigStore (production).
 */
export interface ConfigStore {
  /**
   * Get a config value.
   * Scope cascade: user → department → tenant → global → undefined
   */
  get(namespace: string, key: string, scope?: ConfigScopeRef): Promise<unknown | undefined>;

  /**
   * Set a config value. Creates or updates the entry.
   * Always writes a new version record for audit history.
   */
  set(namespace: string, key: string, value: unknown, options?: SetConfigOptions): Promise<void>;

  /**
   * List version history for a config key (most recent first).
   */
  history(namespace: string, key: string, scope?: ConfigScopeRef): Promise<ConfigVersion[]>;

  /**
   * Rollback a config key to a specific version number.
   * Creates a new version record pointing to the rolled-back value.
   */
  rollback(
    namespace: string,
    key: string,
    version: number,
    options?: { scope?: ConfigScopeRef; changedBy?: string; changeReason?: string },
  ): Promise<void>;

  /**
   * Delete a config entry (all scopes if scope omitted, specific scope otherwise).
   */
  delete(namespace: string, key: string, scope?: ConfigScopeRef): Promise<void>;

  /**
   * List all entries in a namespace.
   */
  list(namespace: string, scope?: ConfigScopeRef): Promise<ConfigEntry[]>;
}

// ── Scope resolution helper ────────────────────────────────────────────────

/**
 * Resolve scoped config with cascade: user → department → tenant → global.
 * Returns the first matching value or undefined.
 */
export async function resolveWithCascade(
  store: ConfigStore,
  namespace: string,
  key: string,
  actor?: { id?: string; departmentId?: string; tenantId?: string },
): Promise<unknown | undefined> {
  if (actor?.id) {
    const v = await store.get(namespace, key, { type: "user", id: actor.id });
    if (v !== undefined) return v;
  }
  if (actor?.departmentId) {
    const v = await store.get(namespace, key, { type: "department", id: actor.departmentId });
    if (v !== undefined) return v;
  }
  if (actor?.tenantId) {
    const v = await store.get(namespace, key, { type: "tenant", id: actor.tenantId });
    if (v !== undefined) return v;
  }
  return store.get(namespace, key, { type: "global" });
}

// ── InMemoryConfigStore ─────────────────────────────────────────────────────

type ScopeKey = string; // `${namespace}/${key}/${scope}/${scopeId??''}`

function makeScopeKey(
  namespace: string,
  key: string,
  scope: ConfigScope = "global",
  scopeId?: string,
): ScopeKey {
  return `${namespace}/${key}/${scope}/${scopeId ?? ""}`;
}

let _idCounter = 0;
function newId(): string {
  return `mem-${Date.now()}-${++_idCounter}`;
}

/**
 * In-memory ConfigStore — suitable for tests and development without a database.
 * No persistence between restarts.
 */
export class InMemoryConfigStore implements ConfigStore {
  private readonly entries = new Map<ScopeKey, ConfigEntry>();
  private readonly versions = new Map<ScopeKey, ConfigVersion[]>();

  async get(namespace: string, key: string, scope?: ConfigScopeRef): Promise<unknown | undefined> {
    const sk = makeScopeKey(namespace, key, scope?.type ?? "global", scope?.id);
    return this.entries.get(sk)?.value;
  }

  async set(
    namespace: string,
    key: string,
    value: unknown,
    options?: SetConfigOptions,
  ): Promise<void> {
    const scopeType = options?.scope?.type ?? "global";
    const scopeId = options?.scope?.id;
    const sk = makeScopeKey(namespace, key, scopeType, scopeId);

    const now = new Date();
    const existing = this.entries.get(sk);

    // Determine next version number
    const versionList = this.versions.get(sk) ?? [];
    const nextVersion = (versionList[versionList.length - 1]?.version ?? 0) + 1;

    const entry: ConfigEntry = existing
      ? {
          ...existing,
          value,
          encrypted: options?.encrypted ?? existing.encrypted,
          updatedAt: now,
          updatedBy: options?.changedBy,
        }
      : {
          id: newId(),
          namespace,
          key,
          value,
          scope: scopeType,
          scopeId,
          encrypted: options?.encrypted ?? false,
          createdAt: now,
          updatedAt: now,
          updatedBy: options?.changedBy,
        };

    this.entries.set(sk, entry);

    // Record version
    const version: ConfigVersion = {
      id: newId(),
      configId: entry.id,
      namespace,
      key,
      value,
      scope: scopeType,
      scopeId,
      version: nextVersion,
      changedBy: options?.changedBy,
      changedAt: now,
      changeReason: options?.changeReason,
    };
    versionList.push(version);
    this.versions.set(sk, versionList);
  }

  async history(namespace: string, key: string, scope?: ConfigScopeRef): Promise<ConfigVersion[]> {
    const sk = makeScopeKey(namespace, key, scope?.type ?? "global", scope?.id);
    const list = this.versions.get(sk) ?? [];
    // Return most recent first
    return [...list].reverse();
  }

  async rollback(
    namespace: string,
    key: string,
    version: number,
    options?: { scope?: ConfigScopeRef; changedBy?: string; changeReason?: string },
  ): Promise<void> {
    const scopeType = options?.scope?.type ?? "global";
    const scopeId = options?.scope?.id;
    const sk = makeScopeKey(namespace, key, scopeType, scopeId);
    const list = this.versions.get(sk) ?? [];
    const target = list.find((v) => v.version === version);
    if (!target) {
      throw new Error(
        `Config version ${version} not found for ${namespace}/${key} (scope: ${scopeType}/${scopeId ?? ""})`,
      );
    }
    await this.set(namespace, key, target.value, {
      scope: options?.scope,
      changedBy: options?.changedBy,
      changeReason: options?.changeReason ?? `Rollback to version ${version}`,
    });
  }

  async delete(namespace: string, key: string, scope?: ConfigScopeRef): Promise<void> {
    if (scope) {
      const sk = makeScopeKey(namespace, key, scope.type, scope.id);
      this.entries.delete(sk);
      this.versions.delete(sk);
    } else {
      // Delete all scopes for this namespace/key
      for (const sk of this.entries.keys()) {
        if (sk.startsWith(`${namespace}/${key}/`)) {
          this.entries.delete(sk);
          this.versions.delete(sk);
        }
      }
    }
  }

  async list(namespace: string, scope?: ConfigScopeRef): Promise<ConfigEntry[]> {
    const results: ConfigEntry[] = [];
    for (const [sk, entry] of this.entries.entries()) {
      if (!sk.startsWith(`${namespace}/`)) continue;
      if (scope) {
        if (entry.scope !== scope.type) continue;
        if (scope.id !== undefined && entry.scopeId !== scope.id) continue;
      }
      results.push(entry);
    }
    return results;
  }
}
