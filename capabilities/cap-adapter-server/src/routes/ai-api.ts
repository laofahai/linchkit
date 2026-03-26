/**
 * AI-powered REST endpoints.
 *
 * - POST /api/ai/auto-fill — AI-generated form field suggestions
 * - POST /api/ai/chat — Vercel AI SDK streamText with tools (conversation history + function calling)
 * - POST /api/ai/resolve-intent — natural language to action proposal
 * - POST /api/ai/search — natural language to DeclarativeCondition filter
 */

import type { Elysia } from "elysia";
import type { ServerOptions } from "../server";

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

export function mountAIRoutes(
  app: Elysia,
  options: ServerOptions,
): void {
  const aiService = options.aiService;
  const schemaRegistry = options.schemaRegistry;
  const executor = options.executor;

  app
    // ── AI Auto-Fill endpoint ────────────────────────────
    .post("/api/ai/auto-fill", async ({ body, set }) => {
      const { schema: schemaName, fields, currentValues } = (body ?? {}) as {
        schema?: string;
        fields?: Record<string, { label?: string; type?: string; required?: boolean; options?: string[]; description?: string }>;
        currentValues?: Record<string, unknown>;
      };

      // Always validate required fields first, before checking AI availability
      if (!schemaName || !fields) {
        set.status = 400;
        return { success: false, error: { message: "Missing 'schema' or 'fields' in request body." } };
      }

      if (!aiService?.configured) {
        return { success: true, data: { suggestions: {} } };
      }

      try {
        // Build field descriptions for the prompt
        const fieldDescriptions = Object.entries(fields).map(([name, def]) => {
          const parts = [`- ${name}`];
          if (def.label) parts.push(`(label: "${def.label}")`);
          if (def.type) parts.push(`[type: ${def.type}]`);
          if (def.required) parts.push("(required)");
          if (def.options?.length) parts.push(`options: [${def.options.join(", ")}]`);
          if (def.description) parts.push(`— ${def.description}`);
          return parts.join(" ");
        }).join("\n");

        // Identify which fields already have values
        const filledFields = currentValues
          ? Object.entries(currentValues)
              .filter(([, v]) => v !== null && v !== undefined && v !== "")
              .map(([k, v]) => `- ${k}: ${JSON.stringify(v)}`)
              .join("\n")
          : "None";

        // Identify empty fields that need suggestions
        const emptyFieldNames = Object.keys(fields).filter((name) => {
          const val = currentValues?.[name];
          return val === null || val === undefined || val === "";
        });

        if (emptyFieldNames.length === 0) {
          return { success: true, data: { suggestions: {} } };
        }

        const prompt = `You are a form auto-fill assistant for a "${schemaName}" record.

Given the schema fields and any already-filled values, suggest realistic values for the empty fields.

Schema fields:
${fieldDescriptions}

Already filled:
${filledFields}

Empty fields that need suggestions: ${emptyFieldNames.join(", ")}

Respond with a JSON object where each key is a field name and the value is an object with:
- "value": the suggested value (matching the field type)
- "confidence": a number 0-1 indicating how confident you are
- "reason": a brief explanation of why you suggested this value

Only suggest values for the empty fields listed above. For enum/state fields, only use values from the provided options. For number fields, provide a number. For boolean fields, provide true/false. For date fields, provide an ISO date string.`;

        const result = await aiService.complete({
          model: "fast",
          messages: [
            { role: "system", content: "You are a helpful assistant that fills form fields with realistic, contextually appropriate values. Always respond with valid JSON only, no markdown formatting." },
            { role: "user", content: prompt },
          ],
          temperature: 0.3,
          maxTokens: 2000,
          timeout: 30000,
        });

        // Parse AI response
        let suggestions: Record<string, { value: unknown; confidence: number; reason?: string }> = {};
        try {
          // Strip markdown code fences if present
          let content = result.content.trim();
          if (content.startsWith("```")) {
            content = content.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
          }
          suggestions = JSON.parse(content);
        } catch {
          // If parsing fails, return empty suggestions
          return { success: true, data: { suggestions: {} } };
        }

        return { success: true, data: { suggestions } };
      } catch (err) {
        const message = process.env.NODE_ENV === "production"
          ? "AI auto-fill failed."
          : err instanceof Error ? err.message : String(err);
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
            message: "AI service is not configured. Configure an AI provider in linchkit.config.ts to enable the assistant.",
          },
        };
      }

      try {
        const { streamText, stepCountIs, convertToModelMessages } = await import("ai");
        const { resolveLanguageModel } = await import("@linchkit/core/server");
        const { createTenantAwareDataProvider } = await import("@linchkit/core/server");
        const { buildSystemPrompt } = await import("../ai/system-prompt");
        const { buildTools } = await import("../ai/tools");
        const { ANONYMOUS_ACTOR: anonActor } = await import("./shared");

        const assistantConfig = aiConfig.assistant;

        // Resolve the language model from config
        const model = await resolveLanguageModel(
          aiConfig,
          assistantConfig?.model ?? "fast",
        );

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
        const scopedProvider = tenantId && dataProvider
          ? createTenantAwareDataProvider(dataProvider, tenantId)
          : dataProvider;

        // Build dynamic system prompt with schema context from OntologyRegistry
        const systemPrompt = buildSystemPrompt({
          assistantConfig,
          ontologyRegistry: options.ontologyRegistry,
          schemaRegistry,
          context: {
            schema: context?.schema,
            recordId: context?.recordId,
            recordData: context?.recordData,
          },
        });

        // Build context-aware tools (query, execute, describe, navigate)
        const tools = buildTools({
          dataProvider: scopedProvider,
          commandLayer: options.commandLayer,
          schemaRegistry,
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
        const errorMessage =
          err instanceof Error ? err.message : "AI chat failed";
        set.status = 500;
        return {
          success: false,
          error: { message: errorMessage },
        };
      }
    })
    // ── AI Intent Resolution endpoint — natural language to action proposal ──
    .post("/api/ai/resolve-intent", async ({ body, set }) => {
      const { message, context } = (body ?? {}) as {
        message?: string;
        context?: { schema?: string; recordId?: string };
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

      // Build action catalog for the AI prompt
      const allActions = actionRegistry.getAll();
      const actionCatalog = allActions.map((a) => {
        const inputFields = a.input
          ? Object.entries(a.input).map(([name, field]) => ({
              name,
              type: field.type,
              label: field.label,
              required: field.required ?? false,
              options: (field as { options?: Array<{ value: string; label?: string }> }).options?.map(
                (o) => o.value,
              ),
              description: field.description,
            }))
          : [];
        return {
          name: a.name,
          schema: a.schema,
          label: a.label,
          description: a.description,
          inputFields,
        };
      });

      // Build schema context
      let schemaContext = "";
      if (context?.schema && schemaRegistry) {
        const schema = schemaRegistry.get(context.schema);
        if (schema) {
          schemaContext = `\nCurrent schema context: ${schema.name}`;
          if (schema.label) schemaContext += ` (${schema.label})`;
          schemaContext += `\nFields: ${Object.entries(schema.fields)
            .map(([k, v]) => `${k}(${v.type}${v.label ? `, label: ${v.label}` : ""})`)
            .join(", ")}`;
          if (context.recordId) schemaContext += `\nViewing record ID: ${context.recordId}`;
        }
      }

      const systemPrompt = `You are LinchKit AI Intent Resolver. Given a user's natural language request, determine which action to execute and extract the input parameters.

Available actions:
${JSON.stringify(actionCatalog, null, 2)}
${schemaContext}

Respond with a JSON object (and nothing else) in this exact format:
{
  "action": "action_name or null if no match",
  "schema": "schema_name or null",
  "input": { "field_name": "extracted_value" },
  "missingFields": ["field names that are required but not extracted"],
  "confidence": 0.0 to 1.0,
  "explanation": "Human-readable explanation of what will happen"
}

Rules:
- Only match actions from the available list above.
- Extract parameter values from the user message. Convert types appropriately (strings to numbers, etc.).
- If you cannot determine a good match, set action to null and confidence to 0.
- If some required fields are missing from the user message, list them in missingFields.
- The explanation should be concise and user-friendly.`;

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
        };
        try {
          // Strip markdown code fences if present
          const cleaned = result.content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
          parsed = JSON.parse(cleaned);
        } catch {
          // AI didn't return valid JSON — no intent resolved
          return { success: true, data: null };
        }

        if (!parsed.action || parsed.confidence < 0.3) {
          return { success: true, data: null };
        }

        // Verify the action actually exists
        const matchedAction = actionRegistry.get(parsed.action);
        if (!matchedAction) {
          return { success: true, data: null };
        }

        return {
          success: true,
          data: {
            action: parsed.action,
            schema: parsed.schema ?? matchedAction.schema,
            input: parsed.input ?? {},
            missingFields: parsed.missingFields ?? [],
            confidence: parsed.confidence,
            explanation: parsed.explanation,
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
                      options: (v as { options?: Array<{ value: string; label?: string }> }).options,
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
    // ── AI Search endpoint — natural language to DeclarativeCondition ──
    .post("/api/ai/search", async ({ body, set }) => {
      const { query: rawQuery, schema: targetSchema, fields } = (body ?? {}) as {
        query?: string;
        schema?: string;
        fields?: Record<string, { label?: string; type?: string; options?: string[] }>;
      };

      if (!rawQuery || !targetSchema) {
        set.status = 400;
        return { success: false, error: { message: "Missing 'query' or 'schema' in request body." } };
      }

      if (!aiService?.configured) {
        return { success: true, data: null };
      }

      // Sanitize query: strip control characters, limit length, escape quotes
      const sanitizedQuery = rawQuery
        .replace(/[\x00-\x1f\x7f]/g, "") // strip control characters
        .slice(0, 500) // limit length
        .replace(/"/g, '\\"'); // escape quotes

      // Build allowed field names set (schema fields + system fields)
      const SYSTEM_FIELDS = new Set(["id", "tenant_id", "created_at", "updated_at", "created_by", "updated_by", "_version"]);
      const SENSITIVE_FIELDS = new Set(["_password", "password", "secret", "token", "tenant_id"]);
      const allowedFields = new Set([
        ...Object.keys(fields ?? {}),
        ...SYSTEM_FIELDS,
      ]);

      try {
        const fieldDescs = Object.entries(fields ?? {}).map(([name, def]) => {
          const parts = [`- ${name}`];
          if (def.label) parts.push(`(label: "${def.label}")`);
          if (def.type) parts.push(`[type: ${def.type}]`);
          if (def.options?.length) parts.push(`options: [${def.options.join(", ")}]`);
          return parts.join(" ");
        }).join("\n");

        const prompt = [
          `You are a search filter parser for a "${targetSchema}" data model.`,
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
          'Respond with valid JSON only (no markdown, no code fences). The response must have this exact shape:',
          '{ "filter": <condition>, "explanation": "<brief explanation>" }',
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
            { role: "system", content: "You are a precise query parser. Only output valid JSON. No markdown formatting." },
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
        const errMsg = process.env.NODE_ENV === "production"
          ? "AI search parsing failed."
          : err instanceof Error ? err.message : String(err);
        set.status = 500;
        return { success: false, error: { message: errMsg } };
      }
    });
}
