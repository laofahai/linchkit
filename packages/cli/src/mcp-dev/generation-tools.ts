/**
 * MCP Dev Server — Generation tools for scaffolding entities, actions, and capabilities.
 *
 * These tools allow AI agents (Claude Code, Cursor, etc.) to produce
 * LinchKit-compatible source code through MCP. Each tool returns the
 * generated source string and the target file path. Tools may either
 * write to disk (default) or return code only (`dryRun: true`).
 *
 * Issue #156 Phase 4 (Spec 60 §3).
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { CapabilityDefinition } from "@linchkit/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CollectedDefinitions } from "../commands/startup/collect-capabilities";
import { z } from "./schema";

// ── Validation helpers ──────────────────────────────────────────

const SNAKE_CASE_RE = /^[a-z][a-z0-9_]*$/;
const VERB_LIST = [
  "create",
  "update",
  "delete",
  "submit",
  "approve",
  "reject",
  "cancel",
  "archive",
  "restore",
  "publish",
  "unpublish",
  "assign",
  "unassign",
  "send",
  "receive",
  "import",
  "export",
  "sync",
  "validate",
  "process",
  "complete",
  "start",
  "stop",
  "pause",
  "resume",
  "lock",
  "unlock",
  "duplicate",
  "merge",
  "split",
  "reorder",
  "schedule",
  "notify",
  "generate",
  "register",
  "deregister",
  "subscribe",
  "unsubscribe",
];

interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

interface FieldSpec {
  type: string;
  label?: string;
  description?: string;
  required?: boolean;
  unique?: boolean;
  min?: number;
  max?: number;
  default?: unknown;
  options?: string[];
  pattern?: string;
  format?: string;
}

const VALID_FIELD_TYPES = [
  "string",
  "text",
  "number",
  "boolean",
  "date",
  "datetime",
  "enum",
  "json",
  "state",
  "computed",
];

const VALID_CAPABILITY_TYPES = ["standard", "adapter", "bridge"];

const VALID_CAPABILITY_CATEGORIES = [
  "business",
  "system",
  "infrastructure",
  "integration",
  "ui",
  "utility",
  "starter",
];

// ── Code-string builders ────────────────────────────────────────

/** Render a field options object literal as a TS source string. */
function renderField(spec: FieldSpec): string {
  const parts: string[] = [];
  parts.push(`type: ${JSON.stringify(spec.type)}`);
  if (spec.label !== undefined) parts.push(`label: ${JSON.stringify(spec.label)}`);
  if (spec.description !== undefined)
    parts.push(`description: ${JSON.stringify(spec.description)}`);
  if (spec.required) parts.push(`required: true`);
  if (spec.unique) parts.push(`unique: true`);
  if (spec.default !== undefined) parts.push(`default: ${JSON.stringify(spec.default)}`);
  if (spec.min !== undefined) parts.push(`min: ${spec.min}`);
  if (spec.max !== undefined) parts.push(`max: ${spec.max}`);
  if (spec.pattern !== undefined) parts.push(`pattern: ${JSON.stringify(spec.pattern)}`);
  if (spec.format !== undefined) parts.push(`format: ${JSON.stringify(spec.format)}`);
  if (spec.type === "enum" && Array.isArray(spec.options)) {
    parts.push(`options: ${JSON.stringify(spec.options)}`);
  }
  return `{ ${parts.join(", ")} }`;
}

/** Render a fields record as a multi-line TS object literal. */
function renderFields(fields: Record<string, FieldSpec>): string {
  const entries = Object.entries(fields);
  if (entries.length === 0) return "{}";
  const lines = entries.map(([name, spec]) => `    ${name}: ${renderField(spec)},`);
  return `{\n${lines.join("\n")}\n  }`;
}

interface EntityGenInput {
  name: string;
  fields: Record<string, FieldSpec>;
  label?: string;
  description?: string;
  extends?: string;
  implements?: string[];
}

function buildEntitySource(input: EntityGenInput): string {
  const parts: string[] = [];
  parts.push(`  name: ${JSON.stringify(input.name)},`);
  if (input.label !== undefined) parts.push(`  label: ${JSON.stringify(input.label)},`);
  if (input.description !== undefined)
    parts.push(`  description: ${JSON.stringify(input.description)},`);
  if (input.extends !== undefined) parts.push(`  extends: ${JSON.stringify(input.extends)},`);
  if (input.implements !== undefined && input.implements.length > 0)
    parts.push(`  implements: ${JSON.stringify(input.implements)},`);
  parts.push(`  fields: ${renderFields(input.fields)},`);

  return `import { defineEntity } from "@linchkit/core";

export const ${input.name} = defineEntity({
${parts.join("\n")}
});
`;
}

interface ActionGenInput {
  name: string;
  entity: string;
  label?: string;
  description?: string;
  input?: Record<string, FieldSpec>;
  output?: Record<string, FieldSpec>;
  policy?: Record<string, unknown>;
  handlerStub?: string;
}

function buildActionSource(input: ActionGenInput): string {
  const policy = input.policy ?? { requiresAuth: true };
  const parts: string[] = [];
  parts.push(`  name: ${JSON.stringify(input.name)},`);
  parts.push(`  entity: ${JSON.stringify(input.entity)},`);
  parts.push(`  label: ${JSON.stringify(input.label ?? input.name)},`);
  if (input.description !== undefined)
    parts.push(`  description: ${JSON.stringify(input.description)},`);
  if (input.input !== undefined) parts.push(`  input: ${renderFields(input.input)},`);
  if (input.output !== undefined) parts.push(`  output: ${renderFields(input.output)},`);
  parts.push(`  policy: ${JSON.stringify(policy)},`);

  const handler =
    input.handlerStub ??
    `async (ctx) => {
    // TODO: implement ${input.name}
    return ctx.input;
  }`;
  parts.push(`  handler: ${handler},`);

  return `import { defineAction } from "@linchkit/core";

export const ${input.name} = defineAction({
${parts.join("\n")}
});
`;
}

interface CapabilityGenInput {
  name: string;
  type: string;
  category: string;
  label?: string;
  description?: string;
  /** Optionally seed empty entity / action / rule / view sub-folders. */
  scaffoldFolders?: boolean;
}

function buildCapabilitySource(input: CapabilityGenInput): string {
  const safeId = input.name.replace(/[^a-zA-Z0-9_]/g, "_");
  return `import { defineCapability } from "@linchkit/core";

export const ${safeId} = defineCapability({
  name: ${JSON.stringify(input.name)},
  label: ${JSON.stringify(input.label ?? input.name)},
  type: ${JSON.stringify(input.type)},
  category: ${JSON.stringify(input.category)},
  version: "0.1.0",
  description: ${JSON.stringify(input.description ?? "")},
  entities: [],
  actions: [],
  rules: [],
  views: [],
});
`;
}

function buildCapabilityPackageJson(input: CapabilityGenInput): string {
  return `${JSON.stringify(
    {
      name: `@linchkit/${input.name}`,
      version: "0.1.0",
      type: "module",
      main: "src/index.ts",
      peerDependencies: {
        "@linchkit/core": "workspace:*",
      },
    },
    null,
    2,
  )}\n`;
}

// ── Validation ──────────────────────────────────────────────────

function validateEntityInput(input: EntityGenInput, defs: CollectedDefinitions): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!input.name) {
    errors.push("Entity name is required");
  } else if (!SNAKE_CASE_RE.test(input.name)) {
    errors.push(`Entity name '${input.name}' must be snake_case`);
  }

  // Name collision against existing catalog
  if (input.name && defs.entities.some((e) => e.name === input.name)) {
    errors.push(`Entity '${input.name}' already exists in the project catalog`);
  }

  // extends target must exist
  if (input.extends && !defs.entities.some((e) => e.name === input.extends)) {
    errors.push(`Cannot extend '${input.extends}' — entity not found in project catalog`);
  }

  // implements targets must exist
  if (input.implements) {
    for (const iface of input.implements) {
      if (!defs.interfaces.some((i) => i.name === iface)) {
        warnings.push(`Interface '${iface}' not found in project catalog`);
      }
    }
  }

  if (!input.fields || Object.keys(input.fields).length === 0) {
    errors.push("Entity must have at least one field");
  } else {
    for (const [fieldName, spec] of Object.entries(input.fields)) {
      if (!SNAKE_CASE_RE.test(fieldName)) {
        errors.push(`Field '${fieldName}' must be snake_case`);
      }
      if (!spec.type) {
        errors.push(`Field '${fieldName}' missing 'type'`);
      } else if (!VALID_FIELD_TYPES.includes(spec.type)) {
        errors.push(
          `Field '${fieldName}' has invalid type '${spec.type}' (valid: ${VALID_FIELD_TYPES.join(", ")})`,
        );
      }
      if (spec.type === "enum" && (!Array.isArray(spec.options) || spec.options.length === 0)) {
        errors.push(`Enum field '${fieldName}' must have non-empty options[]`);
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

function validateActionInput(input: ActionGenInput, defs: CollectedDefinitions): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!input.name) {
    errors.push("Action name is required");
  } else if (!SNAKE_CASE_RE.test(input.name)) {
    errors.push(`Action name '${input.name}' must be snake_case`);
  } else {
    // verb_noun: must contain underscore + first segment in verb list (warning if missing)
    const segments = input.name.split("_");
    const verb = segments[0];
    if (segments.length < 2 || !verb) {
      errors.push(`Action name '${input.name}' must follow verb_noun (snake_case with underscore)`);
    } else if (!VERB_LIST.includes(verb)) {
      warnings.push(
        `Action name '${input.name}' starts with '${verb}' which is not a recognised verb (e.g. ${VERB_LIST.slice(0, 6).join(", ")})`,
      );
    }
  }

  // name collision with existing actions
  if (input.name && defs.actions.some((a) => a.name === input.name)) {
    errors.push(`Action '${input.name}' already exists in the project catalog`);
  }

  if (!input.entity) {
    errors.push("Action must reference an entity");
  } else if (!defs.entities.some((e) => e.name === input.entity)) {
    warnings.push(`Entity '${input.entity}' not found in project catalog`);
  }

  return { valid: errors.length === 0, errors, warnings };
}

function validateCapabilityInput(
  input: CapabilityGenInput,
  capabilities: CapabilityDefinition[],
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!input.name) {
    errors.push("Capability name is required");
  } else if (!/^[a-z][a-z0-9_-]*$/.test(input.name)) {
    errors.push(`Capability name '${input.name}' must be lowercase letters/digits/-/_`);
  }

  if (input.name && capabilities.some((c) => c.name === input.name)) {
    errors.push(`Capability '${input.name}' already exists`);
  }

  if (!VALID_CAPABILITY_TYPES.includes(input.type)) {
    errors.push(
      `Invalid capability type '${input.type}' (valid: ${VALID_CAPABILITY_TYPES.join(", ")})`,
    );
  }

  if (!VALID_CAPABILITY_CATEGORIES.includes(input.category)) {
    errors.push(
      `Invalid capability category '${input.category}' (valid: ${VALID_CAPABILITY_CATEGORIES.join(", ")})`,
    );
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ── File-write helper ───────────────────────────────────────────

function maybeWriteFile(filePath: string, content: string, dryRun: boolean): void {
  if (dryRun) return;
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(filePath, content);
}

// ── Tool registration ───────────────────────────────────────────

const generateEntityInputSchema = {
  name: z.string().describe("Entity name in snake_case (e.g. purchase_request)"),
  fields: z
    .record(
      z.string(),
      z
        .object({
          type: z.string(),
          label: z.string().optional(),
          description: z.string().optional(),
          required: z.boolean().optional(),
          unique: z.boolean().optional(),
          min: z.number().optional(),
          max: z.number().optional(),
          default: z.unknown().optional(),
          options: z.array(z.string()).optional(),
          pattern: z.string().optional(),
          format: z.string().optional(),
        })
        .passthrough(),
    )
    .describe("Map of field-name → field spec"),
  label: z.string().optional().describe("Human-readable entity label"),
  description: z.string().optional().describe("Entity description"),
  extends: z.string().optional().describe("Parent entity name to inherit from"),
  implements: z.array(z.string()).optional().describe("Entity interfaces to implement"),
  targetPath: z
    .string()
    .describe(
      "Absolute or project-relative path of the file to create, e.g. addons/cap-foo/src/entities/foo.ts",
    ),
  dryRun: z
    .boolean()
    .optional()
    .describe("When true, do not write to disk; only return generated code"),
};

const generateActionInputSchema = {
  name: z.string().describe("Action name in verb_noun snake_case"),
  entity: z.string().describe("Target entity name"),
  label: z.string().optional(),
  description: z.string().optional(),
  input: z.record(z.string(), z.object({ type: z.string() }).passthrough()).optional(),
  output: z.record(z.string(), z.object({ type: z.string() }).passthrough()).optional(),
  policy: z.record(z.string(), z.unknown()).optional(),
  handlerStub: z.string().optional().describe("Optional handler body source string"),
  targetPath: z.string().describe("Path to create, e.g. addons/cap-foo/src/actions/submit-foo.ts"),
  dryRun: z.boolean().optional(),
};

const generateCapabilityInputSchema = {
  name: z.string().describe("Capability name (e.g. cap-inventory)"),
  type: z.string().describe("Capability type: standard | adapter | bridge"),
  category: z.string().describe("Capability category"),
  label: z.string().optional(),
  description: z.string().optional(),
  rootPath: z.string().describe("Absolute or project-relative root directory for the capability"),
  scaffoldFolders: z
    .boolean()
    .optional()
    .describe("When true, create empty entities/actions/rules/views sub-folders"),
  dryRun: z.boolean().optional(),
};

/** Register all generation tools on the MCP server. */
export function registerGenerationTools(
  server: McpServer,
  defs: CollectedDefinitions,
  capabilities: CapabilityDefinition[],
  projectRoot: string,
): void {
  // ── linchkit_generate_entity ────────────────────────────────
  server.registerTool(
    "linchkit_generate_entity",
    {
      description:
        "Generate a defineEntity() source file. Validates against existing catalog (no name collision, valid extends target). Set dryRun=true to return code without writing.",
      inputSchema: generateEntityInputSchema,
    },
    // biome-ignore lint/suspicious/noTsIgnore: TS2589 inconsistent across TS versions (MCP SDK #985)
    // @ts-ignore — TS2589 deep type recursion
    async (args: {
      name: string;
      fields: Record<string, FieldSpec>;
      label?: string;
      description?: string;
      extends?: string;
      implements?: string[];
      targetPath: string;
      dryRun?: boolean;
    }) => {
      const validation = validateEntityInput(
        {
          name: args.name,
          fields: args.fields,
          label: args.label,
          description: args.description,
          extends: args.extends,
          implements: args.implements,
        },
        defs,
      );

      if (!validation.valid) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: "Validation failed", validation }, null, 2),
            },
          ],
          isError: true,
        };
      }

      const code = buildEntitySource({
        name: args.name,
        fields: args.fields,
        label: args.label,
        description: args.description,
        extends: args.extends,
        implements: args.implements,
      });

      const absPath = resolve(projectRoot, args.targetPath);
      maybeWriteFile(absPath, code, args.dryRun ?? false);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { path: absPath, code, validation, written: !(args.dryRun ?? false) },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // ── linchkit_generate_action ────────────────────────────────
  server.registerTool(
    "linchkit_generate_action",
    {
      description:
        "Generate a defineAction() source file. Validates verb_noun naming and entity reference. Set dryRun=true to return code without writing.",
      inputSchema: generateActionInputSchema,
    },
    // biome-ignore lint/suspicious/noTsIgnore: TS2589 inconsistent across TS versions (MCP SDK #985)
    // @ts-ignore — TS2589 deep type recursion
    async (args: {
      name: string;
      entity: string;
      label?: string;
      description?: string;
      input?: Record<string, FieldSpec>;
      output?: Record<string, FieldSpec>;
      policy?: Record<string, unknown>;
      handlerStub?: string;
      targetPath: string;
      dryRun?: boolean;
    }) => {
      const validation = validateActionInput(
        {
          name: args.name,
          entity: args.entity,
          label: args.label,
          description: args.description,
          input: args.input,
          output: args.output,
          policy: args.policy,
          handlerStub: args.handlerStub,
        },
        defs,
      );

      if (!validation.valid) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: "Validation failed", validation }, null, 2),
            },
          ],
          isError: true,
        };
      }

      const code = buildActionSource({
        name: args.name,
        entity: args.entity,
        label: args.label,
        description: args.description,
        input: args.input,
        output: args.output,
        policy: args.policy,
        handlerStub: args.handlerStub,
      });

      const absPath = resolve(projectRoot, args.targetPath);
      maybeWriteFile(absPath, code, args.dryRun ?? false);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { path: absPath, code, validation, written: !(args.dryRun ?? false) },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // ── linchkit_generate_capability ────────────────────────────
  server.registerTool(
    "linchkit_generate_capability",
    {
      description:
        "Scaffold a full capability skeleton: package.json, src/index.ts with defineCapability(), and optional entities/actions/rules/views sub-folders. Set dryRun=true to return file list without writing.",
      inputSchema: generateCapabilityInputSchema,
    },
    // biome-ignore lint/suspicious/noTsIgnore: TS2589 inconsistent across TS versions (MCP SDK #985)
    // @ts-ignore — TS2589 deep type recursion
    async (args: {
      name: string;
      type: string;
      category: string;
      label?: string;
      description?: string;
      rootPath: string;
      scaffoldFolders?: boolean;
      dryRun?: boolean;
    }) => {
      const validation = validateCapabilityInput(
        {
          name: args.name,
          type: args.type,
          category: args.category,
          label: args.label,
          description: args.description,
          scaffoldFolders: args.scaffoldFolders,
        },
        capabilities,
      );

      if (!validation.valid) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: "Validation failed", validation }, null, 2),
            },
          ],
          isError: true,
        };
      }

      const absRoot = resolve(projectRoot, args.rootPath);
      const dryRun = args.dryRun ?? false;

      const indexCode = buildCapabilitySource({
        name: args.name,
        type: args.type,
        category: args.category,
        label: args.label,
        description: args.description,
      });
      const pkgJson = buildCapabilityPackageJson({
        name: args.name,
        type: args.type,
        category: args.category,
      });

      const files: { path: string; content: string }[] = [
        { path: resolve(absRoot, "package.json"), content: pkgJson },
        { path: resolve(absRoot, "src/index.ts"), content: indexCode },
      ];

      if (args.scaffoldFolders ?? true) {
        files.push(
          {
            path: resolve(absRoot, "src/entities/.gitkeep"),
            content: "",
          },
          {
            path: resolve(absRoot, "src/actions/.gitkeep"),
            content: "",
          },
          {
            path: resolve(absRoot, "src/rules/.gitkeep"),
            content: "",
          },
          {
            path: resolve(absRoot, "src/views/.gitkeep"),
            content: "",
          },
        );
      }

      if (!dryRun) {
        for (const f of files) {
          maybeWriteFile(f.path, f.content, false);
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { rootPath: absRoot, files, validation, written: !dryRun },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
