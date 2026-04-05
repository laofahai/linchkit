/**
 * Scaffold tools for AI agents
 *
 * These MCP tools generate TypeScript code templates for LinchKit artifacts
 * (capabilities, actions, rules). The AI agent receives the template as text
 * and decides what to do with it (write to file, modify, etc.).
 */

import { validateIdentifier } from "@linchkit/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toMcpShape } from "./zod-compat";

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

  entities: [
    // Define entities here
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
  /** Target entity name */
  entity?: string;
  /** @deprecated Use `entity` instead */
  schema?: string;
  description?: string;
  inputFields?: Record<string, string>;
}): string {
  const { name, entity, schema, description = `${name} action`, inputFields } = params;
  const targetEntity = entity ?? schema ?? name;
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
  entity: "${targetEntity}",
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
    const result = await ctx.create("${targetEntity}", {
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
      entity: "entity_name",
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
    "Generate a TypeScript CapabilityDefinition template with entity, action, and factory boilerplate",
    toMcpShape(scaffoldCapabilityShape),
    async (args: {
      name: string;
      type?: "standard" | "adapter" | "bridge";
      description?: string;
    }) => {
      const check = validateIdentifier(args.name);
      if (!check.valid) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Invalid capability name: ${check.error}` }],
        };
      }
      const code = generateCapabilityTemplate(args);
      return {
        content: [{ type: "text" as const, text: code }],
      };
    },
  );

  // scaffold_action
  const scaffoldActionShape = {
    name: z.string().describe("Action name in snake_case"),
    entity: z.string().describe("Target entity name"),
    description: z.string().describe("Short description of the action").optional(),
    inputFields: z
      .record(z.string(), z.string())
      .describe("Input field mapping: field_name -> field_type (e.g. string, number, boolean)")
      .optional(),
  };
  server.tool(
    "scaffold_action",
    "Generate a TypeScript ActionDefinition template with handler skeleton",
    toMcpShape(scaffoldActionShape),
    async (args: {
      name: string;
      entity: string;
      description?: string;
      inputFields?: Record<string, string>;
    }) => {
      const nameCheck = validateIdentifier(args.name);
      if (!nameCheck.valid) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Invalid action name: ${nameCheck.error}` }],
        };
      }
      const entityCheck = validateIdentifier(args.entity);
      if (!entityCheck.valid) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Invalid entity name: ${entityCheck.error}` }],
        };
      }
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
    toMcpShape(scaffoldRuleShape),
    async (args: {
      name: string;
      triggerType: "action" | "stateChange" | "schedule";
      description?: string;
    }) => {
      const check = validateIdentifier(args.name);
      if (!check.valid) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Invalid rule name: ${check.error}` }],
        };
      }
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
