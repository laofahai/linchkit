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
 * Hardcoded mutation-policy suffix appended when chat tools are read-only
 * (caller passes `allowActionExecution=false`). This prevents the AI from
 * hallucinating "Created successfully!" replies for prompts that look like
 * mutations but cannot be executed from chat. See issue #285.
 *
 * Placed AFTER all other parts so user-supplied prompts (assistantConfig.systemPrompt)
 * can never accidentally override it.
 *
 * The recovery path deliberately points at the sidebar entity action button
 * only — telling the user "type the action again" loops them right back
 * into chat (the same dead-end that misrouted the prompt here in the first
 * place — codex P3 review on PR #286).
 */
const MUTATION_POLICY_SUFFIX = `## Mutation Policy (HARD CONSTRAINT — non-negotiable)
You CANNOT directly create, update, delete, or modify any data via this chat. The chat tools are read-only.
- For any user request involving writes (create / add / submit / approve / reject / delete / update / modify / change / 创建 / 添加 / 提交 / 批准 / 拒绝 / 删除 / 更新 / 修改), you MUST:
  1. NEVER claim you performed the operation. Do NOT say "created", "saved", "submitted", "done", "成功", "完成", "已创建", or any phrasing that implies the write happened.
  2. Tell the user explicitly that you cannot perform writes from chat.
  3. Direct them to the structured proposal flow via the entity list: open the entity in the sidebar and use its create / edit / action buttons. Do NOT tell them to retype the request in the chat input — that path leads back here. Localize the redirection: in Chinese, "请打开左侧边栏对应实体页面，使用页面上的『新建』、编辑或操作按钮发起结构化操作"; in English, "Please open the matching entity page from the sidebar and use its create / edit / action buttons."
- For read-only requests ("show me", "what is", "summarize", "查看", "总结") use the available query / describe / navigate tools normally.`;

/**
 * Mutation policy for the AG-UI HITL path (Spec 71): the model has an execute-less
 * `proposeMutation` tool. Unlike {@link MUTATION_POLICY_SUFFIX} — which tells the
 * model it CANNOT write and to redirect the user to the sidebar — this tells the
 * model to PROPOSE the write via the tool. The proposal surfaces an approval card;
 * nothing executes until a human approves and the action runs through CommandLayer
 * ("AI Never Modifies Production Directly"). Without this the model, told it cannot
 * write, never calls `proposeMutation` and the whole HITL path stays dead — the
 * gap a real model (not the scripted test mock) exposes.
 *
 * Appended LAST so a user-supplied prompt can never override it.
 */
const PROPOSE_POLICY_SUFFIX = `## Mutation Policy (HARD CONSTRAINT — non-negotiable)
You do NOT execute writes yourself. You have a \`proposeMutation\` tool that PROPOSES a data change for a human to approve — it does not run anything.
- For any user request involving a write (create / add / submit / approve / reject / delete / update / modify / change / 创建 / 添加 / 提交 / 批准 / 拒绝 / 删除 / 更新 / 修改), you MUST call \`proposeMutation\` with:
  - \`action\`: the business action name to run (e.g. \`create_product\`, \`approve_order\`). Pick from the entity's "Available actions" listed above; if none fits, say so instead of inventing one.
  - \`input\`: the field values for that action, extracted from the user's request.
- Calling \`proposeMutation\` surfaces an approval card; the human reviews/edits the inputs and approves, and only THEN does the action execute through the system's permission checks. You are PROPOSING, not executing.
- NEVER claim you performed the operation. Do NOT say "created", "saved", "submitted", "done", "成功", "完成", "已创建" — you only propose; the human approves and the system executes.
- For read-only requests ("show me", "what is", "summarize", "查看", "总结") use the query / describe / navigate tools normally — do NOT call \`proposeMutation\` for reads.`;

/**
 * Build a dynamic system prompt based on assistant config and runtime context.
 */
export function buildSystemPrompt(options: {
  assistantConfig?: AIAssistantConfig;
  ontologyRegistry?: OntologyRegistry;
  entityRegistry?: EntityRegistry;
  context?: SystemPromptContext;
  /**
   * Whether the chat session can execute write actions. Pass `false` to
   * append the mutation-policy suffix (see {@link MUTATION_POLICY_SUFFIX});
   * `true` or omitted leaves the prompt write-enabled — symmetric with
   * `buildTools`'s `allowActionExecution !== false` default, so the same
   * `undefined` value means "writes available" in both helpers and a
   * future caller can't accidentally pair a write-enabled tool set with
   * a refuse-to-write prompt (codex P2 review on PR #286).
   *
   * Read-only chat callers (the standard case) MUST pass `false` to both
   * `buildSystemPrompt` and `buildTools`.
   */
  allowActionExecution?: boolean;
  /**
   * Spec 71 HITL: the session exposes the execute-less `proposeMutation` tool.
   * When `true`, the prompt instructs the model to PROPOSE writes via the tool
   * (see {@link PROPOSE_POLICY_SUFFIX}) instead of the refuse-to-write
   * {@link MUTATION_POLICY_SUFFIX}. The model still never executes — proposing
   * surfaces an approval card, and a human approval runs the action through
   * CommandLayer. Takes precedence over `allowActionExecution === false`.
   */
  proposeMutation?: boolean;
}): string {
  const {
    assistantConfig,
    ontologyRegistry,
    entityRegistry,
    context,
    allowActionExecution,
    proposeMutation,
  } = options;

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

  // 5. Mutation-policy suffix — MUST be the last section so user-supplied
  //    prompts can't override it. Appended ONLY when the caller explicitly
  //    opts into read-only mode by passing `allowActionExecution=false`.
  //    Defaults are aligned with `buildTools`: undefined / true → write-
  //    enabled, no suffix. Chat callers always pass `false` here AND to
  //    `buildTools` so the two stay consistent.
  // The propose-mutation policy (Spec 71 HITL) takes precedence over the
  // refuse-to-write policy: the model has the execute-less `proposeMutation` tool
  // and must be told to USE it. It is gated on `allowActionExecution !== true`,
  // though: when the session is genuinely write-enabled (the model executes
  // directly via `executeAction`), "You do NOT execute writes yourself" would be
  // a flat contradiction — so a write-enabled session gets neither policy. The
  // HITL caller pairs `proposeMutation: true` with `allowActionExecution: false`,
  // so it always lands on the propose policy.
  if (proposeMutation && allowActionExecution !== true) {
    parts.push(`\n${PROPOSE_POLICY_SUFFIX}`);
  } else if (allowActionExecution === false) {
    parts.push(`\n${MUTATION_POLICY_SUFFIX}`);
  }

  return parts.join("\n");
}
