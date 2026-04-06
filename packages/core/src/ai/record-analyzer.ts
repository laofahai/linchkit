/**
 * Record Analyzer — Context gathering + AI analysis for a specific record.
 *
 * Builds a structured prompt with record data, schema metadata, related records,
 * and execution history, then parses the AI JSON response into typed insights.
 *
 * See spec 52 — AI Deep Integration, P2 Record Analysis.
 */

import type { AICompletionResult, AIService } from "../types/ai";
import type { EntityDefinition, FieldDefinition } from "../types/entity";

// ── Types ───────────────────────────────────────────────────

export interface RecordAnalysisRequest {
  entityName: string;
  recordId: string;
  record: Record<string, unknown>;
  entityDefinition: EntityDefinition;
  relatedRecords?: Record<string, Record<string, unknown>[]>;
  executionHistory?: Array<{ action: string; timestamp: Date; actor: string }>;
}

export interface RecordInsight {
  type: "comparison" | "timeline" | "risk" | "recommendation" | "related";
  severity: "info" | "warning" | "critical";
  title: string;
  description: string;
  data?: {
    comparison?: { current: number; average: number; field: string };
    relatedRecords?: Array<{ id: string; entity: string; label: string }>;
    suggestedAction?: { action: string; input: Record<string, unknown> };
  };
}

export interface RecordAnalysis {
  recordId: string;
  entityName: string;
  insights: RecordInsight[];
  generatedAt: Date;
  model: string;
}

// ── Prompt Builder ──────────────────────────────────────────

/**
 * Build a structured analysis prompt from record data and context.
 */
export function buildAnalysisPrompt(req: RecordAnalysisRequest): string {
  const { entityName, recordId, record, entityDefinition, relatedRecords, executionHistory } = req;

  // Schema description
  const schemaDesc = [
    `Entity: ${entityName}`,
    entityDefinition.label ? `Label: ${entityDefinition.label}` : "",
    entityDefinition.description ? `Description: ${entityDefinition.description}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  // Field definitions summary
  const fieldLines = Object.entries(entityDefinition.fields)
    .map(([name, field]: [string, FieldDefinition]) => {
      const parts = [`  - ${name} (${field.type})`];
      if (field.label) parts.push(`label: "${field.label}"`);
      if (field.required) parts.push("REQUIRED");
      if (field.description) parts.push(`— ${field.description}`);
      return parts.join(" ");
    })
    .join("\n");

  // Current record data
  const recordData = JSON.stringify(record, null, 2);

  // Related records section
  let relatedSection = "";
  if (relatedRecords && Object.keys(relatedRecords).length > 0) {
    const lines = Object.entries(relatedRecords)
      .map(
        ([entity, records]) =>
          `  ${entity}: ${records.length} records\n${JSON.stringify(records.slice(0, 5), null, 2)}`,
      )
      .join("\n");
    relatedSection = `\nRelated Records:\n${lines}`;
  }

  // Execution history section
  let historySection = "";
  if (executionHistory && executionHistory.length > 0) {
    const lines = executionHistory
      .slice(0, 20)
      .map((h) => `  - ${h.action} by ${h.actor} at ${h.timestamp.toISOString()}`)
      .join("\n");
    historySection = `\nExecution History (recent):\n${lines}`;
  }

  return `Analyze the following record and provide structured insights.

${schemaDesc}

Field Definitions:
${fieldLines}

Record (ID: ${recordId}):
${recordData}
${relatedSection}${historySection}

Respond with a JSON array of insights. Each insight must have this shape:
{
  "type": "comparison" | "timeline" | "risk" | "recommendation" | "related",
  "severity": "info" | "warning" | "critical",
  "title": "Short title",
  "description": "Human-readable description",
  "data": {
    "comparison": { "current": <number>, "average": <number>, "field": "<field_name>" },
    "relatedRecords": [{ "id": "<id>", "entity": "<entity>", "label": "<label>" }],
    "suggestedAction": { "action": "<action_name>", "input": { ... } }
  }
}

Rules:
- Only include "data" fields relevant to the insight type.
- "comparison" insights compare a numeric field to expected/average values.
- "timeline" insights highlight patterns in execution history.
- "risk" insights flag potential issues (missing required data, stale records, etc.).
- "recommendation" insights suggest next actions with pre-filled input.
- "related" insights highlight notable connections to related records.
- Keep titles concise (<60 chars). Keep descriptions under 200 chars.
- Return an empty array [] if there are no meaningful insights.
- Respond with valid JSON only (no markdown, no code fences).`;
}

// ── Response Parser ─────────────────────────────────────────

const VALID_TYPES = new Set(["comparison", "timeline", "risk", "recommendation", "related"]);
const VALID_SEVERITIES = new Set(["info", "warning", "critical"]);

/**
 * Parse an AI response string into typed RecordInsight array.
 * Gracefully handles malformed responses by filtering invalid entries.
 */
export function parseAnalysisResponse(raw: string): RecordInsight[] {
  let cleaned = raw.trim();

  // Strip markdown code fences if present
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  const insights: RecordInsight[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;

    // Validate required fields
    if (typeof obj.type !== "string" || !VALID_TYPES.has(obj.type)) continue;
    if (typeof obj.severity !== "string" || !VALID_SEVERITIES.has(obj.severity)) continue;
    if (typeof obj.title !== "string" || !obj.title) continue;
    if (typeof obj.description !== "string" || !obj.description) continue;

    const insight: RecordInsight = {
      type: obj.type as RecordInsight["type"],
      severity: obj.severity as RecordInsight["severity"],
      title: obj.title.slice(0, 100),
      description: obj.description.slice(0, 500),
    };

    // Optionally attach data payload
    if (obj.data && typeof obj.data === "object") {
      insight.data = obj.data as RecordInsight["data"];
    }

    insights.push(insight);
  }

  return insights;
}

// ── Main Entry Point ────────────────────────────────────────

/**
 * Analyze a record using AI and return structured insights.
 */
export async function analyzeRecord(
  req: RecordAnalysisRequest,
  aiService: AIService,
): Promise<RecordAnalysis> {
  const prompt = buildAnalysisPrompt(req);

  let result: AICompletionResult;
  try {
    result = await aiService.complete({
      model: "fast",
      messages: [
        {
          role: "system",
          content:
            "You are a data analyst. Analyze records and provide structured insights in JSON format. Be concise and actionable. Only output valid JSON, no markdown.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
      maxTokens: 2048,
      timeout: 30_000,
      taskType: "analysis",
    });
  } catch {
    // AI call failed — return empty analysis
    return {
      recordId: req.recordId,
      entityName: req.entityName,
      insights: [],
      generatedAt: new Date(),
      model: "unknown",
    };
  }

  const insights = parseAnalysisResponse(result.content);

  return {
    recordId: req.recordId,
    entityName: req.entityName,
    insights,
    generatedAt: new Date(),
    model: result.model,
  };
}
