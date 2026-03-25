/**
 * E2E integration tests: Cross-subsystem interactions.
 *
 * Covers:
 *   1. Data Masking + Command Pipeline Integration
 *   2. Tenant Isolation + CRUD
 *   3. Cache + Event-driven Invalidation
 *   4. AI Boundary + Flow Interaction
 *   5. Schema Interface + Inheritance
 *
 * All in-memory — no external services required.
 */

import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type {
  ActionDefinition,
  Actor,
  AICompletionResult,
  AIService,
  InterfaceDefinition,
  SchemaDefinition,
} from "@linchkit/core";
import { AIBoundary, AuthorizationError, canUnmask, maskRecord, maskRecords } from "@linchkit/core";
import {
  type ActionExecutor,
  CacheManager,
  type CommandLayer,
  createActionExecutor,
  createCommandLayer,
  createInterfaceRegistry,
  createOntologyRegistry,
  createSchemaRegistry,
  createTenantAwareDataProvider,
  type DataProvider,
  InMemoryExecutionLogger,
} from "@linchkit/core/server";
import type { Logger } from "../src/types/logger";
import type { PermissionGroupDefinition } from "../src/types/permission";

// ── Shared helpers ──────────────────────────────────────

function _sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createVersionedDataProvider(): DataProvider {
  const store = new Map<string, Map<string, Record<string, unknown>>>();
  let counter = 0;

  function getTable(schema: string): Map<string, Record<string, unknown>> {
    if (!store.has(schema)) store.set(schema, new Map());
    // biome-ignore lint/style/noNonNullAssertion: guaranteed to exist after set above
    return store.get(schema)!;
  }

  return {
    async get(schema, id) {
      const record = getTable(schema).get(id);
      if (!record) throw new Error(`Record not found: ${schema}/${id}`);
      return { ...record };
    },
    async query(schema, _filter, options?) {
      const tenantId = (options as Record<string, unknown> | undefined)?.tenantId as
        | string
        | undefined;
      return Array.from(getTable(schema).values())
        .filter((r) => (tenantId ? r.tenant_id === tenantId : true))
        .map((r) => ({ ...r }));
    },
    async create(schema, data) {
      counter++;
      const id = (data.id as string) ?? `rec_${counter}`;
      const record: Record<string, unknown> = {
        ...data,
        id,
        _version: 1,
        tenant_id: data.tenant_id ?? null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        created_by: null,
        updated_by: null,
      };
      getTable(schema).set(id, record);
      return { ...record };
    },
    async update(schema, id, updates, options?) {
      const table = getTable(schema);
      const existing = table.get(id);
      if (!existing) throw new Error(`Record not found: ${schema}/${id}`);

      const tenantId = (options as Record<string, unknown> | undefined)?.tenantId as
        | string
        | undefined;
      if (tenantId && existing.tenant_id !== tenantId) {
        throw new AuthorizationError("Cross-tenant update rejected");
      }

      const updated = {
        ...existing,
        ...updates,
        _version: ((existing._version as number) ?? 0) + 1,
        updated_at: new Date().toISOString(),
      };
      table.set(id, updated);
      return { ...updated };
    },
    async delete(schema, id, options?) {
      const table = getTable(schema);
      const tenantId = (options as Record<string, unknown> | undefined)?.tenantId as
        | string
        | undefined;
      const existing = table.get(id);
      if (!existing) throw new Error(`Record not found: ${schema}/${id}`);
      if (tenantId && existing.tenant_id !== tenantId) {
        throw new AuthorizationError("Cross-tenant delete rejected");
      }
      table.delete(id);
    },
    async count(schema, _filter?, options?) {
      const tenantId = (options as Record<string, unknown> | undefined)?.tenantId as
        | string
        | undefined;
      if (tenantId) {
        return Array.from(getTable(schema).values()).filter((r) => r.tenant_id === tenantId).length;
      }
      return getTable(schema).size;
    },
  };
}

function createMockLogger(): Logger {
  return {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  };
}

function createMockAIService(result?: Partial<AICompletionResult>): AIService {
  const defaultResult: AICompletionResult = {
    content: "Test response",
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      cost: 0.01,
    },
    model: "test-model",
    provider: "test-provider",
    duration: 500,
    ...result,
  };

  return {
    complete: mock(() => Promise.resolve(defaultResult)),
  };
}

// ═══════════════════════════════════════════════════════════
// 1. Data Masking + Command Pipeline Integration
// ═══════════════════════════════════════════════════════════

describe("E2E: Data Masking + Command Pipeline", () => {
  const sensitiveSchema: SchemaDefinition = {
    name: "employee",
    label: "Employee",
    fields: {
      name: { type: "string", required: true, label: "Name" },
      email: { type: "string", label: "Email" },
      ssn: { type: "string", label: "SSN", sensitive: true },
      salary: {
        type: "number",
        label: "Salary",
        secret: true,
      },
      phone: {
        type: "string",
        label: "Phone",
        sensitive: true,
        masking: { strategy: "partial", visibleChars: 4, position: "end" },
      },
    },
  };

  const regularActor: Actor = {
    type: "human",
    id: "emp-001",
    name: "Regular Employee",
    groups: ["employee"],
  };

  const adminActor: Actor = {
    type: "human",
    id: "admin-001",
    name: "System Admin",
    groups: ["system_admin"],
  };

  const permissionGroups: PermissionGroupDefinition[] = [
    {
      name: "system_admin",
      label: "System Admin",
      permissions: {
        hr: {
          employee: {
            actions: ["*"],
            fields: { unmask: ["ssn", "salary", "phone"] },
          },
        },
      },
    },
    {
      name: "employee",
      label: "Employee",
      permissions: {
        hr: {
          employee: {
            actions: ["read"],
          },
        },
      },
    },
  ];

  let dataProvider: DataProvider;
  let executor: ActionExecutor;
  let layer: CommandLayer;

  const createAction: ActionDefinition = {
    name: "create_employee",
    schema: "employee",
    label: "Create Employee",
    policy: { mode: "sync", transaction: false },
    exposure: "all",
    handler: async (ctx) => {
      return ctx.create("employee", ctx.input);
    },
  };

  const readAction: ActionDefinition = {
    name: "read_employee",
    schema: "employee",
    label: "Read Employee",
    policy: { mode: "sync", transaction: false },
    exposure: "all",
    handler: async (ctx) => {
      return ctx.get("employee", ctx.input.id as string);
    },
  };

  beforeAll(() => {
    dataProvider = createVersionedDataProvider();
    executor = createActionExecutor({
      dataProvider,
      executionLogger: new InMemoryExecutionLogger(),
    });
    executor.registry.register(createAction);
    executor.registry.register(readAction);

    const schemaRegistry = createSchemaRegistry();
    schemaRegistry.register(sensitiveSchema);

    layer = createCommandLayer({ executor });
  });

  let createdId: string;

  test("create record with sensitive/secret fields via CommandLayer", async () => {
    const result = await layer.execute({
      command: "create_employee",
      input: {
        name: "Alice Johnson",
        email: "alice@example.com",
        ssn: "123-45-6789",
        salary: 85000,
        phone: "555-123-4567",
      },
      actor: regularActor,
    });

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.id).toBeDefined();
    createdId = data.id as string;
    // Raw data returned from create — no masking at action level
    expect(data.ssn).toBe("123-45-6789");
    expect(data.salary).toBe(85000);
  });

  test("maskRecord applies masking for regular user (no unmask permission)", () => {
    const rawRecord = {
      id: createdId,
      name: "Alice Johnson",
      email: "alice@example.com",
      ssn: "123-45-6789",
      salary: 85000,
      phone: "555-123-4567",
    };

    const masked = maskRecord(rawRecord, sensitiveSchema, {
      actor: regularActor,
      groups: permissionGroups,
      capabilityName: "hr",
    });

    // Non-sensitive fields pass through
    expect(masked.name).toBe("Alice Johnson");
    expect(masked.email).toBe("alice@example.com");

    // Sensitive field (ssn) gets partial mask (default for sensitive)
    expect(masked.ssn).not.toBe("123-45-6789");
    expect(typeof masked.ssn).toBe("string");
    // Should show last 4 chars
    expect((masked.ssn as string).endsWith("6789")).toBe(true);

    // Secret field (salary) gets full mask → null
    expect(masked.salary).toBeNull();

    // Phone with explicit partial masking
    expect(masked.phone).not.toBe("555-123-4567");
    expect((masked.phone as string).endsWith("4567")).toBe(true);
  });

  test("maskRecord returns unmasked data for system_admin actor", () => {
    const rawRecord = {
      id: createdId,
      name: "Alice Johnson",
      email: "alice@example.com",
      ssn: "123-45-6789",
      salary: 85000,
      phone: "555-123-4567",
    };

    const unmasked = maskRecord(rawRecord, sensitiveSchema, {
      actor: adminActor,
      groups: permissionGroups,
      capabilityName: "hr",
    });

    // system_admin sees raw data
    expect(unmasked.ssn).toBe("123-45-6789");
    expect(unmasked.salary).toBe(85000);
    expect(unmasked.phone).toBe("555-123-4567");
  });

  test("maskRecords applies masking to array of records", () => {
    const records = [
      { id: "1", name: "Alice", ssn: "111-22-3333", salary: 50000, phone: "555-111-2222" },
      { id: "2", name: "Bob", ssn: "444-55-6666", salary: 60000, phone: "555-333-4444" },
    ];

    const masked = maskRecords(records, sensitiveSchema, {
      actor: regularActor,
      groups: permissionGroups,
      capabilityName: "hr",
    });

    expect(masked).toHaveLength(2);
    // Both records should have masked SSN
    expect(masked[0]?.ssn).not.toBe("111-22-3333");
    expect(masked[1]?.ssn).not.toBe("444-55-6666");
    // Both salaries should be null (secret = full mask)
    expect(masked[0]?.salary).toBeNull();
    expect(masked[1]?.salary).toBeNull();
  });

  test("canUnmask correctly checks field-level permissions", () => {
    // system_admin can unmask
    expect(canUnmask(adminActor, permissionGroups, "hr", "employee", "ssn")).toBe(true);
    expect(canUnmask(adminActor, permissionGroups, "hr", "employee", "salary")).toBe(true);

    // regular employee cannot unmask
    expect(canUnmask(regularActor, permissionGroups, "hr", "employee", "ssn")).toBe(false);
    expect(canUnmask(regularActor, permissionGroups, "hr", "employee", "salary")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// 2. Tenant Isolation + CRUD
// ═══════════════════════════════════════════════════════════

describe("E2E: Tenant Isolation + CRUD", () => {
  let baseProvider: DataProvider;

  beforeEach(() => {
    baseProvider = createVersionedDataProvider();
  });

  test("tenant A creates records, tenant B cannot read them", async () => {
    const providerA = createTenantAwareDataProvider(baseProvider, "tenant_A");
    const providerB = createTenantAwareDataProvider(baseProvider, "tenant_B");

    // Tenant A creates a record
    const record = await providerA.create("orders", { name: "Order A1" });
    expect(record.tenant_id).toBe("tenant_A");

    // Tenant B queries — should get empty (tenant-filtered)
    const resultsB = await providerB.query("orders", {});
    expect(resultsB).toHaveLength(0);

    // Tenant A queries — should see their own record
    const resultsA = await providerA.query("orders", {});
    expect(resultsA).toHaveLength(1);
    expect(resultsA[0]?.name).toBe("Order A1");
  });

  test("cross-tenant write is rejected", async () => {
    const providerA = createTenantAwareDataProvider(baseProvider, "tenant_A");

    // Attempting to create with a different tenant_id is rejected
    expect(providerA.create("orders", { name: "Sneaky", tenant_id: "tenant_B" })).rejects.toThrow(
      AuthorizationError,
    );
  });

  test("cross-tenant update is rejected", async () => {
    const providerA = createTenantAwareDataProvider(baseProvider, "tenant_A");
    const record = await providerA.create("orders", { name: "Order A" });

    // Attempting to change tenant_id on update is rejected
    expect(
      providerA.update("orders", record.id as string, { tenant_id: "tenant_B" }),
    ).rejects.toThrow(AuthorizationError);
  });

  test("system actor bypasses tenant isolation", async () => {
    const providerA = createTenantAwareDataProvider(baseProvider, "tenant_A");
    const providerB = createTenantAwareDataProvider(baseProvider, "tenant_B");

    await providerA.create("orders", { name: "Order A" });
    await providerB.create("orders", { name: "Order B" });

    // Direct base provider (system) can see all records
    const allRecords = await baseProvider.query("orders", {});
    expect(allRecords).toHaveLength(2);
  });

  test("tenant-scoped count only counts own records", async () => {
    const providerA = createTenantAwareDataProvider(baseProvider, "tenant_A");
    const providerB = createTenantAwareDataProvider(baseProvider, "tenant_B");

    await providerA.create("orders", { name: "A1" });
    await providerA.create("orders", { name: "A2" });
    await providerB.create("orders", { name: "B1" });

    const countA = await providerA.count("orders");
    const countB = await providerB.count("orders");

    expect(countA).toBe(2);
    expect(countB).toBe(1);
  });

  test("tenant-scoped delete only deletes own records", async () => {
    const providerA = createTenantAwareDataProvider(baseProvider, "tenant_A");
    const providerB = createTenantAwareDataProvider(baseProvider, "tenant_B");

    const recordA = await providerA.create("orders", { name: "A1" });
    await providerB.create("orders", { name: "B1" });

    // Tenant A deletes own record
    await providerA.delete("orders", recordA.id as string);

    // Tenant A has 0, tenant B still has 1
    expect(await providerA.count("orders")).toBe(0);
    expect(await providerB.count("orders")).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════
// 3. Cache + Event-driven Invalidation
// ═══════════════════════════════════════════════════════════

describe("E2E: Cache + Event-driven Invalidation", () => {
  function makeEvent(
    type: string,
    overrides: Partial<import("@linchkit/core").EventRecord> = {},
  ): import("@linchkit/core").EventRecord {
    return {
      id: crypto.randomUUID(),
      type,
      category: "runtime",
      timestamp: new Date(),
      actor: { type: "system", id: "test" },
      executionId: crypto.randomUUID(),
      payload: {},
      ...overrides,
    };
  }

  test("cache is invalidated when record.created event fires", () => {
    const manager = new CacheManager();

    // Cache a query result
    manager.set("orders:list", [{ id: "1", name: "Order 1" }], { tags: ["schema:orders"] });
    expect(manager.get("orders:list")).toBeDefined();

    // Simulate creating a record via handleEvent (direct call, avoids EventBus withTrace bug)
    manager.handleEvent(makeEvent("record.created", { schema: "orders" }));

    // Cache should be invalidated
    expect(manager.get("orders:list")).toBeUndefined();
  });

  test("cache is invalidated when record.updated event fires", () => {
    const manager = new CacheManager();

    // Cache a single record lookup
    manager.set("orders:rec-1", { id: "rec-1", name: "Order" }, { tags: ["schema:orders"] });
    expect(manager.get("orders:rec-1")).toBeDefined();

    // Simulate updating a record
    manager.handleEvent(makeEvent("record.updated", { schema: "orders" }));

    expect(manager.get("orders:rec-1")).toBeUndefined();
  });

  test("tenant-scoped cache invalidation does not affect other tenants", () => {
    const manager = new CacheManager();

    // Cache for two different tenants
    manager.set("t1:orders", "tenant1-data", { tags: ["schema:t1:orders"] });
    manager.set("t2:orders", "tenant2-data", { tags: ["schema:t2:orders"] });

    // Event scoped to tenant 1
    manager.handleEvent(makeEvent("record.updated", { schema: "orders", tenantId: "t1" }));

    // Tenant 1 cache invalidated, tenant 2 unaffected
    expect(manager.get("t1:orders")).toBeUndefined();
    expect(manager.get("t2:orders")).toBe("tenant2-data");
  });

  test("namespace-based cache with event invalidation", () => {
    const manager = new CacheManager();

    const ordersCache = manager.namespace("orders");
    ordersCache.set("list", [{ id: "1" }], { tags: ["schema:orders"] });
    ordersCache.set("count", 42, { tags: ["schema:orders"] });

    // Unrelated schema cache should not be affected
    manager.set("products:list", "products-data", { tags: ["schema:products"] });

    manager.handleEvent(makeEvent("record.created", { schema: "orders" }));

    // Orders cache entries invalidated
    expect(ordersCache.get("list")).toBeUndefined();
    expect(ordersCache.get("count")).toBeUndefined();

    // Products cache unaffected
    expect(manager.get("products:list")).toBe("products-data");
  });

  test("manual tag-based invalidation works alongside event-driven", () => {
    const manager = new CacheManager();

    manager.set("a", 1, { tags: ["group:alpha"] });
    manager.set("b", 2, { tags: ["group:alpha", "group:beta"] });
    manager.set("c", 3, { tags: ["group:beta"] });

    // Manually invalidate group:alpha
    const count = manager.invalidateByTag("group:alpha");
    expect(count).toBe(2);

    expect(manager.get("a")).toBeUndefined();
    expect(manager.get("b")).toBeUndefined();
    expect(manager.get("c")).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════
// 4. AI Boundary + Flow Interaction
// ═══════════════════════════════════════════════════════════

describe("E2E: AI Boundary + Flow Interaction", () => {
  let aiService: AIService;
  let logger: Logger;

  beforeEach(() => {
    aiService = createMockAIService();
    logger = createMockLogger();
  });

  test("rate limit enforcement blocks excess AI calls", () => {
    const boundary = new AIBoundary({
      aiService,
      logger,
      defaultPolicy: {
        name: "rate-limited",
        rateLimits: {
          maxRequestsPerMinute: 3,
          maxRequestsPerHour: 50,
        },
      },
    });

    const request = { source: "flow" as const, tenantId: "tenant-1" };

    // First checks should pass
    expect(boundary.check(request).allowed).toBe(true);

    // Simulate hitting the rate limit
    const budget = boundary.getBudget("tenant-1");
    budget.requestsThisMinute = 3;

    const result = boundary.check(request);
    expect(result.allowed).toBe(false);
    expect(result.violation).toBe("rate_limit");
    expect(result.reason).toContain("per minute");
  });

  test("budget tracking blocks when daily cost exceeded", () => {
    const boundary = new AIBoundary({
      aiService,
      logger,
      defaultPolicy: {
        name: "budget-capped",
        budget: {
          maxCostPerDay: 25.0,
          maxTokensPerDay: 500000,
          alertThreshold: 0.8,
        },
      },
    });

    // Simulate cost accumulation
    const budget = boundary.getBudget("tenant-1");
    budget.costToday = 25.0;

    const result = boundary.check({
      source: "flow",
      tenantId: "tenant-1",
    });

    expect(result.allowed).toBe(false);
    expect(result.violation).toBe("budget_exceeded");
  });

  test("budget alert triggers at threshold", () => {
    const onBudgetAlert = mock(() => {});

    const boundary = new AIBoundary({
      aiService,
      logger,
      defaultPolicy: {
        name: "budget-alert",
        budget: {
          maxCostPerDay: 100.0,
          alertThreshold: 0.8,
        },
      },
      onBudgetAlert,
    });

    const budget = boundary.getBudget("tenant-1");
    budget.costToday = 85.0; // 85% of $100

    const result = boundary.check({
      source: "flow",
      tenantId: "tenant-1",
    });

    expect(result.allowed).toBe(true);
    expect(result.warnings).toBeDefined();
    expect(result.warnings?.length).toBeGreaterThan(0);
    expect(onBudgetAlert).toHaveBeenCalled();
  });

  test("content filter blocks PII in prompts", () => {
    const boundary = new AIBoundary({
      aiService,
      logger,
      defaultPolicy: {
        name: "pii-filtered",
        contentFilters: [
          {
            name: "ssn-filter",
            type: "regex",
            pattern: "\\b\\d{3}-\\d{2}-\\d{4}\\b",
            action: "block",
            scope: "input",
          },
          {
            name: "api-key-filter",
            type: "keyword",
            pattern: "api_secret",
            action: "block",
          },
        ],
      },
    });

    // SSN in prompt — blocked
    const ssnResult = boundary.check({
      source: "api",
      promptContent: "Look up records for 123-45-6789",
    });
    expect(ssnResult.allowed).toBe(false);
    expect(ssnResult.violation).toBe("content_filtered");
    expect(ssnResult.reason).toContain("ssn-filter");

    // API secret in prompt — blocked
    const apiResult = boundary.check({
      source: "flow",
      promptContent: "Use API_SECRET to authenticate",
    });
    expect(apiResult.allowed).toBe(false);
    expect(apiResult.violation).toBe("content_filtered");

    // Clean prompt — allowed
    const cleanResult = boundary.check({
      source: "api",
      promptContent: "Summarize the quarterly report",
    });
    expect(cleanResult.allowed).toBe(true);
  });

  test("action access control with allowlist and denylist", () => {
    const boundary = new AIBoundary({
      aiService,
      logger,
      defaultPolicy: {
        name: "strict-actions",
        actionAccess: {
          mode: "allowlist",
          actions: ["query_data", "generate_report", "analyze_trends"],
        },
      },
    });

    // Allowed action
    expect(boundary.check({ source: "mcp", actionName: "query_data" }).allowed).toBe(true);

    // Blocked action
    const blocked = boundary.check({
      source: "mcp",
      actionName: "delete_all_records",
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.violation).toBe("action_denied");
  });

  test("combined rate limit + content filter + budget in single boundary", () => {
    const boundary = new AIBoundary({
      aiService,
      logger,
      defaultPolicy: {
        name: "full-protection",
        rateLimits: { maxRequestsPerMinute: 10 },
        budget: { maxCostPerDay: 50.0 },
        contentFilters: [
          {
            name: "secret-filter",
            type: "keyword",
            pattern: "password",
            action: "block",
          },
        ],
      },
    });

    // Clean request passes all checks
    expect(boundary.check({ source: "api", tenantId: "t1" }).allowed).toBe(true);

    // Content filter triggers first
    const contentBlocked = boundary.check({
      source: "api",
      tenantId: "t1",
      promptContent: "My password is hunter2",
    });
    expect(contentBlocked.allowed).toBe(false);
    expect(contentBlocked.violation).toBe("content_filtered");

    // Rate limit triggers
    const budget = boundary.getBudget("t1");
    budget.requestsThisMinute = 10;
    const rateBlocked = boundary.check({
      source: "api",
      tenantId: "t1",
    });
    expect(rateBlocked.allowed).toBe(false);
    expect(rateBlocked.violation).toBe("rate_limit");
  });
});

// ═══════════════════════════════════════════════════════════
// 5. Schema Interface + Inheritance
// ═══════════════════════════════════════════════════════════

describe("E2E: Schema Interface + Inheritance", () => {
  const auditableInterface: InterfaceDefinition = {
    name: "auditable",
    label: "Auditable",
    description: "Schemas that track audit information",
    fields: {
      audit_created_at: { type: "datetime", required: false },
      audit_updated_at: { type: "datetime", required: false },
      audit_created_by: { type: "string", required: false },
    },
  };

  const timestampedInterface: InterfaceDefinition = {
    name: "timestamped",
    label: "Timestamped",
    fields: {
      valid_from: { type: "datetime", required: true },
      valid_until: { type: "datetime", required: false },
    },
  };

  test("schema implementing interface gets injected fields on resolve", () => {
    const ifaceRegistry = createInterfaceRegistry();
    ifaceRegistry.register(auditableInterface);

    const schemaRegistry = createSchemaRegistry();
    schemaRegistry.setInterfaceRegistry(ifaceRegistry);

    const schema: SchemaDefinition = {
      name: "invoice",
      label: "Invoice",
      implements: ["auditable"],
      fields: {
        amount: { type: "number", required: true },
        description: { type: "text" },
      },
    };
    schemaRegistry.register(schema);

    const resolved = schemaRegistry.resolve("invoice");

    // Own fields
    expect(resolved.fields.amount).toBeDefined();
    expect(resolved.fields.description).toBeDefined();

    // Injected from auditable interface
    expect(resolved.fields.audit_created_at).toBeDefined();
    expect(resolved.fields.audit_updated_at).toBeDefined();
    expect(resolved.fields.audit_created_by).toBeDefined();

    expect(resolved.implements).toEqual(["auditable"]);
  });

  test("validation rejects schema with field type conflict against interface", () => {
    const ifaceRegistry = createInterfaceRegistry();
    ifaceRegistry.register(auditableInterface);

    const schemaRegistry = createSchemaRegistry();
    schemaRegistry.setInterfaceRegistry(ifaceRegistry);

    const badSchema: SchemaDefinition = {
      name: "bad_record",
      label: "Bad Record",
      implements: ["auditable"],
      fields: {
        amount: { type: "number" },
        // audit_created_at should be datetime, but we set it to number
        audit_created_at: { type: "number" },
      },
    };

    expect(() => schemaRegistry.register(badSchema)).toThrow("audit_created_at");
  });

  test("validation rejects schema implementing non-existent interface", () => {
    const ifaceRegistry = createInterfaceRegistry();
    // Do NOT register the interface

    const schemaRegistry = createSchemaRegistry();
    schemaRegistry.setInterfaceRegistry(ifaceRegistry);

    const schema: SchemaDefinition = {
      name: "orphan",
      label: "Orphan",
      implements: ["nonexistent_interface"],
      fields: {
        x: { type: "string" },
      },
    };

    expect(() => schemaRegistry.register(schema)).toThrow("nonexistent_interface");
  });

  test("schema can implement multiple interfaces", () => {
    const ifaceRegistry = createInterfaceRegistry();
    ifaceRegistry.register(auditableInterface);
    ifaceRegistry.register(timestampedInterface);

    const schemaRegistry = createSchemaRegistry();
    schemaRegistry.setInterfaceRegistry(ifaceRegistry);

    const schema: SchemaDefinition = {
      name: "contract",
      label: "Contract",
      implements: ["auditable", "timestamped"],
      fields: {
        title: { type: "string", required: true },
        value: { type: "number" },
      },
    };
    schemaRegistry.register(schema);

    const resolved = schemaRegistry.resolve("contract");

    // From auditable
    expect(resolved.fields.audit_created_at).toBeDefined();
    expect(resolved.fields.audit_created_by).toBeDefined();

    // From timestamped
    expect(resolved.fields.valid_from).toBeDefined();
    expect(resolved.fields.valid_until).toBeDefined();

    // Own fields
    expect(resolved.fields.title).toBeDefined();
    expect(resolved.fields.value).toBeDefined();

    expect(resolved.implements).toEqual(["auditable", "timestamped"]);
  });

  test("OntologyRegistry.schemasImplementing() returns correct results", () => {
    const ifaceRegistry = createInterfaceRegistry();
    ifaceRegistry.register(auditableInterface);
    ifaceRegistry.register(timestampedInterface);

    const schemaRegistry = createSchemaRegistry();
    schemaRegistry.setInterfaceRegistry(ifaceRegistry);

    const invoiceSchema: SchemaDefinition = {
      name: "invoice",
      label: "Invoice",
      implements: ["auditable"],
      fields: { amount: { type: "number" } },
    };
    const contractSchema: SchemaDefinition = {
      name: "contract",
      label: "Contract",
      implements: ["auditable", "timestamped"],
      fields: { title: { type: "string" } },
    };
    const simpleSchema: SchemaDefinition = {
      name: "note",
      label: "Note",
      fields: { text: { type: "text" } },
    };

    schemaRegistry.register(invoiceSchema);
    schemaRegistry.register(contractSchema);
    schemaRegistry.register(simpleSchema);

    const ontology = createOntologyRegistry({
      schemas: schemaRegistry,
      actions: { getAll: () => [] },
      rules: [],
      states: [],
      views: [],
      interfaces: ifaceRegistry,
    });

    // Both invoice and contract implement auditable
    const auditableSchemas = ontology.schemasImplementing("auditable");
    expect(auditableSchemas).toContain("invoice");
    expect(auditableSchemas).toContain("contract");
    expect(auditableSchemas).not.toContain("note");

    // Only contract implements timestamped
    const timestampedSchemas = ontology.schemasImplementing("timestamped");
    expect(timestampedSchemas).toContain("contract");
    expect(timestampedSchemas).not.toContain("invoice");
    expect(timestampedSchemas).not.toContain("note");

    // Non-existent interface returns empty
    expect(ontology.schemasImplementing("nonexistent")).toEqual([]);
  });

  test("interface + inheritance work together", () => {
    const ifaceRegistry = createInterfaceRegistry();
    ifaceRegistry.register(auditableInterface);

    const schemaRegistry = createSchemaRegistry();
    schemaRegistry.setInterfaceRegistry(ifaceRegistry);

    // Parent schema
    const baseSchema: SchemaDefinition = {
      name: "base_record",
      label: "Base Record",
      fields: {
        name: { type: "string", required: true },
        active: { type: "boolean", default: true },
      },
    };
    schemaRegistry.register(baseSchema);

    // Child schema that also implements an interface
    const childSchema: SchemaDefinition = {
      name: "audited_record",
      label: "Audited Record",
      extends: "base_record",
      implements: ["auditable"],
      fields: {
        priority: { type: "number" },
      },
    };
    schemaRegistry.register(childSchema);

    const resolved = schemaRegistry.resolve("audited_record");

    // Inherited from parent
    expect(resolved.fields.name).toBeDefined();
    expect(resolved.fields.active).toBeDefined();

    // Own fields
    expect(resolved.fields.priority).toBeDefined();

    // Injected from interface
    expect(resolved.fields.audit_created_at).toBeDefined();
    expect(resolved.fields.audit_updated_at).toBeDefined();
    expect(resolved.fields.audit_created_by).toBeDefined();

    expect(resolved.parent).toBe("base_record");
    expect(resolved.implements).toEqual(["auditable"]);
  });

  test("OntologyRegistry.describe() includes interface info", () => {
    const ifaceRegistry = createInterfaceRegistry();
    ifaceRegistry.register(auditableInterface);

    const schemaRegistry = createSchemaRegistry();
    schemaRegistry.setInterfaceRegistry(ifaceRegistry);

    const schema: SchemaDefinition = {
      name: "tracked_item",
      label: "Tracked Item",
      implements: ["auditable"],
      fields: {
        title: { type: "string", required: true },
      },
    };
    schemaRegistry.register(schema);

    const ontology = createOntologyRegistry({
      schemas: schemaRegistry,
      actions: { getAll: () => [] },
      rules: [],
      states: [],
      views: [],
      interfaces: ifaceRegistry,
    });

    const descriptor = ontology.describe("tracked_item");
    expect(descriptor).toBeDefined();
    expect(descriptor?.interfaces).toHaveLength(1);
    expect(descriptor?.interfaces[0]?.name).toBe("auditable");
  });
});
