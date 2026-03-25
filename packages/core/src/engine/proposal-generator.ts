/**
 * AI Proposal Generator
 *
 * Takes a natural language description and uses the AIService to produce
 * a structured Proposal with schema/action/rule changes.
 *
 * M1b constraints:
 * - changeType is always "minor" (no AI-driven patch or major changes yet)
 * - Author is always { type: "ai", id: "ai-proposal-generator" }
 * - Validation is Phase 1 static checks only
 */

import { z } from "zod";
import type { SchemaRegistry } from "../schema/schema-registry";
import type { ActionDefinition } from "../types/action";
import type { AIService } from "../types/ai";
import type {
  ProposalChange,
  ProposalDefinition,
  ProposalGenerator,
  ProposalRequest,
  ProposalValidationResult,
} from "../types/proposal";
import type { FieldType, SchemaDefinition } from "../types/schema";
import type { ActionRegistry } from "./action-engine";

// ── Valid field types (for validation) ──────────────────────
// Relationship fields (ref/has_many/many_to_many) are valid virtual fields
// They declare relationships that are auto-promoted to Link definitions

const VALID_FIELD_TYPES = new Set<FieldType>([
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
  "ref",
  "has_many",
  "many_to_many",
]);

// ── ID generation helper ─────────────────────────────────

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// ── Dependencies ─────────────────────────────────────────

export interface ProposalGeneratorDeps {
  aiService: AIService;
  schemaRegistry: SchemaRegistry;
  actionRegistry: ActionRegistry;
}

// ── AI response shape (what the AI returns as structured output) ──

interface AIProposalResponse {
  title: string;
  description: string;
  capability: string;
  changes: Array<{
    type: "create" | "modify" | "delete";
    target: "schema" | "action" | "rule" | "flow" | "view";
    name: string;
    definition?: Record<string, unknown>;
    diff?: string;
  }>;
  impact: {
    schemas: string[];
    actions: string[];
    rules: string[];
    dependents: string[];
    migrationRequired: boolean;
  };
}

// ── System prompt builder ────────────────────────────────

function buildSystemPrompt(schemas: SchemaDefinition[], actions: ActionDefinition[]): string {
  const schemaList =
    schemas.length > 0
      ? schemas
          .map((s) => {
            const fields = Object.entries(s.fields)
              .map(([name, def]) => `    ${name}: ${def.type}${def.required ? " (required)" : ""}`)
              .join("\n");
            return `  ${s.name}:\n${fields}`;
          })
          .join("\n")
      : "  (none)";

  const actionList =
    actions.length > 0
      ? actions.map((a) => `  ${a.name} → schema: ${a.schema}, label: ${a.label}`).join("\n")
      : "  (none)";

  return `You are a LinchKit proposal generator. Your job is to translate natural language requests
into structured change proposals for the LinchKit meta-model system.

LinchKit has the following concepts:
- Schema: Data model definitions with typed fields
- Action: Write operations on schemas (CRUD + business logic)
- Rule: Business rules triggered by actions/events
- View: UI layout definitions
- Flow: Multi-step workflow definitions

Current registered schemas:
${schemaList}

Current registered actions:
${actionList}

Valid field types: string, text, number, boolean, date, datetime, enum, json, state, computed, ref, has_many, many_to_many

Rules for generating proposals:
1. For "create" changes, always include a complete "definition" object
2. For "modify" changes, include the full updated definition and a human-readable "diff"
3. For "delete" changes, only include the name
4. Schema definitions must have: name, fields (with type for each field)
5. Action definitions must have: name, schema, label, policy (with mode and transaction)
6. Enum fields must include an "options" array with {value, label} items
7. Relationships between schemas are defined via defineLink(), not field types
8. Always identify affected schemas, actions, rules, and dependents in impact

Respond with a JSON object matching the required structure exactly.`;
}

// ── Factory ──────────────────────────────────────────────

/**
 * Create an AI-powered ProposalGenerator.
 *
 * Uses the AIService with structured output to convert natural language
 * into well-formed ProposalDefinitions.
 */
export function createProposalGenerator(deps: ProposalGeneratorDeps): ProposalGenerator {
  const { aiService, schemaRegistry, actionRegistry } = deps;

  return {
    async generate(request: ProposalRequest): Promise<ProposalDefinition> {
      // Gather current context
      const schemas = schemaRegistry.getAll();
      const actions = actionRegistry.getAll();

      const systemPrompt = buildSystemPrompt(schemas, actions);

      // Build user message with the request
      let userMessage = request.description;
      if (request.targetCapability) {
        userMessage += `\n\nTarget capability: ${request.targetCapability}`;
      }
      if (request.context) {
        userMessage += `\n\nAdditional context: ${JSON.stringify(request.context)}`;
      }

      // Call AI with structured output
      const result = await aiService.complete({
        model: "standard",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        temperature: 0,
        responseFormat: {
          type: "json",
          schema: z.object({
            title: z.string(),
            description: z.string(),
            capability: z.string().optional(),
            changes: z.array(
              z.object({
                type: z.enum(["create", "modify", "delete"]),
                target: z.enum(["schema", "action", "rule", "flow", "view"]),
                name: z.string(),
                definition: z.record(z.string(), z.unknown()).optional(),
                diff: z.string().optional(),
              }),
            ),
            impact: z.object({
              schemas: z.array(z.string()),
              actions: z.array(z.string()),
              rules: z.array(z.string()),
              dependents: z.array(z.string()),
              migrationRequired: z.boolean(),
            }),
          }),
        },
      });

      // Parse AI response — either from structured data or raw content
      const aiResponse: AIProposalResponse = result.data
        ? (result.data as AIProposalResponse)
        : JSON.parse(result.content);

      // Map AI response target to ProposalChangeTarget (pass through as-is)
      const mapTarget = (t: string): ProposalChange["target"] => {
        return t as ProposalChange["target"];
      };

      // Map AI change type to ProposalChangeOperation
      const mapOperation = (t: string): ProposalChange["operation"] => {
        if (t === "modify") return "update";
        return t as ProposalChange["operation"];
      };

      // Build changes array
      const changes: ProposalChange[] = aiResponse.changes.map((c) => ({
        target: mapTarget(c.target),
        operation: mapOperation(c.type),
        name: c.name,
        definition: c.definition as ProposalChange["definition"],
        diff: c.diff,
      }));

      const now = new Date();

      const proposal: ProposalDefinition = {
        id: generateId(),
        title: aiResponse.title,
        description: aiResponse.description,
        author: { type: "ai", id: "ai-proposal-generator", name: "AI Proposal Generator" },
        capability: request.targetCapability ?? aiResponse.capability ?? "default",
        // M1b: always minor
        changeType: "minor",
        changes,
        impact: {
          schemasAffected: aiResponse.impact?.schemas ?? [],
          actionsAffected: aiResponse.impact?.actions ?? [],
          rulesAffected: aiResponse.impact?.rules ?? [],
          dependentsAffected: aiResponse.impact?.dependents ?? [],
          migrationRequired: aiResponse.impact?.migrationRequired ?? false,
        },
        status: "draft",
        createdAt: now,
        updatedAt: now,
      };

      return proposal;
    },

    async validate(proposal: ProposalDefinition): Promise<ProposalValidationResult> {
      const errors: string[] = [];
      const warnings: string[] = [];

      // Precompute schemas being created in this proposal
      const proposedSchemaNames = new Set(
        proposal.changes
          .filter((c) => c.target === "schema" && c.operation === "create")
          .map((c) => c.name),
      );

      for (const change of proposal.changes) {
        validateChange(
          change,
          schemaRegistry,
          actionRegistry,
          errors,
          warnings,
          proposedSchemaNames,
        );
      }

      return {
        passed: errors.length === 0,
        phases: [
          {
            phase: 1,
            status: errors.length === 0 ? "passed" : "failed",
            errors: errors.map((msg) => ({ code: "STATIC_CHECK", message: msg })),
            warnings: warnings.map((msg) => ({ code: "STATIC_WARNING", message: msg })),
            duration: 0,
          },
        ],
        impactSummary: buildImpactSummary(proposal),
      };
    },
  };
}

// ── Change validation helpers ────────────────────────────

function validateChange(
  change: ProposalChange,
  schemaRegistry: SchemaRegistry,
  actionRegistry: ActionRegistry,
  errors: string[],
  warnings: string[],
  proposedSchemaNames: Set<string>,
): void {
  switch (change.target) {
    case "schema":
      validateSchemaChange(change, schemaRegistry, errors, warnings);
      break;
    case "action":
      validateActionChange(
        change,
        schemaRegistry,
        actionRegistry,
        errors,
        warnings,
        proposedSchemaNames,
      );
      break;
    default:
      // Other targets (rule, view, state, event) get basic validation
      if (change.operation !== "delete" && !change.definition) {
        errors.push(
          `${change.target} change "${change.name}": definition is required for ${change.operation}`,
        );
      }
      break;
  }
}

function validateSchemaChange(
  change: ProposalChange,
  schemaRegistry: SchemaRegistry,
  errors: string[],
  warnings: string[],
): void {
  if (change.operation === "delete") {
    if (!schemaRegistry.has(change.name)) {
      warnings.push(`Schema "${change.name}" does not exist (delete is a no-op)`);
    }
    return;
  }

  if (!change.definition) {
    errors.push(`Schema change "${change.name}": definition is required for ${change.operation}`);
    return;
  }

  const def = change.definition as SchemaDefinition;

  // Check name matches
  if (def.name && def.name !== change.name) {
    errors.push(
      `Schema change "${change.name}": definition.name "${def.name}" does not match change.name`,
    );
  }

  // Check fields exist
  if (!def.fields || Object.keys(def.fields).length === 0) {
    errors.push(`Schema "${change.name}": must have at least one field`);
    return;
  }

  // Validate each field
  for (const [fieldName, fieldDef] of Object.entries(def.fields)) {
    if (!VALID_FIELD_TYPES.has(fieldDef.type)) {
      errors.push(`Schema "${change.name}" field "${fieldName}": invalid type "${fieldDef.type}"`);
    }

    // Enum fields must have options
    if (fieldDef.type === "enum" && !("options" in fieldDef && Array.isArray(fieldDef.options))) {
      errors.push(
        `Schema "${change.name}" field "${fieldName}": enum field must have options array`,
      );
    }
  }

  // Check for duplicate field names with existing schemas (for create)
  if (change.operation === "create" && schemaRegistry.has(change.name)) {
    errors.push(`Schema "${change.name}" already exists (use "update" operation instead)`);
  }

  // Check for update on non-existent schema
  if (change.operation === "update" && !schemaRegistry.has(change.name)) {
    warnings.push(`Schema "${change.name}" does not exist yet (will be treated as create)`);
  }
}

function validateActionChange(
  change: ProposalChange,
  schemaRegistry: SchemaRegistry,
  _actionRegistry: ActionRegistry,
  errors: string[],
  _warnings: string[],
  proposedSchemaNames: Set<string> = new Set(),
): void {
  if (change.operation === "delete") return;

  if (!change.definition) {
    errors.push(`Action change "${change.name}": definition is required for ${change.operation}`);
    return;
  }

  const def = change.definition as ActionDefinition;

  // Action must reference a valid schema (also accept schemas being created in the same proposal)
  if (def.schema && !schemaRegistry.has(def.schema) && !proposedSchemaNames.has(def.schema)) {
    errors.push(`Action "${change.name}": references unknown schema "${def.schema}"`);
  }

  // Validate input fields if present
  if (def.input) {
    for (const [fieldName, fieldDef] of Object.entries(def.input)) {
      if (!VALID_FIELD_TYPES.has(fieldDef.type)) {
        errors.push(
          `Action "${change.name}" input "${fieldName}": invalid type "${fieldDef.type}"`,
        );
      }
    }
  }

  // Validate output fields if present
  if (def.output) {
    for (const [fieldName, fieldDef] of Object.entries(def.output)) {
      if (!VALID_FIELD_TYPES.has(fieldDef.type)) {
        errors.push(
          `Action "${change.name}" output "${fieldName}": invalid type "${fieldDef.type}"`,
        );
      }
    }
  }
}

// ── Impact summary builder ───────────────────────────────

function buildImpactSummary(proposal: ProposalDefinition): string {
  const parts: string[] = [];
  const { impact } = proposal;

  if (impact.schemasAffected.length > 0) {
    parts.push(`Schemas: ${impact.schemasAffected.join(", ")}`);
  }
  if (impact.actionsAffected.length > 0) {
    parts.push(`Actions: ${impact.actionsAffected.join(", ")}`);
  }
  if (impact.rulesAffected.length > 0) {
    parts.push(`Rules: ${impact.rulesAffected.join(", ")}`);
  }
  if (impact.migrationRequired) {
    parts.push("DB migration required");
  }

  return parts.length > 0 ? parts.join("; ") : "No significant impact";
}
