/**
 * Build all registries (Schema, Action, Interface, Link, Permission)
 * and wire permission/auth/tenant middleware.
 */

import type {
  ActionDefinition,
  CapabilityDefinition,
  ConfigRegistry,
  DataProvider,
  InterfaceDefinition,
  RelationDefinition,
  MiddlewareRegistration,
  EntityDefinition,
} from "@linchkit/core";

interface EnvironmentInfo {
  isDevelopment: boolean;
}

import {
  ActionRegistry,
  convertSchemaRelationshipFieldsToImplicitLinks,
  createInterfaceRegistry,
  createRelationRegistry,
  createTenantIsolationMiddleware,
  PermissionRegistry,
  EntityRegistry,
} from "@linchkit/core/server";

export interface RegistryBuildResult {
  entityRegistry: EntityRegistry;
  actionRegistry: ActionRegistry;
  relationRegistry: ReturnType<typeof createRelationRegistry>;
  interfaceRegistry: ReturnType<typeof createInterfaceRegistry>;
  permissionRegistry: PermissionRegistry;
  /** Implicit links auto-promoted from schema relationship fields */
  implicitLinkCount: number;
}

export interface RegistryBuildInput {
  capabilities: CapabilityDefinition[];
  interfaces: InterfaceDefinition[];
  schemas: EntityDefinition[];
  actions: ActionDefinition[];
  links: RelationDefinition[];
  middlewares: MiddlewareRegistration[];
  registry: ConfigRegistry;
  environment: EnvironmentInfo;
}

/**
 * Build and populate all registries. Promotes implicit links from schema
 * relationship fields, wires permission middleware, and appends tenant
 * isolation middleware.
 *
 * Mutates `links`, `actions`, and `middlewares` arrays in place
 * (appending implicit links, tenant middleware, permission middleware).
 */
export async function buildRegistries(input: RegistryBuildInput): Promise<RegistryBuildResult> {
  const { capabilities, interfaces, schemas, actions, links, middlewares, registry, environment } =
    input;

  // Auto-promote schema relationship fields to implicit links
  const { implicitLinks, conflicts, missingTargets } =
    convertSchemaRelationshipFieldsToImplicitLinks(schemas, links);
  if (conflicts.length > 0) {
    console.warn(
      `[linch] Found ${conflicts.length} conflict(s) between implicit and explicit links:`,
    );
    for (const c of conflicts) {
      console.warn(
        `[linch]   - "${c.name}": explicit declaration overrides implicit from schema field`,
      );
    }
  }
  if (missingTargets.length > 0) {
    console.warn(
      `[linch] Found ${missingTargets.length} relationship field(s) with missing target entities:`,
    );
    for (const mt of missingTargets) {
      console.warn(
        `[linch]   - ${mt.entityName}.${mt.fieldName}: target entity "${mt.target}" not found - skipped`,
      );
    }
  }
  if (implicitLinks.length > 0) {
    links.push(...implicitLinks);
    console.log(
      `[linch] Auto-promoted ${implicitLinks.length} relationship field(s) to implicit links`,
    );
  }

  // Build InterfaceRegistry (must happen before schema registration)
  const interfaceRegistry = createInterfaceRegistry();
  for (const iface of interfaces) {
    interfaceRegistry.register(iface);
  }
  if (interfaces.length > 0) {
    console.log(
      `[linch] Registered ${interfaces.length} interface(s): ${interfaces.map((i) => i.name).join(", ")}`,
    );
  }

  // Build EntityRegistry
  const entityRegistry = new EntityRegistry();
  entityRegistry.setInterfaceRegistry(interfaceRegistry);
  for (const schema of schemas) {
    entityRegistry.register(schema);
  }

  // Build RelationRegistry (explicit + implicit)
  const relationRegistry = createRelationRegistry();
  for (const link of links) {
    relationRegistry.register(link);
  }
  if (links.length > 0) {
    console.log(
      `[linch] Registered ${links.length} total link(s) (${links.length - implicitLinks.length} explicit, ${implicitLinks.length} implicit)`,
    );
  }

  // Build ActionRegistry
  const actionRegistry = new ActionRegistry();
  for (const action of actions) {
    if (!actionRegistry.has(action.name)) {
      actionRegistry.register(action);
    }
  }

  // Permission group discovery
  const permissionRegistry = new PermissionRegistry();
  for (const cap of capabilities) {
    if (cap.extensions?.permissionGroups) {
      for (const group of cap.extensions.permissionGroups) {
        if (!permissionRegistry.get(group.name)) {
          permissionRegistry.register(group);
        }
      }
    }
  }
  const registeredGroups = permissionRegistry.getAll();
  if (registeredGroups.length > 0) {
    console.log(
      `[linch] Registered ${registeredGroups.length} permission group(s): ${registeredGroups.map((g) => g.name).join(", ")}`,
    );
  }

  // Wire permission middleware into cap-permission if loaded without explicit registry
  const capPermissionDef = capabilities.find((c) => c.name === "cap-permission");
  if (capPermissionDef && registeredGroups.length > 0) {
    const hasPermissionMiddleware = capPermissionDef.extensions?.middlewares?.some(
      (mw) => mw.slot === "permission",
    );
    if (!hasPermissionMiddleware) {
      try {
        const { createPermissionMiddleware } = await import("@linchkit/cap-permission");
        const capPermCfg = registry.has("cap-permission")
          ? (registry.get("cap-permission") as Record<string, unknown>)
          : undefined;
        const permMw = {
          name: "cap-permission_permission_0",
          slot: "permission" as const,
          handler: createPermissionMiddleware({
            registry: permissionRegistry,
            publicActions: capPermCfg?.publicActions as string[] | undefined,
          }),
          order: 50,
        };
        middlewares.push(permMw);
        console.log("[linch] Auto-wired permission middleware from discovered permission groups");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[linch] Failed to auto-wire permission middleware: ${msg}`);
      }
    }
  }

  // Tenant isolation middleware
  const tenantMiddleware = createTenantIsolationMiddleware({
    requireTenant: !environment.isDevelopment,
  });
  middlewares.push(tenantMiddleware);
  console.log(
    `[linch] Tenant isolation middleware registered (requireTenant=${!environment.isDevelopment})`,
  );

  return {
    entityRegistry,
    actionRegistry,
    relationRegistry,
    interfaceRegistry,
    permissionRegistry,
    implicitLinkCount: implicitLinks.length,
  };
}

export interface AuthWiringInput {
  capabilities: CapabilityDefinition[];
  actionRegistry: ActionRegistry;
  actions: ActionDefinition[];
  middlewares: MiddlewareRegistration[];
  dataProvider: DataProvider;
  registry: ConfigRegistry;
  usingDatabase: boolean;
  dbInstance: ReturnType<typeof import("@linchkit/core/server").createDatabase> | undefined;
}

/**
 * Discover and wire auth provider from capabilities.
 * Mutates `actions` and `middlewares` arrays in place.
 */
export async function wireAuthProvider(input: AuthWiringInput): Promise<void> {
  const {
    capabilities,
    actionRegistry,
    actions,
    middlewares,
    dataProvider,
    registry,
    usingDatabase,
    dbInstance,
  } = input;

  const authProviderExt = capabilities
    .flatMap((cap) => (cap.extensions?.authProvider ? [cap.extensions.authProvider] : []))
    .at(0);

  if (authProviderExt && usingDatabase && dbInstance) {
    try {
      const { createCapAuth, capAuthConfig } = await import("@linchkit/cap-auth");
      const provider = authProviderExt.create({
        database: dbInstance,
        dataProvider,
      });
      const authCfg = registry.has("cap-auth")
        ? capAuthConfig.from({ config: registry })
        : undefined;
      const rewiredCap = createCapAuth({ provider, config: authCfg });

      // Replace auth actions and middlewares in registries
      if (rewiredCap.actions) {
        for (const action of rewiredCap.actions) {
          const isNew = !actionRegistry.has(action.name);
          actionRegistry.register(action, { overwrite: true });
          if (isNew) {
            actions.push(action);
          }
        }
      }
      if (rewiredCap.extensions?.middlewares) {
        for (const [i, mw] of rewiredCap.extensions.middlewares.entries()) {
          const name = `cap-auth_${mw.slot}_${String(i)}`;
          const existingIdx = middlewares.findIndex((m) => m.name?.startsWith("cap-auth"));
          if (existingIdx >= 0) {
            middlewares[existingIdx] = {
              name,
              slot: mw.slot,
              handler: mw.handler,
              order: mw.priority ?? 50,
            };
          } else {
            middlewares.push({
              name,
              slot: mw.slot,
              handler: mw.handler,
              order: mw.priority ?? 50,
            });
          }
        }
      }
      console.log(`[linch] Auth provider "${authProviderExt.name}" wired into cap-auth`);

      // Seed admin user if the provider supports it
      if (authProviderExt.seedAdmin) {
        await authProviderExt.seedAdmin({ database: dbInstance });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[linch] Failed to wire auth provider "${authProviderExt.name}": ${msg}`);
    }
  } else if (authProviderExt && !dbInstance) {
    console.log(
      `[linch] Auth provider "${authProviderExt.name}" registered but no database — skipping wiring`,
    );
  }
}
