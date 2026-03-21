import { describe, expect, it } from "bun:test";
import {
  checkActionPermission,
  PermissionRegistry,
  resolveConditionVariables,
  resolveDataAccess,
} from "../src/engine/permission-engine";
import type { Actor } from "../src/types/action";
import type { PermissionGroupDefinition } from "../src/types/permission";

// ── Helpers ─────────────────────────────────────────

function makeActor(overrides: Partial<Actor> = {}): Actor {
  return {
    type: "human",
    id: "user-1",
    groups: ["employee"],
    ...overrides,
  };
}

function makeGroup(overrides: Partial<PermissionGroupDefinition> = {}): PermissionGroupDefinition {
  return {
    name: "employee",
    label: "Employee",
    permissions: {},
    ...overrides,
  };
}

// ── PermissionRegistry ──────────────────────────────

describe("PermissionRegistry", () => {
  it("registers and retrieves a group", () => {
    const registry = new PermissionRegistry();
    const group = makeGroup();
    registry.register(group);

    expect(registry.get("employee")).toBe(group);
  });

  it("returns undefined for unknown group", () => {
    const registry = new PermissionRegistry();
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("throws on duplicate registration", () => {
    const registry = new PermissionRegistry();
    registry.register(makeGroup());
    expect(() => registry.register(makeGroup())).toThrow("already registered");
  });

  it("throws when group has no name", () => {
    const registry = new PermissionRegistry();
    expect(() => registry.register(makeGroup({ name: "" }))).toThrow("must have a name");
  });

  it("getAll returns all registered groups", () => {
    const registry = new PermissionRegistry();
    const g1 = makeGroup({ name: "g1", label: "G1" });
    const g2 = makeGroup({ name: "g2", label: "G2" });
    registry.register(g1);
    registry.register(g2);

    expect(registry.getAll()).toEqual([g1, g2]);
  });

  it("resolveActorPermissions returns matching groups", () => {
    const registry = new PermissionRegistry();
    const employee = makeGroup({ name: "employee", label: "Employee" });
    const manager = makeGroup({ name: "manager", label: "Manager" });
    const admin = makeGroup({ name: "admin", label: "Admin" });
    registry.register(employee);
    registry.register(manager);
    registry.register(admin);

    const actor = makeActor({ groups: ["employee", "manager"] });
    const resolved = registry.resolveActorPermissions(actor);

    expect(resolved).toEqual([employee, manager]);
  });

  it("resolveActorPermissions skips unregistered groups", () => {
    const registry = new PermissionRegistry();
    const employee = makeGroup({ name: "employee", label: "Employee" });
    registry.register(employee);

    const actor = makeActor({ groups: ["employee", "nonexistent"] });
    const resolved = registry.resolveActorPermissions(actor);

    expect(resolved).toEqual([employee]);
  });
});

// ── checkActionPermission ───────────────────────────

describe("checkActionPermission", () => {
  function setupRegistry(...groups: PermissionGroupDefinition[]): PermissionRegistry {
    const registry = new PermissionRegistry();
    for (const g of groups) {
      registry.register(g);
    }
    return registry;
  }

  it("allows when single group grants the action", () => {
    const group = makeGroup({
      name: "employee",
      permissions: {
        purchase: {
          purchase_request: {
            actions: { submit: true },
          },
        },
      },
    });
    const registry = setupRegistry(group);
    const actor = makeActor({ groups: ["employee"] });

    const result = checkActionPermission(registry, actor, "purchase", "submit");

    expect(result.allowed).toBe(true);
    expect(result.decidedBy).toBe("employee");
  });

  it("denies when single group explicitly denies the action", () => {
    const group = makeGroup({
      name: "employee",
      permissions: {
        purchase: {
          purchase_request: {
            actions: { approve: false },
          },
        },
      },
    });
    const registry = setupRegistry(group);
    const actor = makeActor({ groups: ["employee"] });

    const result = checkActionPermission(registry, actor, "purchase", "approve");

    expect(result.allowed).toBe(false);
    expect(result.decidedBy).toBe("employee");
    expect(result.reason).toContain("Explicitly denied");
  });

  it("denies when actor has no matching groups (default deny)", () => {
    const registry = new PermissionRegistry();
    const actor = makeActor({ groups: ["nonexistent"] });

    const result = checkActionPermission(registry, actor, "purchase", "submit");

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("no registered permission groups");
  });

  it("allows when multiple groups and one allows, none deny", () => {
    const employee = makeGroup({
      name: "employee",
      permissions: {
        purchase: {
          purchase_request: {
            actions: { submit: true },
          },
        },
      },
    });
    const viewer = makeGroup({
      name: "viewer",
      label: "Viewer",
      permissions: {},
    });
    const registry = setupRegistry(employee, viewer);
    const actor = makeActor({ groups: ["employee", "viewer"] });

    const result = checkActionPermission(registry, actor, "purchase", "submit");

    expect(result.allowed).toBe(true);
  });

  it("denies when multiple groups, one allows, one denies (explicit-deny-wins)", () => {
    const employee = makeGroup({
      name: "employee",
      permissions: {
        purchase: {
          purchase_request: {
            actions: { approve: true },
          },
        },
      },
    });
    const restricted = makeGroup({
      name: "restricted",
      label: "Restricted",
      permissions: {
        purchase: {
          purchase_request: {
            actions: { approve: false },
          },
        },
      },
    });
    const registry = setupRegistry(employee, restricted);
    const actor = makeActor({ groups: ["employee", "restricted"] });

    const result = checkActionPermission(registry, actor, "purchase", "approve");

    expect(result.allowed).toBe(false);
    expect(result.decidedBy).toBe("restricted");
  });

  it("denies when group does not mention the action", () => {
    const group = makeGroup({
      name: "employee",
      permissions: {
        purchase: {
          purchase_request: {
            actions: { submit: true },
          },
        },
      },
    });
    const registry = setupRegistry(group);
    const actor = makeActor({ groups: ["employee"] });

    const result = checkActionPermission(registry, actor, "purchase", "approve");

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("No permission group grants");
  });

  it("system_admin group is always allowed", () => {
    const admin = makeGroup({
      name: "system_admin",
      label: "System Admin",
      permissions: {},
    });
    const registry = setupRegistry(admin);
    const actor = makeActor({ groups: ["system_admin"] });

    const result = checkActionPermission(registry, actor, "any_capability", "any_action");

    expect(result.allowed).toBe(true);
    expect(result.decidedBy).toBe("system_admin");
  });

  it("denies when actor has empty groups array", () => {
    const registry = new PermissionRegistry();
    const actor = makeActor({ groups: [] });

    const result = checkActionPermission(registry, actor, "purchase", "submit");

    expect(result.allowed).toBe(false);
  });

  it("denies when capability does not exist in any group", () => {
    const group = makeGroup({
      name: "employee",
      permissions: {
        hr: {
          employee_record: {
            actions: { view: true },
          },
        },
      },
    });
    const registry = setupRegistry(group);
    const actor = makeActor({ groups: ["employee"] });

    const result = checkActionPermission(registry, actor, "purchase", "submit");

    expect(result.allowed).toBe(false);
  });
});

// ── resolveDataAccess ───────────────────────────────

describe("resolveDataAccess", () => {
  function setupRegistry(...groups: PermissionGroupDefinition[]): PermissionRegistry {
    const registry = new PermissionRegistry();
    for (const g of groups) {
      registry.register(g);
    }
    return registry;
  }

  it("returns 'all' for single group with 'all' access", () => {
    const group = makeGroup({
      name: "employee",
      permissions: {
        purchase: {
          purchase_request: {
            data: { read: "all" },
          },
        },
      },
    });
    const registry = setupRegistry(group);
    const actor = makeActor();

    expect(resolveDataAccess(registry, actor, "purchase", "purchase_request", "read")).toBe("all");
  });

  it("returns 'none' for single group with 'none' access", () => {
    const group = makeGroup({
      name: "employee",
      permissions: {
        purchase: {
          purchase_request: {
            data: { read: "none" },
          },
        },
      },
    });
    const registry = setupRegistry(group);
    const actor = makeActor();

    expect(resolveDataAccess(registry, actor, "purchase", "purchase_request", "read")).toBe("none");
  });

  it("returns condition for single group with condition access", () => {
    const condition = { field: "created_by", operator: "eq" as const, value: "$actor.id" };
    const group = makeGroup({
      name: "employee",
      permissions: {
        purchase: {
          purchase_request: {
            data: { read: { condition } },
          },
        },
      },
    });
    const registry = setupRegistry(group);
    const actor = makeActor();

    expect(resolveDataAccess(registry, actor, "purchase", "purchase_request", "read")).toEqual(
      condition,
    );
  });

  it("returns 'all' when multiple groups: 'all' + condition", () => {
    const manager = makeGroup({
      name: "manager",
      label: "Manager",
      permissions: {
        purchase: {
          purchase_request: {
            data: { read: "all" },
          },
        },
      },
    });
    const employee = makeGroup({
      name: "employee",
      permissions: {
        purchase: {
          purchase_request: {
            data: {
              read: {
                condition: { field: "created_by", operator: "eq" as const, value: "$actor.id" },
              },
            },
          },
        },
      },
    });
    const registry = setupRegistry(manager, employee);
    const actor = makeActor({ groups: ["manager", "employee"] });

    expect(resolveDataAccess(registry, actor, "purchase", "purchase_request", "read")).toBe("all");
  });

  it("returns 'none' when multiple groups: 'none' + 'all' (deny wins)", () => {
    const manager = makeGroup({
      name: "manager",
      label: "Manager",
      permissions: {
        purchase: {
          purchase_request: {
            data: { read: "all" },
          },
        },
      },
    });
    const restricted = makeGroup({
      name: "restricted",
      label: "Restricted",
      permissions: {
        purchase: {
          purchase_request: {
            data: { read: "none" },
          },
        },
      },
    });
    const registry = setupRegistry(restricted, manager);
    const actor = makeActor({ groups: ["restricted", "manager"] });

    expect(resolveDataAccess(registry, actor, "purchase", "purchase_request", "read")).toBe("none");
  });

  it("OR-merges conditions from multiple groups", () => {
    const g1 = makeGroup({
      name: "team_a",
      label: "Team A",
      permissions: {
        purchase: {
          purchase_request: {
            data: {
              read: {
                condition: { field: "department", operator: "eq" as const, value: "A" },
              },
            },
          },
        },
      },
    });
    const g2 = makeGroup({
      name: "team_b",
      label: "Team B",
      permissions: {
        purchase: {
          purchase_request: {
            data: {
              read: {
                condition: { field: "department", operator: "eq" as const, value: "B" },
              },
            },
          },
        },
      },
    });
    const registry = setupRegistry(g1, g2);
    const actor = makeActor({ groups: ["team_a", "team_b"] });

    // Returns first condition (OR merge is delegated to query layer)
    const result = resolveDataAccess(registry, actor, "purchase", "purchase_request", "read");
    expect(result).toEqual({ field: "department", operator: "eq", value: "A" });
  });

  it("returns 'none' when no matching group", () => {
    const registry = new PermissionRegistry();
    const actor = makeActor({ groups: [] });

    expect(resolveDataAccess(registry, actor, "purchase", "purchase_request", "read")).toBe("none");
  });

  it("returns 'none' when group has no data permissions for schema", () => {
    const group = makeGroup({
      name: "employee",
      permissions: {
        purchase: {
          other_schema: {
            data: { read: "all" },
          },
        },
      },
    });
    const registry = setupRegistry(group);
    const actor = makeActor();

    expect(resolveDataAccess(registry, actor, "purchase", "purchase_request", "read")).toBe("none");
  });

  it("returns 'all' for system_admin", () => {
    const admin = makeGroup({
      name: "system_admin",
      label: "System Admin",
      permissions: {},
    });
    const registry = setupRegistry(admin);
    const actor = makeActor({ groups: ["system_admin"] });

    expect(resolveDataAccess(registry, actor, "purchase", "purchase_request", "read")).toBe("all");
  });

  it("resolves write operation separately from read", () => {
    const group = makeGroup({
      name: "employee",
      permissions: {
        purchase: {
          purchase_request: {
            data: {
              read: "all",
              write: {
                condition: { field: "created_by", operator: "eq" as const, value: "$actor.id" },
              },
            },
          },
        },
      },
    });
    const registry = setupRegistry(group);
    const actor = makeActor();

    expect(resolveDataAccess(registry, actor, "purchase", "purchase_request", "read")).toBe("all");
    expect(resolveDataAccess(registry, actor, "purchase", "purchase_request", "write")).toEqual({
      field: "created_by",
      operator: "eq",
      value: "$actor.id",
    });
  });
});

// ── resolveConditionVariables ───────────────────────

describe("resolveConditionVariables", () => {
  const actor: Actor = {
    type: "human",
    id: "user-42",
    groups: ["employee", "manager"],
    metadata: { department: "engineering", level: 3 },
  };

  it("resolves $actor.id", () => {
    const condition = { field: "created_by", operator: "eq" as const, value: "$actor.id" };
    const result = resolveConditionVariables(condition, actor);

    expect(result.value).toBe("user-42");
    expect(result.field).toBe("created_by");
    expect(result.operator).toBe("eq");
  });

  it("resolves $actor.type", () => {
    const condition = { field: "actor_type", operator: "eq" as const, value: "$actor.type" };
    const result = resolveConditionVariables(condition, actor);

    expect(result.value).toBe("human");
  });

  it("resolves $actor.groups", () => {
    const condition = { field: "group", operator: "in" as const, value: "$actor.groups" };
    const result = resolveConditionVariables(condition, actor);

    expect(result.value).toEqual(["employee", "manager"]);
  });

  it("resolves $actor.metadata.department", () => {
    const condition = {
      field: "department",
      operator: "eq" as const,
      value: "$actor.metadata.department",
    };
    const result = resolveConditionVariables(condition, actor);

    expect(result.value).toBe("engineering");
  });

  it("resolves $actor.metadata.level (numeric)", () => {
    const condition = {
      field: "level",
      operator: "gte" as const,
      value: "$actor.metadata.level",
    };
    const result = resolveConditionVariables(condition, actor);

    expect(result.value).toBe(3);
  });

  it("passes through non-variable values unchanged", () => {
    const condition = { field: "status", operator: "eq" as const, value: "active" };
    const result = resolveConditionVariables(condition, actor);

    expect(result).toEqual(condition);
  });

  it("passes through numeric values unchanged", () => {
    const condition = { field: "amount", operator: "gt" as const, value: 1000 };
    const result = resolveConditionVariables(condition, actor);

    expect(result).toEqual(condition);
  });

  it("returns undefined for non-existent metadata path", () => {
    const condition = {
      field: "team",
      operator: "eq" as const,
      value: "$actor.metadata.nonexistent",
    };
    const result = resolveConditionVariables(condition, actor);

    expect(result.value).toBeUndefined();
  });

  it("does not mutate the original condition", () => {
    const condition = { field: "created_by", operator: "eq" as const, value: "$actor.id" };
    const result = resolveConditionVariables(condition, actor);

    expect(condition.value).toBe("$actor.id");
    expect(result.value).toBe("user-42");
    expect(result).not.toBe(condition);
  });
});
