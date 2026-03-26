/**
 * Dynamic system prompt builder for the AI Assistant chat endpoint.
 *
 * Builds context-aware system prompts by combining:
 * 1. Base assistant personality/instructions
 * 2. Schema context from OntologyRegistry (current schema, fields, actions)
 * 3. Current record context (when viewing a specific record)
 * 4. Available schemas overview
 */

import type {
  AIAssistantConfig,
  OntologyRegistry,
  SchemaRegistry,
} from "@linchkit/core";

export interface SystemPromptContext {
  /** Current schema name the user is viewing */
  schema?: string;
  /** Current record ID the user is viewing */
  recordId?: string;
  /** Current record data (if available) */
  recordData?: Record<string, unknown>;
}

const DEFAULT_SYSTEM_PROMPT = `You are LinchKit AI Assistant, an intelligent business operations helper.
You help users understand their data, navigate the system, query records, and execute business actions.
Be concise, helpful, and action-oriented. When users ask about data, use the available tools to query and analyze it.
When users want to perform actions, use the executeAction tool with proper parameters.
Always respond in the same language the user writes in.`;

/**
 * Build a dynamic system prompt based on assistant config and runtime context.
 */
export function buildSystemPrompt(options: {
  assistantConfig?: AIAssistantConfig;
  ontologyRegistry?: OntologyRegistry;
  schemaRegistry?: SchemaRegistry;
  context?: SystemPromptContext;
}): string {
  const { assistantConfig, ontologyRegistry, schemaRegistry, context } = options;

  const parts: string[] = [];

  // 1. Base system prompt (custom or default)
  parts.push(assistantConfig?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT);

  // 2. System overview — list available schemas
  if (ontologyRegistry) {
    const schemaNames = ontologyRegistry.listSchemas();
    if (schemaNames.length > 0) {
      parts.push(
        "\n## Available Schemas",
        `The system has ${schemaNames.length} schema(s): ${schemaNames.join(", ")}`,
      );
    }
  }

  // 3. Current schema context — detailed info
  if (context?.schema) {
    const descriptor = ontologyRegistry?.describe(context.schema);
    if (descriptor) {
      parts.push("\n## Current Schema Context");
      parts.push(`Schema: ${descriptor.name}${descriptor.label ? ` (${descriptor.label})` : ""}`);
      if (descriptor.description) {
        parts.push(`Description: ${descriptor.description}`);
      }

      // Fields
      const fieldNames = Object.keys(descriptor.fields);
      if (fieldNames.length > 0) {
        const fieldDescriptions = fieldNames.map((name) => {
          const field = descriptor.fields[name];
          if (!field) return `  - ${name}`;
          return `  - ${name}: ${field.type}${field.label ? ` (${field.label})` : ""}${field.required ? " [required]" : ""}`;
        });
        parts.push(`Fields:\n${fieldDescriptions.join("\n")}`);
      }

      // Available actions
      if (descriptor.actions.length > 0) {
        const actionList = descriptor.actions
          .map((a) => `  - ${a.name}${a.label ? ` (${a.label})` : ""}`)
          .join("\n");
        parts.push(`Available actions:\n${actionList}`);
      }

      // State machine
      if (descriptor.states) {
        const stateNames = Object.keys(descriptor.states.states || {});
        if (stateNames.length > 0) {
          parts.push(`State machine: ${stateNames.join(" -> ")}`);
        }
      }

      // Relations
      if (descriptor.relations.length > 0) {
        const relList = descriptor.relations
          .map((r) => `  - ${r.label ?? r.linkName}: ${r.targetSchema} (${r.cardinality})`)
          .join("\n");
        parts.push(`Relations:\n${relList}`);
      }
    } else if (schemaRegistry) {
      // Fallback to SchemaRegistry if OntologyRegistry is not available
      const schema = schemaRegistry.get(context.schema);
      if (schema) {
        parts.push("\n## Current Schema Context");
        parts.push(`Schema: ${schema.name}${schema.label ? ` (${schema.label})` : ""}`);
        parts.push(`Fields: ${Object.keys(schema.fields).join(", ")}`);
      }
    }

    // 4. Current record context
    if (context.recordId) {
      parts.push(`\nCurrently viewing record ID: ${context.recordId}`);
    }
    if (context.recordData) {
      // Include a sanitized summary of the record data (limit size)
      const summary = JSON.stringify(context.recordData, null, 2);
      if (summary.length < 2000) {
        parts.push(`Current record data:\n\`\`\`json\n${summary}\n\`\`\``);
      }
    }
  }

  return parts.join("\n");
}
