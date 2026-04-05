/**
 * DrizzleConfigStore — PostgreSQL-backed ConfigStore via Drizzle ORM.
 *
 * Persists config entries to _linchkit.config and version history to
 * _linchkit.config_versions (spec 42 §9.1).
 *
 * Hot-reload: after every set()/rollback()/delete(), emits a
 * `config.changed` event to EventBusLike if provided.
 */

import { and, desc, eq, isNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type {
  ConfigEntry,
  ConfigScope,
  ConfigScopeRef,
  ConfigStore,
  ConfigVersion,
  SetConfigOptions,
} from "../config/config-store";
import type { EventBusLike } from "../types/event";
import { configTable, configVersionsTable } from "./system-tables";

export class DrizzleConfigStore implements ConfigStore {
  constructor(
    private readonly db: PostgresJsDatabase,
    private readonly eventBus?: EventBusLike & { emit?: (event: unknown) => Promise<void> },
  ) {}

  async get(namespace: string, key: string, scope?: ConfigScopeRef): Promise<unknown | undefined> {
    const scopeType = scope?.type ?? "global";
    const scopeId = scope?.id ?? null;

    const where =
      scopeId !== null
        ? and(
            eq(configTable.namespace, namespace),
            eq(configTable.key, key),
            eq(configTable.scope, scopeType),
            eq(configTable.scopeId, scopeId),
          )
        : and(
            eq(configTable.namespace, namespace),
            eq(configTable.key, key),
            eq(configTable.scope, scopeType),
            isNull(configTable.scopeId),
          );

    const rows = await this.db.select().from(configTable).where(where).limit(1);
    return rows[0]?.value;
  }

  async set(
    namespace: string,
    key: string,
    value: unknown,
    options?: SetConfigOptions,
  ): Promise<void> {
    const scopeType: ConfigScope = options?.scope?.type ?? "global";
    const scopeId = options?.scope?.id ?? null;
    const now = new Date();

    // Build WHERE clause accounting for nullable scopeId
    const scopeWhere =
      scopeId !== null
        ? and(
            eq(configTable.namespace, namespace),
            eq(configTable.key, key),
            eq(configTable.scope, scopeType),
            eq(configTable.scopeId, scopeId),
          )
        : and(
            eq(configTable.namespace, namespace),
            eq(configTable.key, key),
            eq(configTable.scope, scopeType),
            isNull(configTable.scopeId),
          );

    // Check if entry exists
    const existing = await this.db
      .select({ id: configTable.id })
      .from(configTable)
      .where(scopeWhere)
      .limit(1);

    let configId: string;

    if (existing[0]) {
      // Update
      configId = existing[0].id;
      await this.db
        .update(configTable)
        .set({
          value: value as Record<string, unknown>,
          encrypted: options?.encrypted ?? false,
          updatedBy: options?.changedBy,
          updatedAt: now,
        })
        .where(scopeWhere);
    } else {
      // Insert
      const inserted = await this.db
        .insert(configTable)
        .values({
          namespace,
          key,
          value: value as Record<string, unknown>,
          scope: scopeType,
          scopeId: scopeId ?? undefined,
          encrypted: options?.encrypted ?? false,
          updatedBy: options?.changedBy,
          updatedAt: now,
        })
        .returning({ id: configTable.id });
      configId = inserted[0]?.id ?? "";
    }

    if (!configId) return;

    // Determine next version number
    const lastVersion = await this.db
      .select({ version: configVersionsTable.version })
      .from(configVersionsTable)
      .where(
        scopeId !== null
          ? and(
              eq(configVersionsTable.namespace, namespace),
              eq(configVersionsTable.key, key),
              eq(configVersionsTable.scope, scopeType),
              eq(configVersionsTable.scopeId, scopeId),
            )
          : and(
              eq(configVersionsTable.namespace, namespace),
              eq(configVersionsTable.key, key),
              eq(configVersionsTable.scope, scopeType),
              isNull(configVersionsTable.scopeId),
            ),
      )
      .orderBy(desc(configVersionsTable.version))
      .limit(1);

    const nextVersion = (lastVersion[0]?.version ?? 0) + 1;

    await this.db.insert(configVersionsTable).values({
      configId,
      namespace,
      key,
      value: value as Record<string, unknown>,
      scope: scopeType,
      scopeId: scopeId ?? undefined,
      version: nextVersion,
      changedBy: options?.changedBy,
      changedAt: now,
      changeReason: options?.changeReason,
    });

    await this._emitChanged(namespace, key, scopeType, scopeId ?? undefined, value);
  }

  async history(namespace: string, key: string, scope?: ConfigScopeRef): Promise<ConfigVersion[]> {
    const scopeType = scope?.type ?? "global";
    const scopeId = scope?.id ?? null;

    const where =
      scopeId !== null
        ? and(
            eq(configVersionsTable.namespace, namespace),
            eq(configVersionsTable.key, key),
            eq(configVersionsTable.scope, scopeType),
            eq(configVersionsTable.scopeId, scopeId),
          )
        : and(
            eq(configVersionsTable.namespace, namespace),
            eq(configVersionsTable.key, key),
            eq(configVersionsTable.scope, scopeType),
            isNull(configVersionsTable.scopeId),
          );

    const rows = await this.db
      .select()
      .from(configVersionsTable)
      .where(where)
      .orderBy(desc(configVersionsTable.version));

    return rows.map((r) => ({
      id: r.id,
      configId: r.configId,
      namespace: r.namespace,
      key: r.key,
      value: r.value,
      scope: r.scope as ConfigScope,
      scopeId: r.scopeId ?? undefined,
      version: r.version,
      changedBy: r.changedBy ?? undefined,
      changedAt: r.changedAt,
      changeReason: r.changeReason ?? undefined,
    }));
  }

  async rollback(
    namespace: string,
    key: string,
    version: number,
    options?: { scope?: ConfigScopeRef; changedBy?: string; changeReason?: string },
  ): Promise<void> {
    const scopeType = options?.scope?.type ?? "global";
    const scopeId = options?.scope?.id ?? null;

    const target = await this.db
      .select()
      .from(configVersionsTable)
      .where(
        scopeId !== null
          ? and(
              eq(configVersionsTable.namespace, namespace),
              eq(configVersionsTable.key, key),
              eq(configVersionsTable.scope, scopeType),
              eq(configVersionsTable.scopeId, scopeId),
              eq(configVersionsTable.version, version),
            )
          : and(
              eq(configVersionsTable.namespace, namespace),
              eq(configVersionsTable.key, key),
              eq(configVersionsTable.scope, scopeType),
              isNull(configVersionsTable.scopeId),
              eq(configVersionsTable.version, version),
            ),
      )
      .limit(1);

    if (!target[0]) {
      throw new Error(
        `Config version ${version} not found for ${namespace}/${key} (scope: ${scopeType}/${scopeId ?? ""})`,
      );
    }

    await this.set(namespace, key, target[0].value, {
      scope: options?.scope,
      changedBy: options?.changedBy,
      changeReason: options?.changeReason ?? `Rollback to version ${version}`,
    });
  }

  async delete(namespace: string, key: string, scope?: ConfigScopeRef): Promise<void> {
    if (scope) {
      const scopeId = scope.id ?? null;
      const where =
        scopeId !== null
          ? and(
              eq(configTable.namespace, namespace),
              eq(configTable.key, key),
              eq(configTable.scope, scope.type),
              eq(configTable.scopeId, scopeId),
            )
          : and(
              eq(configTable.namespace, namespace),
              eq(configTable.key, key),
              eq(configTable.scope, scope.type),
              isNull(configTable.scopeId),
            );
      await this.db.delete(configTable).where(where);
    } else {
      await this.db
        .delete(configTable)
        .where(and(eq(configTable.namespace, namespace), eq(configTable.key, key)));
    }

    await this._emitChanged(namespace, key, scope?.type ?? "global", scope?.id, undefined);
  }

  async list(namespace: string, scope?: ConfigScopeRef): Promise<ConfigEntry[]> {
    let where = eq(configTable.namespace, namespace);

    if (scope) {
      const scopeId = scope.id ?? null;
      if (scopeId !== null) {
        where = and(
          where,
          eq(configTable.scope, scope.type),
          eq(configTable.scopeId, scopeId),
        ) as typeof where;
      } else {
        where = and(
          where,
          eq(configTable.scope, scope.type),
          isNull(configTable.scopeId),
        ) as typeof where;
      }
    }

    const rows = await this.db.select().from(configTable).where(where);
    return rows.map((r) => ({
      id: r.id,
      namespace: r.namespace,
      key: r.key,
      value: r.value,
      scope: r.scope as ConfigScope,
      scopeId: r.scopeId ?? undefined,
      encrypted: r.encrypted,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      updatedBy: r.updatedBy ?? undefined,
    }));
  }

  /** Emit config.changed event for hot-reload subscribers */
  private async _emitChanged(
    namespace: string,
    key: string,
    scope: ConfigScope,
    scopeId: string | undefined,
    value: unknown,
  ): Promise<void> {
    if (!this.eventBus?.emit) return;
    try {
      await this.eventBus.emit({
        id: crypto.randomUUID(),
        type: "config.changed",
        payload: { namespace, key, scope, scopeId, value },
        createdAt: new Date(),
      });
    } catch {
      // Hot-reload failures must never crash the primary operation
    }
  }
}
