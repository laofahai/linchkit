/**
 * Dynamic system prompt builder for the AI Assistant chat endpoint.
 *
 * Builds context-aware system prompts by combining:
 * 1. Base assistant personality/instructions
 * 2. Schema context from OntologyRegistry (current schema, fields, actions)
 * 3. Current record context (when viewing a specific record)
 * 4. Available entities overview
 */

import type { AIAssistantConfig, EntityRegistry, OntologyRegistry } from "@linchkit/core";

export interface SystemPromptContext {
  /** Current entity name the user is viewing */
  entity?: string;
  /** Current record ID the user is viewing */
  recordId?: string;
  /** Current record data (if available) */
  recordData?: Record<string, unknown>;
  /** User locale (e.g. "zh-CN", "en") for language-aware responses */
  locale?: string;
}

/**
 * Map a locale string to a language instruction for AI system prompts.
 * Returns undefined if locale maps to the default (English).
 */
export function getLanguageInstruction(locale: string): string | undefined {
  const lang = locale.toLowerCase();
  if (lang.startsWith("zh")) {
    return "You MUST respond in Chinese (简体中文). All field labels, descriptions, suggestions, explanations, and reasoning should be in Chinese.";
  }
  if (lang.startsWith("ja")) {
    return "You MUST respond in Japanese (日本語). All field labels, descriptions, suggestions, explanations, and reasoning should be in Japanese.";
  }
  if (lang.startsWith("ko")) {
    return "You MUST respond in Korean (한국어). All field labels, descriptions, suggestions, explanations, and reasoning should be in Korean.";
  }
  if (lang.startsWith("en")) {
    return undefined; // English is the default
  }
  // For other locales, provide a generic instruction
  return `You MUST respond in the language identified by locale "${locale}". All field labels, descriptions, suggestions, explanations, and reasoning should be in that language.`;
}

/**
 * Extract locale from request: prefer body.locale, fall back to Accept-Language header.
 */
export function extractLocale(
  bodyLocale: string | undefined,
  request?: Request,
): string | undefined {
  if (bodyLocale) return bodyLocale;
  if (!request) return undefined;
  const acceptLang = request.headers.get("Accept-Language");
  if (!acceptLang) return undefined;
  // Parse first language tag (e.g. "zh-CN,zh;q=0.9,en;q=0.8" → "zh-CN")
  const first = acceptLang.split(",")[0]?.trim().split(";")[0]?.trim();
  return first || undefined;
}

const DEFAULT_SYSTEM_PROMPT = `You are LinchKit AI Assistant, an intelligent business operations helper.
You help users understand their data, navigate the system, query records, and prepare business actions for confirmation.
Be concise, helpful, and action-oriented. When users ask about data, use the available tools to query and analyze it.
When users want to perform write actions, explain what will happen and wait for explicit user confirmation before execution.
Always respond in the same language the user writes in.`;

/**
 * Build a dynamic system prompt based on assistant config and runtime context.
 */
export function buildSystemPrompt(options: {
  assistantConfig?: AIAssistantConfig;
  ontologyRegistry?: OntologyRegistry;
  entityRegistry?: EntityRegistry;
  context?: SystemPromptContext;
}): string {
  const { assistantConfig, ontologyRegistry, entityRegistry, context } = options;

  const parts: string[] = [];

  // 1. Base system prompt (custom or default)
  parts.push(assistantConfig?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT);

  // 1b. Language instruction based on user locale
  if (context?.locale) {
    const locale = context.locale;
    const languageInstruction = getLanguageInstruction(locale);
    if (languageInstruction) {
      parts.push(`\n## Language Requirement\n${languageInstruction}`);
    }
  }

  // 2. System overview — list available entities
  if (ontologyRegistry) {
    const entityNames = ontologyRegistry.listEntities();
    if (entityNames.length > 0) {
      parts.push(
        "\n## Available Entities",
        `The system has ${entityNames.length} entity(ies): ${entityNames.join(", ")}`,
      );
    }
  }

  // 3. Current schema context — detailed info
  if (context?.entity) {
    const descriptor = ontologyRegistry?.describe(context.entity);
    if (descriptor) {
      parts.push("\n## Current Entity Context");
      parts.push(`Entity: ${descriptor.name}${descriptor.label ? ` (${descriptor.label})` : ""}`);
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
          .map((r) => `  - ${r.label ?? r.relationName}: ${r.targetEntity} (${r.cardinality})`)
          .join("\n");
        parts.push(`Relations:\n${relList}`);
      }
    } else if (entityRegistry) {
      // Fallback to EntityRegistry if OntologyRegistry is not available
      const schema = entityRegistry.get(context.entity);
      if (schema) {
        parts.push("\n## Current Entity Context");
        parts.push(`Entity: ${schema.name}${schema.label ? ` (${schema.label})` : ""}`);
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
