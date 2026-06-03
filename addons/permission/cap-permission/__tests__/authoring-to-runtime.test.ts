/**
 * End-to-end "authoring → runtime" tests for the RBAC double-brain fix.
 *
 * Proves that a permission group authored the DOCUMENTED way — via
 * `definePermissionGroup({ grant, implies, systemLevel })` or the
 * `permissionGroup(...)` chain builder — actually takes effect when fed through
 * the core `PermissionRegistry` + `checkActionPermission` / `resolveDataAccess`.
 *
 * Before the fix the engine only read the legacy `permissions[capability][entity]`
 * structure and the literal `system_admin` group name, so `grant`/`implies`/
 * `systemLevel` were silently dead. These tests are the regression guard.
 */

import { describe, expect, it } from "bun:test";
import type { Actor } from "@linchkit/core";
import {
  checkActionPermission,
  PermissionRegistry,
  resolveDataAccess,
} from "@linchkit/core/server";
import { definePermissionGroup } from "../src/define-permission-group";
import { permissionGroup } from "../src/permission-group-builder";

function actor(groups: string[]): Actor {
  return { type: "human", id: "u1", groups };
}

function registryOf(...groups: ReturnType<typeof definePermissionGroup>[]): PermissionRegistry {
  const registry = new PermissionRegistry();
  for (const g of groups) {
    registry.register(g);
  }
  return registry;
}

describe("definePermissionGroup → runtime", () => {
  it("a grant-only group actually grants the action (headline bug)", () => {
    const purchaseManager = definePermissionGroup({
      name: "purchase_manager",
      label: "Purchase Manager",
      category: "purchase",
      grant: {
        purchase_request: {
          actions: { approve_request: true },
          data: { read: "all" },
        },
      },
    });
    const registry = registryOf(purchaseManager);

    expect(
      checkActionPermission(registry, actor(["purchase_manager"]), "purchase", "approve_request")
        .allowed,
    ).toBe(true);
    expect(
      resolveDataAccess(
        registry,
        actor(["purchase_manager"]),
        "purchase",
        "purchase_request",
        "read",
      ),
    ).toBe("all");
  });

  it("implies inheritance flows through (manager implies user)", () => {
    const user = definePermissionGroup({
      name: "purchase_user",
      grant: { purchase_request: { actions: { submit_request: true } } },
    });
    const manager = definePermissionGroup({
      name: "purchase_manager",
      implies: ["purchase_user"],
      grant: { purchase_request: { actions: { approve_request: true } } },
    });
    const registry = registryOf(user, manager);

    // Manager can do BOTH its own and the inherited action.
    expect(
      checkActionPermission(registry, actor(["purchase_manager"]), "purchase", "approve_request")
        .allowed,
    ).toBe(true);
    expect(
      checkActionPermission(registry, actor(["purchase_manager"]), "purchase", "submit_request")
        .allowed,
    ).toBe(true);
  });

  it("systemLevel:'admin' (non-system_admin name) bypasses", () => {
    const owner = definePermissionGroup({ name: "platform_owner", systemLevel: "admin" });
    const registry = registryOf(owner);

    expect(checkActionPermission(registry, actor(["platform_owner"]), "any", "any").allowed).toBe(
      true,
    );
  });
});

describe("permissionGroup() builder → runtime", () => {
  it("a builder-authored grant group grants at runtime", () => {
    const group = permissionGroup("purchase_manager")
      .label("Purchase Manager")
      .category("purchase")
      .on("purchase_request")
      .allow("approve_request")
      .readAll()
      .build();
    const registry = registryOf(group);

    expect(
      checkActionPermission(registry, actor(["purchase_manager"]), "purchase", "approve_request")
        .allowed,
    ).toBe(true);
  });

  it("a builder `.implies(...)` edge is resolved at runtime", () => {
    const user = permissionGroup("purchase_user")
      .on("purchase_request")
      .allow("submit_request")
      .build();
    const manager = permissionGroup("purchase_manager")
      .implies("purchase_user")
      .on("purchase_request")
      .allow("approve_request")
      .build();
    const registry = registryOf(user, manager);

    expect(
      checkActionPermission(registry, actor(["purchase_manager"]), "purchase", "submit_request")
        .allowed,
    ).toBe(true);
  });

  it("a builder `.deny(...)` wins over an inherited allow", () => {
    const user = permissionGroup("purchase_user")
      .on("purchase_request")
      .allow("approve_request")
      .build();
    const manager = permissionGroup("purchase_manager")
      .implies("purchase_user")
      .on("purchase_request")
      .deny("approve_request")
      .build();
    const registry = registryOf(user, manager);

    expect(
      checkActionPermission(registry, actor(["purchase_manager"]), "purchase", "approve_request")
        .allowed,
    ).toBe(false);
  });

  it("a builder `.systemAdmin()` group bypasses", () => {
    const owner = permissionGroup("platform_owner").systemAdmin().build();
    const registry = registryOf(owner);

    expect(checkActionPermission(registry, actor(["platform_owner"]), "any", "any").allowed).toBe(
      true,
    );
  });
});
