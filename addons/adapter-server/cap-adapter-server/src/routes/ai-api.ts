/**
 * AI-powered REST endpoints.
 *
 * - POST /api/ai/auto-fill — AI-generated form field suggestions
 * - POST /api/ai/chat — Vercel AI SDK streamText with tools (conversation history + function calling)
 * - POST /api/ai/resolve-intent — natural language to action proposal
 * - POST /api/ai/search — natural language to DeclarativeCondition filter
 */

import type { Elysia } from "elysia";
import { extractLocale, getLanguageInstruction } from "../ai/system-prompt";
import type { ServerOptions } from "../server";

// ── Analysis cache (in-memory, 15 min TTL) ──────────────────
const ANALYSIS_CACHE_TTL = 15 * 60 * 1000;
const analysisCache = new Map<
  string,
  { result: import("@linchkit/core/ai").RecordAnalysis; timestamp: number }
>();

/**
 * Validate an AI-generated filter: only allow fields that exist in the schema.
 * Recursively walks composite conditions (and/or/not) and strips invalid or sensitive fields.
 * Returns null if the filter is completely invalid after stripping.
 */
function validateAIFilter(
  filter: unknown,
  allowedFields: Set<string>,
  sensitiveFields: Set<string>,
): unknown {
  if (!filter || typeof filter !== "object") return null;

  const f = filter as Record<string, unknown>;
  const operator = f.operator as string | undefined;

  // Composite: and / or
  if (operator === "and" || operator === "or") {
    const conditions = f.conditions;
    if (!Array.isArray(conditions)) return null;
    const validated = conditions
      .map((c) => validateAIFilter(c, allowedFields, sensitiveFields))
      .filter((c) => c !== null);
    if (validated.length === 0) return null;
    if (validated.length === 1) return validated[0];
    return { ...f, conditions: validated };
  }

  // Not
  if (operator === "not") {
    const inner = validateAIFilter(f.condition, allowedFields, sensitiveFields);
    if (!inner) return null;
    return { ...f, condition: inner };
  }

  // Simple condition — validate field name
  const field = f.field as string | undefined;
  if (!field) return null;
  if (sensitiveFields.has(field)) return null;
  if (!allowedFields.has(field)) return null;

  return f;
}

export function mountAIRoutes(app: Elysia, options: ServerOptions): void {
  const aiService = options.aiService;
  const entityRegistry = options.entityRegistry;
  const executor = options.executor;

  app
    // ── AI Auto-Fill endpoint ────────────────────────────
    .post("/api/ai/auto-fill", async ({ body, set, request }) => {
      const {
        schema: entityName,
        fields,
        currentValues,
        locale: bodyLocale,
      } = (body ?? {}) as {
        schema?: string;
        fields?: Record<
          string,
          {
            label?: string;
            type?: string;
            required?: boolean;
            options?: string[];
            description?: string;
          }
        >;
        currentValues?: Record<string, unknown>;
        locale?: string;
      };

      // Always validate required fields first, before checking AI availability
      if (!entityName || !fields) {
        set.status = 400;
        return {
          success: false,
          error: { message: "Missing 'schema' or 'fields' in request body." },
        };
      }

      // Identify empty fields that need suggestions
      const emptyFieldNames = Object.keys(fields).filter((name) => {
        const val = currentValues?.[name];
        return val === null || val === undefined || val === "";
      });

      if (emptyFieldNames.length === 0) {
        return { success: true, data: { suggestions: {} } };
      }

      // ── Step 1: Gather data context from recent records ──
      const dataProvider = options.dataProvider;
      const schemaDef = entityRegistry?.get(entityName);

      let recentRecords: Array<Record<string, unknown>> = [];
      if (dataProvider) {
        try {
          recentRecords = await dataProvider.query(entityName, {
            sortField: "created_at",
            sortOrder: "desc",
            limit: 10,
          });
        } catch {
          // Data provider may not have this schema table yet — ignore
        }
      }

      // Build per-field statistics from recent records
      const fieldStats: Record<
        string,
        {
          mostCommon?: { value: unknown; count: number; total: number };
          recentValues: unknown[];
          uniqueValues: unknown[];
        }
      > = {};

      for (const fieldName of emptyFieldNames) {
        const values = recentRecords
          .map((r) => r[fieldName])
          .filter((v) => v !== null && v !== undefined && v !== "");

        if (values.length === 0) {
          fieldStats[fieldName] = { recentValues: [], uniqueValues: [] };
          continue;
        }

        // Count value frequencies
        const freq = new Map<string, { value: unknown; count: number }>();
        for (const v of values) {
          const key = JSON.stringify(v);
          const existing = freq.get(key);
          if (existing) {
            existing.count++;
          } else {
            freq.set(key, { value: v, count: 1 });
          }
        }

        // Find most common value
        let mostCommon: { value: unknown; count: number; total: number } | undefined;
        for (const entry of freq.values()) {
          if (!mostCommon || entry.count > mostCommon.count) {
            mostCommon = { value: entry.value, count: entry.count, total: values.length };
          }
        }

        const uniqueValues = [...freq.values()]
          .sort((a, b) => b.count - a.count)
          .slice(0, 10)
          .map((e) => e.value);

        fieldStats[fieldName] = { mostCommon, recentValues: values.slice(0, 5), uniqueValues };
      }

      // ── Step 2: Resolve related record context ──────────
      const relatedContext: Record<string, Record<string, unknown>> = {};
      if (dataProvider && schemaDef && currentValues) {
        for (const [fieldName, value] of Object.entries(currentValues)) {
          if (!value || value === "") continue;
          const _fieldDef = schemaDef.fields[fieldName];
          // Relation context is now resolved via RelationRegistry, not ref fields.
          // FK string fields (e.g. department_id) hold the foreign key value.
        }
      }

      // ── Step 3: Enrich field definitions with server-side knowledge ──
      const enrichedFields: Record<
        string,
        {
          label?: string;
          type?: string;
          required?: boolean;
          options?: string[];
          description?: string;
          constraints?: Record<string, unknown>;
          stats?: (typeof fieldStats)[string];
        }
      > = {};

      for (const [name, clientDef] of Object.entries(fields)) {
        const serverField = schemaDef?.fields[name];
        const merged: (typeof enrichedFields)[string] = { ...clientDef };

        if (serverField) {
          if (!merged.label && serverField.label) merged.label = serverField.label;
          if (!merged.description && serverField.description)
            merged.description = serverField.description;
          if (!merged.type) merged.type = serverField.type;
          if (serverField.required) merged.required = true;

          // Extract enum options from server definition
          if (serverField.type === "enum" && "options" in serverField && !merged.options?.length) {
            merged.options = (
              serverField as { options: Array<{ value: string; label?: string }> }
            ).options.map((o) => (o.label ? `${o.value} (${o.label})` : o.value));
          }

          // Extract state machine options
          if (serverField.type === "state" && "machine" in serverField && options.states) {
            const stateDef = options.states.find(
              (s) => s.name === (serverField as { machine: string }).machine,
            );
            if (stateDef && !merged.options?.length) {
              merged.options = stateDef.states;
            }
          }

          // Gather numeric/format constraints
          const constraints: Record<string, unknown> = {};
          if (serverField.min !== undefined) constraints.min = serverField.min;
          if (serverField.max !== undefined) constraints.max = serverField.max;
          if ("format" in serverField && serverField.format)
            constraints.format = serverField.format;
          if ("pattern" in serverField && serverField.pattern)
            constraints.pattern = serverField.pattern;
          if (serverField.default !== undefined) constraints.default = serverField.default;
          if (Object.keys(constraints).length > 0) merged.constraints = constraints;
        }

        if (fieldStats[name]) merged.stats = fieldStats[name];
        enrichedFields[name] = merged;
      }

      // ── Step 4: No AI service — statistical fallback ───
      if (!aiService?.configured) {
        const suggestions: Record<string, { value: unknown; confidence: number; reason: string }> =
          {};

        for (const fieldName of emptyFieldNames) {
          const stats = fieldStats[fieldName];
          if (stats?.mostCommon) {
            const { value, count, total } = stats.mostCommon;
            const frequency = count / total;
            // Only suggest if value appears in >30% of recent records
            if (frequency >= 0.3) {
              suggestions[fieldName] = {
                value,
                confidence: Math.round(frequency * 100) / 100,
                reason: `Most common value in recent records (${count}/${total})`,
              };
              continue;
            }
          }
          // Fall back to schema default if available
          const fieldDef = schemaDef?.fields[fieldName];
          if (fieldDef?.default !== undefined) {
            suggestions[fieldName] = {
              value: fieldDef.default,
              confidence: 0.9,
              reason: "Schema default value",
            };
          }
        }

        return { success: true, data: { suggestions } };
      }

      // ── Step 5: Build data-informed AI prompt ──────────
      try {
        const fieldDescriptions = Object.entries(enrichedFields)
          .filter(([name]) => emptyFieldNames.includes(name))
          .map(([name, def]) => {
            const parts = [`- ${name}`];
            if (def.label) parts.push(`(label: "${def.label}")`);
            if (def.type) parts.push(`[type: ${def.type}]`);
            if (def.required) parts.push("(REQUIRED)");
            if (def.options?.length) parts.push(`MUST be one of: [${def.options.join(", ")}]`);
            if (def.description) parts.push(`— ${def.description}`);
            if (def.constraints) {
              const c = def.constraints;
              if (c.min !== undefined) parts.push(`min: ${c.min}`);
              if (c.max !== undefined) parts.push(`max: ${c.max}`);
              if (c.format) parts.push(`format: ${c.format}`);
              if (c.pattern) parts.push(`pattern: ${c.pattern}`);
            }
            if (def.stats?.mostCommon) {
              const mc = def.stats.mostCommon;
              parts.push(
                `(most common: ${JSON.stringify(mc.value)}, freq: ${mc.count}/${mc.total})`,
              );
            }
            if (def.stats && def.stats.uniqueValues.length > 0) {
              parts.push(
                `recent values: [${def.stats.uniqueValues.map((v) => JSON.stringify(v)).join(", ")}]`,
              );
            }
            return parts.join(" ");
          })
          .join("\n");

        // Build already-filled context with related record enrichment
        const filledFields = currentValues
          ? Object.entries(currentValues)
              .filter(([, v]) => v !== null && v !== undefined && v !== "")
              .map(([k, v]) => {
                const label = enrichedFields[k]?.label ?? k;
                let line = `- ${k} (${label}): ${JSON.stringify(v)}`;
                if (relatedContext[k]) {
                  const related = relatedContext[k];
                  const summary = Object.entries(related)
                    .filter(([rk]) => !rk.startsWith("_") && rk !== "id" && rk !== "tenant_id")
                    .slice(0, 5)
                    .map(([rk, rv]) => `${rk}=${JSON.stringify(rv)}`)
                    .join(", ");
                  if (summary) line += ` → related: {${summary}}`;
                }
                return line;
              })
              .join("\n")
          : "None";

        let schemaContext = "";
        if (schemaDef) {
          schemaContext = `\nSchema: "${schemaDef.name}"`;
          if (schemaDef.label) schemaContext += ` (${schemaDef.label})`;
          if (schemaDef.description) schemaContext += `\nDescription: ${schemaDef.description}`;
        }

        const locale = extractLocale(bodyLocale, request);
        const langInstruction = locale ? getLanguageInstruction(locale) : undefined;

        const hasData = recentRecords.length > 0;

        const prompt = `You are a form auto-fill assistant for a "${entityName}" record.${schemaContext}
${langInstruction ? `\n${langInstruction}\n` : ""}
${hasData ? `There are ${recentRecords.length} recent records providing data context.` : "This is a NEW system with NO existing data. Only suggest values when field constraints make the answer obvious (e.g., enum default, schema default). Otherwise, do NOT suggest — return an empty object rather than guessing."}

Fields that need suggestions (with data context):
${fieldDescriptions}

Already filled by user:
${filledFields}

RULES:
- For enum/state fields, ONLY use values from the provided options list. Never invent options.
- For number fields, stay within min/max constraints if provided.
- For string fields with format constraints (email, url, phone), match that format.
- Use "most common" and "recent values" data to prefer values matching existing patterns.
- Use related record data to infer contextually appropriate values.
- Set confidence based on data support:
  - 0.9+: clear default or dominant pattern (>70% frequency)
  - 0.7-0.9: strong data pattern (>40% frequency) or logically inferred from filled fields
  - 0.4-0.7: reasonable guess from partial patterns
  - Below 0.4: do NOT suggest — omit the field
- ${hasData ? "" : "With no existing data, be extremely conservative. Only suggest for fields with obvious defaults."}

Respond with JSON: { "<field>": { "value": <val>, "confidence": <0-1>, "reason": "<why>"${langInstruction ? " (in user's language)" : ""} }, ... }
Only include fields where you have genuine confidence. Omit fields where you would be guessing.`;

        const result = await aiService.complete({
          model: "fast",
          messages: [
            {
              role: "system",
              content:
                "You are a data-aware form assistant. You suggest values based on real data patterns, field constraints, and contextual clues. Never guess randomly. Always respond with valid JSON only, no markdown formatting.",
            },
            { role: "user", content: prompt },
          ],
          temperature: 0.1,
          maxTokens: 2000,
          timeout: 30000,
        });

        // Parse AI response
        let suggestions: Record<string, { value: unknown; confidence: number; reason?: string }> =
          {};
        try {
          let content = result.content.trim();
          if (content.startsWith("```")) {
            content = content.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
          }
          suggestions = JSON.parse(content);
        } catch {
          // AI response was not valid JSON — return empty suggestions gracefully
          return { success: true, data: { suggestions: {} } };
        }

        // Post-process: validate suggestions against field constraints
        const validated: Record<string, { value: unknown; confidence: number; reason?: string }> =
          {};
        for (const [fieldName, suggestion] of Object.entries(suggestions)) {
          if (!emptyFieldNames.includes(fieldName)) continue;
          if (typeof suggestion?.confidence !== "number" || suggestion.confidence < 0.4) continue;

          const fieldDef = enrichedFields[fieldName];
          if (!fieldDef) continue;

          // Validate enum/state values against known options
          if (fieldDef.options?.length) {
            const optionValues = fieldDef.options.map((o) => {
              const match = o.match(/^([^ (]+)/);
              return match ? match[1] : o;
            });
            if (!optionValues.includes(String(suggestion.value))) continue;
          }

          // Validate number constraints
          if (fieldDef.type === "number" && typeof suggestion.value === "number") {
            if (
              fieldDef.constraints?.min !== undefined &&
              suggestion.value < (fieldDef.constraints.min as number)
            )
              continue;
            if (
              fieldDef.constraints?.max !== undefined &&
              suggestion.value > (fieldDef.constraints.max as number)
            )
              continue;
          }

          validated[fieldName] = suggestion;
        }

        return { success: true, data: { suggestions: validated } };
      } catch (err) {
        const message =
          process.env.NODE_ENV === "production"
            ? "AI auto-fill failed."
            : err instanceof Error
              ? err.message
              : String(err);
        set.status = 500;
        return { success: false, error: { message } };
      }
    })
    // ── AI Chat endpoint (Vercel AI SDK streamText with tools) ──────────────────
    .post("/api/ai/chat", async ({ body, set, request }) => {
      // biome-ignore lint/suspicious/noExplicitAny: request body shape from AI SDK useChat client
      const { messages, context } = (body ?? {}) as any;

      if (!messages || !Array.isArray(messages) || messages.length === 0) {
        set.status = 400;
        return { success: false, error: { message: "messages array is required" } };
      }

      const aiConfig = options.aiConfig;

      if (!aiService?.configured || !aiConfig) {
        set.status = 503;
        return {
          success: false,
          error: {
            message:
              "AI service is not configured. Configure an AI provider in linchkit.config.ts to enable the assistant.",
          },
        };
      }

      try {
        const { streamText, stepCountIs, convertToModelMessages } = await import("ai");
        const { resolveLanguageModel } = await import("@linchkit/cap-ai-provider");
        const { createTenantAwareDataProvider } = await import("@linchkit/core/server");
        const { buildSystemPrompt } = await import("../ai/system-prompt");
        const { buildTools } = await import("../ai/tools");
        const { ANONYMOUS_ACTOR: anonActor } = await import("./shared");

        const assistantConfig = aiConfig.assistant;

        // Resolve the language model from config
        const model = await resolveLanguageModel(aiConfig, assistantConfig?.model ?? "fast");

        // Resolve actor for permission-aware tool calls
        const resolveRequestActor = options.resolveRequestActor;
        const resolveRequestTenantId = options.resolveRequestTenantId;

        const actor = resolveRequestActor
          ? ((await resolveRequestActor(request)) ?? anonActor)
          : anonActor;

        // Resolve tenant-scoped data provider
        const tenantId = resolveRequestTenantId
          ? await resolveRequestTenantId(request, actor)
          : undefined;
        const dataProvider = options.dataProvider;
        const scopedProvider =
          tenantId && dataProvider
            ? createTenantAwareDataProvider(dataProvider, tenantId)
            : dataProvider;

        // Resolve locale from request body or Accept-Language header
        const locale = extractLocale(context?.locale, request);

        // Build dynamic system prompt with schema context from OntologyRegistry
        const systemPrompt = buildSystemPrompt({
          assistantConfig,
          ontologyRegistry: options.ontologyRegistry,
          entityRegistry,
          context: {
            entity: context?.entity ?? context?.schema,
            recordId: context?.recordId,
            recordData: context?.recordData,
            locale,
          },
        });

        // Build context-aware tools (query, execute, describe, navigate)
        const tools = buildTools({
          dataProvider: scopedProvider,
          commandLayer: options.commandLayer,
          entityRegistry,
          ontologyRegistry: options.ontologyRegistry,
          actor,
        });

        // Convert UIMessage[] (from @ai-sdk/react useChat) to ModelMessage[] (for streamText)
        // useChat sends messages in UI format (with parts array), but streamText expects model format
        const modelMessages = await convertToModelMessages(messages, { tools });

        // Use Vercel AI SDK streamText with tools and multi-step support
        const result = streamText({
          model,
          system: systemPrompt,
          messages: modelMessages,
          tools,
          stopWhen: stepCountIs(assistantConfig?.maxSteps ?? 5),
          temperature: assistantConfig?.temperature ?? 0.3,
          abortSignal: request.signal,
        });

        // Return standard Vercel AI SDK UI message stream response
        // Compatible with @ai-sdk/react useChat hook
        return result.toUIMessageStreamResponse();
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : "AI chat failed";
        set.status = 500;
        return {
          success: false,
          error: { message: errorMessage },
        };
      }
    })
    // ── AI Intent Resolution endpoint — natural language to action proposal ──
    .post("/api/ai/resolve-intent", async ({ body, set, request }) => {
      const {
        message,
        context,
        locale: bodyLocale,
      } = (body ?? {}) as {
        message?: string;
        context?: { entity?: string; schema?: string; recordId?: string };
        locale?: string;
      };

      if (!message || typeof message !== "string") {
        set.status = 400;
        return { success: false, error: { message: "message is required" } };
      }

      if (!aiService?.configured) {
        return { success: true, data: null };
      }

      // Collect available actions from executor registry
      const actionRegistry = executor?.registry;
      if (!actionRegistry) {
        return { success: true, data: null };
      }

      const ontologyRegistry = options.ontologyRegistry;

      // Build set of AI-disabled schema names (ai.actionable === false)
      const aiDisabledSchemas = new Set<string>();
      if (entityRegistry) {
        for (const schema of entityRegistry.getAll()) {
          if (schema.ai?.actionable === false) {
            aiDisabledSchemas.add(schema.name);
          }
        }
      }

      // Build action catalog for the AI prompt — filter out AI-restricted schemas
      const allActions = actionRegistry.getAll().filter((a) => !aiDisabledSchemas.has(a.entity));
      const actionCatalog = allActions.map((a) => {
        const inputFields = a.input
          ? Object.entries(a.input).map(([name, field]) => ({
              name,
              type: field.type,
              label: field.label,
              required: field.required ?? false,
              options: (
                field as { options?: Array<{ value: string; label?: string }> }
              ).options?.map((o) => o.value),
              description: field.description,
            }))
          : [];
        return {
          name: a.name,
          entity: a.entity,
          label: a.label,
          description: a.description,
          promptHints: a.ai?.promptHints,
          inputFields,
        };
      });

      // Build schema overview from OntologyRegistry for richer context
      let schemaOverview = "";
      if (ontologyRegistry) {
        const entityNames = ontologyRegistry
          .listEntities()
          .filter((n) => !aiDisabledSchemas.has(n));
        const schemaLines = entityNames.map((n) => {
          const desc = ontologyRegistry.describe(n);
          if (!desc) return `- ${n}`;
          return `- ${n}${desc.label ? ` (${desc.label})` : ""}${desc.description ? `: ${desc.description}` : ""}`;
        });
        if (schemaLines.length > 0) {
          schemaOverview = `\nAvailable schemas:\n${schemaLines.join("\n")}`;
        }
      }

      // Build current page context
      let schemaContext = "";
      const contextEntity = context?.entity ?? context?.schema;
      if (contextEntity && entityRegistry) {
        const schema = entityRegistry.get(contextEntity);
        if (schema) {
          schemaContext = `\nCurrent schema context: ${schema.name}`;
          if (schema.label) schemaContext += ` (${schema.label})`;
          schemaContext += `\nFields: ${Object.entries(schema.fields)
            .map(([k, v]) => `${k}(${v.type}${v.label ? `, label: ${v.label}` : ""})`)
            .join(", ")}`;
          if (context?.recordId) schemaContext += `\nViewing record ID: ${context.recordId}`;
        }
      }

      const locale = extractLocale(bodyLocale, request);
      const langInstruction = locale ? getLanguageInstruction(locale) : undefined;

      const systemPrompt = `You are LinchKit AI Intent Resolver. Given a user's natural language request, determine which action to execute and extract the input parameters.
${langInstruction ? `\n${langInstruction}\n` : ""}${schemaOverview}

Available actions:
${JSON.stringify(actionCatalog, null, 2)}
${schemaContext}

Respond with a JSON object (and nothing else) in this exact format:
{
  "action": "action_name or null if no match",
  "schema": "entity_name or null",
  "input": { "field_name": "extracted_value" },
  "missingFields": ["field names that are required but not extracted"],
  "confidence": 0.0 to 1.0,
  "explanation": "Human-readable explanation of what will happen",
  "alternatives": [{ "action": "alt_action_name", "confidence": 0.0, "explanation": "..." }]
}

Rules:
- Only match actions from the available list above.
- Extract parameter values from the user message. Convert types appropriately (strings to numbers, etc.).
- The user may write in any language (including Chinese like "创建采购请求"). Match intent regardless of input language.
- If you cannot determine a good match, set action to null and confidence to 0.
- If some required fields are missing from the user message, list them in missingFields.
- If confidence < 0.7, include up to 3 alternative interpretations in "alternatives".
- The explanation should be concise, user-friendly${langInstruction ? ", and written in the user's language" : ""}.`;

      try {
        const result = await aiService.complete({
          model: "fast",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: message },
          ],
          temperature: 0.1,
          maxTokens: 1024,
          timeout: 30_000,
        });

        // Parse the JSON response
        let parsed: {
          action: string | null;
          schema: string | null;
          input: Record<string, unknown>;
          missingFields?: string[];
          confidence: number;
          explanation: string;
          alternatives?: Array<{ action: string; confidence: number; explanation: string }>;
        };
        try {
          // Strip markdown code fences if present
          const cleaned = result.content
            .replace(/```json\n?/g, "")
            .replace(/```\n?/g, "")
            .trim();
          parsed = JSON.parse(cleaned);
        } catch {
          // AI didn't return valid JSON — no intent resolved
          return { success: true, data: null };
        }

        if (!parsed.action || parsed.confidence < 0.3) {
          return { success: true, data: null };
        }

        // Verify the action actually exists and is not AI-restricted
        const matchedAction = actionRegistry.get(parsed.action);
        if (!matchedAction || aiDisabledSchemas.has(matchedAction.entity)) {
          return { success: true, data: null };
        }

        return {
          success: true,
          data: {
            action: parsed.action,
            schema: parsed.schema ?? matchedAction.entity,
            input: parsed.input ?? {},
            missingFields: parsed.missingFields ?? [],
            confidence: parsed.confidence,
            explanation: parsed.explanation,
            ...(parsed.confidence < 0.7 && parsed.alternatives?.length
              ? { alternatives: parsed.alternatives }
              : {}),
            actionLabel: matchedAction.label,
            actionDescription: matchedAction.description,
            inputSchema: matchedAction.input
              ? Object.fromEntries(
                  Object.entries(matchedAction.input).map(([k, v]) => [
                    k,
                    {
                      type: v.type,
                      label: v.label,
                      required: v.required ?? false,
                      options: (v as { options?: Array<{ value: string; label?: string }> })
                        .options,
                      description: v.description,
                    },
                  ]),
                )
              : {},
          },
        };
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : "AI request failed";
        set.status = 500;
        return { success: false, error: { message: errorMessage } };
      }
    })
    // ── AI Execute-Intent endpoint — execute a confirmed AI-proposed action ──
    .post("/api/ai/execute-intent", async ({ body, set, request }) => {
      const {
        action: actionName,
        input,
        source,
      } = (body ?? {}) as {
        action?: string;
        input?: Record<string, unknown>;
        source?: string;
      };

      if (!actionName || typeof actionName !== "string") {
        set.status = 400;
        return { success: false, error: { message: "action is required" } };
      }

      if (!executor && !options.commandLayer) {
        set.status = 500;
        return { success: false, error: { message: "Action executor not configured." } };
      }

      const { resolveActor, resolveRequestLocale, resolveStatusCode } = await import("./shared");
      const actor = await resolveActor(request, options.resolveRequestActor);
      const locale = resolveRequestLocale(request);

      // Tag the actor metadata so the execution log records this as AI-sourced
      const aiActor = {
        ...actor,
        metadata: {
          ...actor.metadata,
          source: source ?? "ai",
          aiInitiated: true,
        },
      };

      const actionInput = input ?? {};

      try {
        let result: import("@linchkit/core").ActionResult;
        if (options.commandLayer) {
          const headers: Record<string, string> = {};
          for (const [key, value] of request.headers.entries()) {
            headers[key] = value;
          }
          result = await options.commandLayer.execute({
            command: actionName,
            input: actionInput,
            actor: aiActor,
            channel: "http",
            locale,
            headers,
          });
        } else {
          // executor is guaranteed non-null here — guard at line 772 ensures it
          const exec = executor as NonNullable<typeof executor>;
          result = await exec.execute(actionName, actionInput, aiActor, {
            channel: "http",
            locale,
          });
        }

        if (result.success) {
          return {
            success: true,
            data: result.data,
            meta: { executionId: result.executionId, source: "ai" },
          };
        }

        set.status = resolveStatusCode(result);
        const errData = result.data as Record<string, unknown> | undefined;
        const rawMessage = (errData?.error as string) ?? "Action execution failed";
        const isDevMode = process.env.NODE_ENV !== "production";
        return {
          success: false,
          error: {
            code: "ACTION.EXECUTION.FAILED",
            message: isDevMode ? rawMessage : "Action execution failed",
            ...(isDevMode && errData?.details ? { details: errData.details } : {}),
          },
          meta: { executionId: result.executionId },
        };
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : "Action execution failed";
        set.status = 500;
        return { success: false, error: { message: errorMessage } };
      }
    })
    // ── AI Analyze Record endpoint — deep AI analysis of a specific record ──
    .post("/api/ai/analyze-record", async ({ body, set }) => {
      const { entityName, recordId } = (body ?? {}) as {
        entityName?: string;
        recordId?: string;
      };

      if (!entityName || !recordId) {
        set.status = 400;
        return {
          success: false,
          error: { message: "entityName and recordId are required" },
        };
      }

      if (!aiService?.configured) {
        set.status = 503;
        return { success: false, error: { message: "AI service is not configured." } };
      }

      const dataProvider = options.dataProvider;
      if (!dataProvider) {
        set.status = 500;
        return { success: false, error: { message: "Data provider not configured." } };
      }

      const entityDef = entityRegistry?.get(entityName);
      if (!entityDef) {
        set.status = 404;
        return { success: false, error: { message: `Entity "${entityName}" not found.` } };
      }

      // Check in-memory cache (15 min TTL)
      const cacheKey = `${entityName}:${recordId}`;
      const cached = analysisCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < ANALYSIS_CACHE_TTL) {
        return { success: true, data: cached.result };
      }

      try {
        // Fetch the record
        const record = await dataProvider.get(entityName, recordId);
        if (!record) {
          set.status = 404;
          return { success: false, error: { message: `Record "${recordId}" not found.` } };
        }

        // Gather related records via ontology relations
        const relatedRecords: Record<string, Record<string, unknown>[]> = {};
        const ontologyRegistry = options.ontologyRegistry;
        if (ontologyRegistry) {
          const desc = ontologyRegistry.describe(entityName);
          if (desc) {
            for (const rel of desc.relations.slice(0, 5)) {
              try {
                // For outgoing relations, query the target entity
                const targetEntity = rel.targetEntity;
                const results = await dataProvider.query(targetEntity, {
                  limit: 5,
                });
                if (results.length > 0) {
                  relatedRecords[targetEntity] = results;
                }
              } catch {
                // Related entity query may fail — skip
              }
            }
          }
        }

        // Gather execution history
        let executionHistory: Array<{ action: string; timestamp: Date; actor: string }> | undefined;
        const executionLogger = options.executionLogger;
        if (executionLogger) {
          try {
            // Use findMany with entity filter and page limit to avoid unbounded fetches
            const result = await executionLogger.findMany({
              entity: entityName,
              pageSize: 200,
              sortField: "startedAt",
              sortOrder: "desc",
            });
            executionHistory = result.items
              .filter(
                (log) =>
                  log.input &&
                  typeof log.input === "object" &&
                  (log.input as Record<string, unknown>).id === recordId,
              )
              .slice(0, 20)
              .map((log) => ({
                action: log.action,
                timestamp: new Date(log.startedAt),
                actor: log.actor?.id ?? "unknown",
              }));
          } catch {
            // Execution log query may fail — skip
          }
        }

        const { analyzeRecord } = await import("@linchkit/core/ai");

        const analysis = await analyzeRecord(
          {
            entityName,
            recordId,
            record,
            entityDefinition: entityDef,
            relatedRecords: Object.keys(relatedRecords).length > 0 ? relatedRecords : undefined,
            executionHistory:
              executionHistory && executionHistory.length > 0 ? executionHistory : undefined,
          },
          aiService,
        );

        // Cache the result
        analysisCache.set(cacheKey, { result: analysis, timestamp: Date.now() });

        return { success: true, data: analysis };
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : "Record analysis failed";
        set.status = 500;
        return { success: false, error: { message: errorMessage } };
      }
    })
    // ── AI Search endpoint — natural language to DeclarativeCondition ──
    .post("/api/ai/search", async ({ body, set, request }) => {
      const {
        query: rawQuery,
        schema: targetSchema,
        fields,
        locale: bodyLocale,
      } = (body ?? {}) as {
        query?: string;
        schema?: string;
        fields?: Record<string, { label?: string; type?: string; options?: string[] }>;
        locale?: string;
      };

      if (!rawQuery || !targetSchema) {
        set.status = 400;
        return {
          success: false,
          error: { message: "Missing 'query' or 'schema' in request body." },
        };
      }

      if (!aiService?.configured) {
        return { success: true, data: null };
      }

      // Sanitize query: strip control characters, limit length, escape quotes
      const sanitizedQuery = rawQuery
        // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally stripping control chars
        .replace(/[\u0000-\u001f\u007f]/g, "") // strip control characters
        .slice(0, 500) // limit length
        .replace(/"/g, '\\"'); // escape quotes

      // Build allowed field names set (schema fields + system fields)
      const SYSTEM_FIELDS = new Set([
        "id",
        "tenant_id",
        "created_at",
        "updated_at",
        "created_by",
        "updated_by",
        "_version",
      ]);
      const SENSITIVE_FIELDS = new Set(["_password", "password", "secret", "token", "tenant_id"]);
      const allowedFields = new Set([...Object.keys(fields ?? {}), ...SYSTEM_FIELDS]);

      try {
        const fieldDescs = Object.entries(fields ?? {})
          .map(([name, def]) => {
            const parts = [`- ${name}`];
            if (def.label) parts.push(`(label: "${def.label}")`);
            if (def.type) parts.push(`[type: ${def.type}]`);
            if (def.options?.length) parts.push(`options: [${def.options.join(", ")}]`);
            return parts.join(" ");
          })
          .join("\n");

        const locale = extractLocale(bodyLocale, request);
        const langInstruction = locale ? getLanguageInstruction(locale) : undefined;

        const prompt = [
          `You are a search filter parser for a "${targetSchema}" data model.`,
          ...(langInstruction ? ["", langInstruction] : []),
          "",
          "Convert the following natural language search query into a structured filter condition.",
          "",
          "Available fields:",
          fieldDescs,
          "",
          "Available operators: eq, neq, gt, gte, lt, lte, in, not_in, contains, between, startsWith, endsWith, is_null, not_null",
          "",
          `Query: "${sanitizedQuery}"`,
          "",
          "Respond with valid JSON only (no markdown, no code fences). The response must have this exact shape:",
          `{ "filter": <condition>, "explanation": "<brief explanation${langInstruction ? " in the user's language" : ""}>" }`,
          "",
          "Filter condition formats:",
          '- Simple: { "field": "fieldName", "operator": "eq", "value": "someValue" }',
          '- Composite: { "operator": "and", "conditions": [<condition>, ...] }',
          '- For "between": { "field": "fieldName", "operator": "between", "value": [low, high] }',
          '- For "in": { "field": "fieldName", "operator": "in", "value": ["a", "b"] }',
          "",
          "Rules:",
          "- Match field names exactly from the available fields list",
          "- For enum/state fields, use the option values from the list",
          "- For number comparisons, use numeric values (not strings)",
          "- For date fields, use ISO date strings",
          "- If the query references a field label (Chinese or English), map it to the field name",
          '- If the query cannot be parsed into a filter, return { "filter": null, "explanation": "..." }',
        ].join("\n");

        const result = await aiService.complete({
          model: "fast",
          messages: [
            {
              role: "system",
              content:
                "You are a precise query parser. Only output valid JSON. No markdown formatting.",
            },
            { role: "user", content: prompt },
          ],
          temperature: 0,
          maxTokens: 1024,
          timeout: 15000,
        });

        let aiContent = result.content.trim();
        if (aiContent.startsWith("```")) {
          aiContent = aiContent.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
        }

        const parsed = JSON.parse(aiContent) as { filter: unknown; explanation: string };

        if (!parsed.filter) {
          return { success: true, data: null };
        }

        // Validate AI-generated filter: strip fields not in schema or sensitive fields
        const validatedFilter = validateAIFilter(parsed.filter, allowedFields, SENSITIVE_FIELDS);

        return {
          success: true,
          data: { filter: validatedFilter, explanation: parsed.explanation ?? "" },
        };
      } catch (err) {
        const errMsg =
          process.env.NODE_ENV === "production"
            ? "AI search parsing failed."
            : err instanceof Error
              ? err.message
              : String(err);
        set.status = 500;
        return { success: false, error: { message: errMsg } };
      }
    });
}
