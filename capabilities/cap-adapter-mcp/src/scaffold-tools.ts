/**
 * Scaffold tools for AI agents
 *
 * These MCP tools generate TypeScript code templates for LinchKit artifacts
 * (capabilities, actions, rules). The AI agent receives the template as text
 * and decides what to do with it (write to file, modify, etc.).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Generate a CapabilityDefinition TypeScript template.
 */
export function generateCapabilityTemplate(params: {
  name: string;
  type?: "standard" | "adapter" | "bridge";
  description?: string;
}): string {
  const { name, type = "standard", description = `${name} capability` } = params;
  const pascalName = snakeToPascal(name);

  return `import type { CapabilityDefinition } from "@linchkit/core";

/**
 * ${description}
 */
export const ${name}_capability: CapabilityDefinition = {
  name: "${name}",
  label: "${pascalName}",
  description: "${description}",
  type: "${type}",
  category: "business",
  version: "0.1.0",

  schemas: [
    // Define schemas here
    // {
    //   name: "${name}",
    //   label: "${pascalName}",
    //   fields: {
    //     title: { type: "string", label: "Title", required: true },
    //   },
    // },
  ],

  actions: [
    // Define actions here
  ],

  rules: [
    // Define rules here
  ],

  states: [
    // Define state machines here
  ],
};

export default ${name}_capability;
`;
}

/**
 * Generate an ActionDefinition TypeScript template.
 */
export function generateActionTemplate(params: {
  name: string;
  schema: string;
  description?: string;
  inputFields?: Record<string, string>;
}): string {
  const { name, schema, description = `${name} action`, inputFields } = params;
  const pascalName = snakeToPascal(name);

  // Build input fields block
  let inputBlock: string;
  if (inputFields && Object.keys(inputFields).length > 0) {
    const fieldEntries = Object.entries(inputFields)
      .map(([fieldName, fieldType]) => {
        const validType = validateFieldType(fieldType);
        return `    ${fieldName}: { type: "${validType}", label: "${snakeToPascal(fieldName)}", required: true },`;
      })
      .join("\n");
    inputBlock = `{\n${fieldEntries}\n  }`;
  } else {
    inputBlock = `{
    // Define input fields here
    // name: { type: "string", label: "Name", required: true },
  }`;
  }

  return `import type { ActionDefinition } from "@linchkit/core";

/**
 * ${description}
 */
export const ${name}_action: ActionDefinition = {
  name: "${name}",
  schema: "${schema}",
  label: "${pascalName}",
  description: "${description}",

  input: ${inputBlock},

  policy: {
    mode: "sync",
    transaction: true,
  },

  exposure: "all",

  async handler(ctx) {
    const { input } = ctx;

    // TODO: Implement action logic
    const result = await ctx.create("${schema}", {
      ...input,
    });

    return result;
  },
};

export default ${name}_action;
`;
}

/**
 * Generate a RuleDefinition TypeScript template.
 */
export function generateRuleTemplate(params: {
  name: string;
  triggerType: "action" | "stateChange" | "schedule";
  description?: string;
}): string {
  const { name, triggerType, description = `${name} rule` } = params;
  const pascalName = snakeToPascal(name);

  let triggerBlock: string;
  switch (triggerType) {
    case "action":
      triggerBlock = `{ action: "action_name" }`;
      break;
    case "stateChange":
      triggerBlock = `{
    stateChange: {
      schema: "schema_name",
      from: "draft",
      to: "published",
    },
  }`;
      break;
    case "schedule":
      triggerBlock = `{ schedule: "0 0 * * *" }`;
      break;
  }

  return `import type { RuleDefinition } from "@linchkit/core";

/**
 * ${description}
 */
export const ${name}_rule: RuleDefinition = {
  name: "${name}",
  label: "${pascalName}",
  description: "${description}",
  priority: 10,

  trigger: ${triggerBlock},

  condition: {
    field: "status",
    operator: "eq",
    value: "active",
  },

  effect: {
    type: "block",
    message: "Blocked by ${name} rule",
  },
};

export default ${name}_rule;
`;
}

/**
 * Register scaffold tools on the MCP server.
 */
export function registerScaffoldTools(server: McpServer): void {
  // scaffold_capability
  const scaffoldCapabilityShape = {
    name: z.string().describe("Capability name in snake_case"),
    type: z.enum(["standard", "adapter", "bridge"]).describe("Capability type").optional(),
    description: z.string().describe("Short description of the capability").optional(),
  };
  server.tool(
    "scaffold_capability",
    "Generate a TypeScript CapabilityDefinition template with schema, action, and factory boilerplate",
    // biome-ignore lint/suspicious/noExplicitAny: zod v4 vs SDK bundled zod type mismatch
    scaffoldCapabilityShape as any,
    async (args: {
      name: string;
      type?: "standard" | "adapter" | "bridge";
      description?: string;
    }) => {
      const code = generateCapabilityTemplate(args);
      return {
        content: [{ type: "text" as const, text: code }],
      };
    },
  );

  // scaffold_action
  const scaffoldActionShape = {
    name: z.string().describe("Action name in snake_case"),
    schema: z.string().describe("Target schema name"),
    description: z.string().describe("Short description of the action").optional(),
    inputFields: z
      .record(z.string(), z.string())
      .describe("Input field mapping: field_name -> field_type (e.g. string, number, boolean)")
      .optional(),
  };
  server.tool(
    "scaffold_action",
    "Generate a TypeScript ActionDefinition template with handler skeleton",
    // biome-ignore lint/suspicious/noExplicitAny: zod v4 vs SDK bundled zod type mismatch
    scaffoldActionShape as any,
    async (args: {
      name: string;
      schema: string;
      description?: string;
      inputFields?: Record<string, string>;
    }) => {
      const code = generateActionTemplate(args);
      return {
        content: [{ type: "text" as const, text: code }],
      };
    },
  );

  // scaffold_rule
  const scaffoldRuleShape = {
    name: z.string().describe("Rule name in snake_case"),
    triggerType: z
      .enum(["action", "stateChange", "schedule"])
      .describe("Type of trigger for the rule"),
    description: z.string().describe("Short description of the rule").optional(),
  };
  server.tool(
    "scaffold_rule",
    "Generate a TypeScript RuleDefinition template with the chosen trigger type",
    // biome-ignore lint/suspicious/noExplicitAny: zod v4 vs SDK bundled zod type mismatch
    scaffoldRuleShape as any,
    async (args: {
      name: string;
      triggerType: "action" | "stateChange" | "schedule";
      description?: string;
    }) => {
      const code = generateRuleTemplate(args);
      return {
        content: [{ type: "text" as const, text: code }],
      };
    },
  );
}

// ── Helpers ──────────────────────────────────────────

/** Convert snake_case to PascalCase */
function snakeToPascal(s: string): string {
  return s
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/** Validate and normalize a field type string */
function validateFieldType(type: string): string {
  const validTypes = [
    "string",
    "text",
    "number",
    "boolean",
    "date",
    "datetime",
    "enum",
    "json",
    "state",
  ];
  return validTypes.includes(type) ? type : "string";
}
