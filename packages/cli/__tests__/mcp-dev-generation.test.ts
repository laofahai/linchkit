/**
 * Tests for MCP Dev Server generation tools (issue #156 Phase 4).
 *
 * Verifies linchkit_generate_entity / linchkit_generate_action /
 * linchkit_generate_capability tools and the design_entity /
 * design_capability / diagnose_error prompts.
 *
 * All tool calls use `dryRun: true` so nothing is written to disk.
 */

import { describe, expect, test } from "bun:test";
import type { ActionDefinition, CapabilityDefinition, EntityDefinition } from "@linchkit/core";
import type { CollectedDefinitions } from "../src/commands/startup/collect-capabilities";
import { createMcpDevServer } from "../src/mcp-dev/server";

// ── Mock data ───────────────────────────────────────────────────

const mockEntity: EntityDefinition = {
  name: "purchase_request",
  label: "Purchase Request",
  fields: {
    title: { type: "string", label: "Title", required: true },
    amount: { type: "number", label: "Amount", required: true },
  },
};

const mockAction: ActionDefinition = {
  name: "submit_request",
  entity: "purchase_request",
  label: "Submit Request",
  policy: { requiresAuth: true },
};

const mockCapability: CapabilityDefinition = {
  name: "cap-purchase",
  label: "Purchase Management",
  type: "standard",
  category: "business",
  version: "0.1.0",
  entities: [mockEntity],
  actions: [mockAction],
};

const mockDefinitions: CollectedDefinitions = {
  interfaces: [],
  entities: [mockEntity],
  actions: [mockAction],
  views: [],
  states: [],
  links: [],
  rules: [],
  eventHandlers: [],
  middlewares: [],
  transports: [],
  graphqlExtensions: [],
  commands: [],
};

// ── Helpers ─────────────────────────────────────────────────────

interface RegisteredTool {
  handler: (
    args: Record<string, unknown>,
    extra: unknown,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}
type ToolsMap = Record<string, RegisteredTool>;

function getTools(server: ReturnType<typeof createMcpDevServer>): ToolsMap {
  return (server as unknown as { _registeredTools: ToolsMap })._registeredTools;
}

async function callTool(
  server: ReturnType<typeof createMcpDevServer>,
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const tools = getTools(server);
  const tool = tools[name];
  if (!tool) {
    throw new Error(`Tool '${name}' not registered. Available: ${Object.keys(tools).join(", ")}`);
  }
  return tool.handler(args, {});
}

function parseResult(result: { content: Array<{ type: string; text: string }> }): {
  path?: string;
  rootPath?: string;
  code?: string;
  files?: { path: string; content: string }[];
  validation: { valid: boolean; errors: string[]; warnings: string[] };
  written?: boolean;
  error?: string;
} {
  const text = result.content[0]?.text;
  if (text === undefined) throw new Error("Tool returned no text content");
  return JSON.parse(text);
}

async function callPrompt(
  server: ReturnType<typeof createMcpDevServer>,
  name: string,
  args: Record<string, string> = {},
): Promise<{ messages: Array<{ role: string; content: { type: string; text: string } }> }> {
  // biome-ignore lint/suspicious/noExplicitAny: accessing internal for testing
  const prompts = (server as any)._registeredPrompts as Record<
    string,
    { callback: (...args: never[]) => unknown }
  >;
  const prompt = prompts[name];
  if (!prompt) {
    throw new Error(
      `Prompt '${name}' not registered. Available: ${Object.keys(prompts).join(", ")}`,
    );
  }
  return prompt.callback(args, {}) as ReturnType<typeof callPrompt>;
}

const PROJECT_ROOT = "/tmp/linchkit-mcp-gen-test";

function makeServer(): ReturnType<typeof createMcpDevServer> {
  return createMcpDevServer({
    definitions: mockDefinitions,
    capabilities: [mockCapability],
    projectRoot: PROJECT_ROOT,
  });
}

// ── Tests ───────────────────────────────────────────────────────

describe("MCP Dev Server — generation tools", () => {
  describe("linchkit_generate_entity", () => {
    test("generates a defineEntity() source file (dry run)", async () => {
      const server = makeServer();
      const result = await callTool(server, "linchkit_generate_entity", {
        name: "invoice",
        label: "Invoice",
        description: "A billing invoice",
        fields: {
          number: { type: "string", label: "Number", required: true, unique: true },
          total: { type: "number", label: "Total", min: 0 },
          status: {
            type: "enum",
            label: "Status",
            options: ["draft", "sent", "paid"],
          },
        },
        targetPath: "addons/cap-billing/src/entities/invoice.ts",
        dryRun: true,
      });

      expect(result.isError).toBeUndefined();
      const data = parseResult(result);
      expect(data.validation.valid).toBe(true);
      expect(data.code).toContain("defineEntity(");
      expect(data.code).toContain('name: "invoice"');
      expect(data.code).toContain('options: ["draft","sent","paid"]');
      expect(data.path).toContain("addons/cap-billing/src/entities/invoice.ts");
      expect(data.written).toBe(false);
    });

    test("rejects collision with existing entity", async () => {
      const server = makeServer();
      const result = await callTool(server, "linchkit_generate_entity", {
        name: "purchase_request",
        fields: { x: { type: "string" } },
        targetPath: "x.ts",
        dryRun: true,
      });
      expect(result.isError).toBe(true);
      const data = parseResult(result);
      expect(data.validation.valid).toBe(false);
      expect(data.validation.errors.some((e) => e.includes("already exists"))).toBe(true);
    });

    test("rejects invalid extends target", async () => {
      const server = makeServer();
      const result = await callTool(server, "linchkit_generate_entity", {
        name: "weird_request",
        fields: { x: { type: "string" } },
        extends: "nonexistent_entity",
        targetPath: "x.ts",
        dryRun: true,
      });
      expect(result.isError).toBe(true);
      const data = parseResult(result);
      expect(data.validation.valid).toBe(false);
      expect(data.validation.errors.some((e) => e.includes("Cannot extend"))).toBe(true);
    });

    test("rejects non-snake_case name without throwing", async () => {
      const server = makeServer();
      const result = await callTool(server, "linchkit_generate_entity", {
        name: "MyEntity",
        fields: { x: { type: "string" } },
        targetPath: "x.ts",
        dryRun: true,
      });
      expect(result.isError).toBe(true);
      const data = parseResult(result);
      expect(data.validation.valid).toBe(false);
      expect(data.validation.errors.some((e) => e.includes("snake_case"))).toBe(true);
    });
  });

  describe("linchkit_generate_action", () => {
    test("generates a defineAction() source file (dry run)", async () => {
      const server = makeServer();
      const result = await callTool(server, "linchkit_generate_action", {
        name: "approve_request",
        entity: "purchase_request",
        label: "Approve Request",
        input: { request_id: { type: "string", required: true } },
        policy: { requiresAuth: true },
        targetPath: "addons/cap-purchase/src/actions/approve-request.ts",
        dryRun: true,
      });

      expect(result.isError).toBeUndefined();
      const data = parseResult(result);
      expect(data.validation.valid).toBe(true);
      expect(data.code).toContain("defineAction(");
      expect(data.code).toContain('name: "approve_request"');
      expect(data.code).toContain('entity: "purchase_request"');
      expect(data.code).toContain("handler:");
    });

    test("rejects action without verb_noun shape (no underscore)", async () => {
      const server = makeServer();
      const result = await callTool(server, "linchkit_generate_action", {
        name: "approve",
        entity: "purchase_request",
        targetPath: "x.ts",
        dryRun: true,
      });
      expect(result.isError).toBe(true);
      const data = parseResult(result);
      expect(data.validation.valid).toBe(false);
      expect(data.validation.errors.some((e) => e.includes("verb_noun"))).toBe(true);
    });

    test("rejects action name colliding with existing action", async () => {
      const server = makeServer();
      const result = await callTool(server, "linchkit_generate_action", {
        name: "submit_request",
        entity: "purchase_request",
        targetPath: "x.ts",
        dryRun: true,
      });
      expect(result.isError).toBe(true);
      const data = parseResult(result);
      expect(data.validation.errors.some((e) => e.includes("already exists"))).toBe(true);
    });
  });

  describe("linchkit_generate_capability", () => {
    test("scaffolds package.json + src/index.ts + sub-folders (dry run)", async () => {
      const server = makeServer();
      const result = await callTool(server, "linchkit_generate_capability", {
        name: "cap-inventory",
        type: "standard",
        category: "business",
        label: "Inventory",
        description: "Stock management",
        rootPath: "addons/inventory/cap-inventory",
        scaffoldFolders: true,
        dryRun: true,
      });

      expect(result.isError).toBeUndefined();
      const data = parseResult(result);
      expect(data.validation.valid).toBe(true);
      expect(data.rootPath).toContain("addons/inventory/cap-inventory");
      expect(Array.isArray(data.files)).toBe(true);
      const paths = (data.files ?? []).map((f) => f.path);
      expect(paths.some((p) => p.endsWith("package.json"))).toBe(true);
      expect(paths.some((p) => p.endsWith("src/index.ts"))).toBe(true);
      expect(paths.some((p) => p.endsWith("src/entities/.gitkeep"))).toBe(true);
      expect(paths.some((p) => p.endsWith("src/actions/.gitkeep"))).toBe(true);

      const indexFile = (data.files ?? []).find((f) => f.path.endsWith("src/index.ts"));
      expect(indexFile?.content).toContain("defineCapability(");
      expect(indexFile?.content).toContain('name: "cap-inventory"');
      expect(data.written).toBe(false);
    });

    test("rejects invalid capability type", async () => {
      const server = makeServer();
      const result = await callTool(server, "linchkit_generate_capability", {
        name: "cap-foo",
        type: "weird",
        category: "business",
        rootPath: "addons/foo/cap-foo",
        dryRun: true,
      });
      expect(result.isError).toBe(true);
      const data = parseResult(result);
      expect(data.validation.valid).toBe(false);
      expect(data.validation.errors.some((e) => e.includes("type"))).toBe(true);
    });
  });

  describe("prompts (smoke)", () => {
    test("design_entity returns guidance referencing the domain", async () => {
      const server = makeServer();
      const result = await callPrompt(server, "design_entity", { domain: "inventory" });
      expect(result.messages.length).toBeGreaterThan(0);
      const text = result.messages[0].content.text;
      expect(text).toContain("inventory");
      expect(text).toContain("snake_case");
      expect(text).toContain("linchkit_generate_entity");
    });

    test("design_capability walks through scope question and naming", async () => {
      const server = makeServer();
      const result = await callPrompt(server, "design_capability", { domain: "billing" });
      const text = result.messages[0].content.text;
      expect(text).toContain("billing");
      expect(text).toContain("zero-capability");
      expect(text).toContain("linchkit_generate_capability");
    });

    test("diagnose_error parses LinchKitError context and shows the involved entity/action", async () => {
      const server = makeServer();
      const errorPayload = JSON.stringify({
        message: "Budget exceeded",
        code: "RULE_VIOLATION",
        context: {
          entity: "purchase_request",
          action: "submit_request",
          constraint: "budget_check",
          expected: "amount <= 50000",
          actual: "amount = 75000",
          suggestion: "Reduce the amount or get override approval",
        },
      });
      const result = await callPrompt(server, "diagnose_error", { error: errorPayload });
      const text = result.messages[0].content.text;
      expect(text).toContain("purchase_request");
      expect(text).toContain("submit_request");
      expect(text).toContain("budget_check");
      expect(text).toContain("Proposal");
      expect(text).toContain("[exists in catalog]");
    });
  });
});
