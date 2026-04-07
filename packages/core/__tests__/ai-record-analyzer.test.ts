import { describe, expect, it } from "bun:test";
import {
  analyzeRecord,
  buildAnalysisPrompt,
  parseAnalysisResponse,
  type RecordAnalysisRequest,
} from "../src/ai/record-analyzer";
import type { AIService } from "../src/types/ai";
import type { EntityDefinition } from "../src/types/entity";

// ── Test fixtures ──────────────────────────────────────────

const testEntity: EntityDefinition = {
  name: "purchase_order",
  label: "Purchase Order",
  description: "A purchase order record",
  fields: {
    title: { type: "string", label: "Title", required: true },
    amount: { type: "number", label: "Amount", required: true },
    status: { type: "state", label: "Status" },
    supplier_id: { type: "string", label: "Supplier", description: "FK to supplier" },
  },
};

const testRecord: Record<string, unknown> = {
  id: "po-001",
  title: "Office Supplies",
  amount: 1500,
  status: "draft",
  supplier_id: "sup-001",
};

const baseRequest: RecordAnalysisRequest = {
  entityName: "purchase_order",
  recordId: "po-001",
  record: testRecord,
  entityDefinition: testEntity,
};

// ── buildAnalysisPrompt tests ──────────────────────────────

describe("buildAnalysisPrompt", () => {
  it("includes entity name and record ID", () => {
    const prompt = buildAnalysisPrompt(baseRequest);
    expect(prompt).toContain("purchase_order");
    expect(prompt).toContain("po-001");
  });

  it("includes field definitions", () => {
    const prompt = buildAnalysisPrompt(baseRequest);
    expect(prompt).toContain("title (string)");
    expect(prompt).toContain("amount (number)");
    expect(prompt).toContain("REQUIRED");
  });

  it("includes entity label and description", () => {
    const prompt = buildAnalysisPrompt(baseRequest);
    expect(prompt).toContain("Purchase Order");
    expect(prompt).toContain("A purchase order record");
  });

  it("includes record data as JSON", () => {
    const prompt = buildAnalysisPrompt(baseRequest);
    expect(prompt).toContain('"Office Supplies"');
    expect(prompt).toContain("1500");
  });

  it("includes related records when provided", () => {
    const req: RecordAnalysisRequest = {
      ...baseRequest,
      relatedRecords: {
        supplier: [{ id: "sup-001", name: "Acme Corp" }],
      },
    };
    const prompt = buildAnalysisPrompt(req);
    expect(prompt).toContain("Related Records");
    expect(prompt).toContain("Acme Corp");
  });

  it("includes execution history when provided", () => {
    const req: RecordAnalysisRequest = {
      ...baseRequest,
      executionHistory: [
        { action: "create_purchase_order", timestamp: new Date("2025-01-01"), actor: "user-1" },
      ],
    };
    const prompt = buildAnalysisPrompt(req);
    expect(prompt).toContain("Execution History");
    expect(prompt).toContain("create_purchase_order");
    expect(prompt).toContain("user-1");
  });

  it("omits related records section when empty", () => {
    const prompt = buildAnalysisPrompt(baseRequest);
    expect(prompt).not.toContain("Related Records");
  });

  it("omits execution history section when empty", () => {
    const prompt = buildAnalysisPrompt(baseRequest);
    expect(prompt).not.toContain("Execution History");
  });
});

// ── parseAnalysisResponse tests ────────���───────────────────

describe("parseAnalysisResponse", () => {
  it("parses valid JSON array of insights", () => {
    const raw = JSON.stringify([
      {
        type: "risk",
        severity: "warning",
        title: "High amount",
        description: "Amount exceeds typical range",
      },
      {
        type: "recommendation",
        severity: "info",
        title: "Add approval",
        description: "Consider adding an approval step",
        data: {
          suggestedAction: {
            action: "submit_for_approval",
            input: { id: "po-001" },
          },
        },
      },
    ]);
    const insights = parseAnalysisResponse(raw);
    expect(insights).toHaveLength(2);
    expect(insights[0].type).toBe("risk");
    expect(insights[0].severity).toBe("warning");
    expect(insights[1].type).toBe("recommendation");
    expect(insights[1].data?.suggestedAction?.action).toBe("submit_for_approval");
  });

  it("strips markdown code fences", () => {
    const raw =
      '```json\n[{"type":"risk","severity":"info","title":"Test","description":"Desc"}]\n```';
    const insights = parseAnalysisResponse(raw);
    expect(insights).toHaveLength(1);
    expect(insights[0].title).toBe("Test");
  });

  it("returns empty array for invalid JSON", () => {
    expect(parseAnalysisResponse("not json")).toEqual([]);
  });

  it("returns empty array for non-array JSON", () => {
    expect(parseAnalysisResponse('{"type":"risk"}')).toEqual([]);
  });

  it("filters out entries with invalid type", () => {
    const raw = JSON.stringify([
      { type: "unknown_type", severity: "info", title: "T", description: "D" },
      { type: "risk", severity: "info", title: "Valid", description: "D" },
    ]);
    const insights = parseAnalysisResponse(raw);
    expect(insights).toHaveLength(1);
    expect(insights[0].title).toBe("Valid");
  });

  it("filters out entries with invalid severity", () => {
    const raw = JSON.stringify([
      { type: "risk", severity: "extreme", title: "T", description: "D" },
    ]);
    expect(parseAnalysisResponse(raw)).toEqual([]);
  });

  it("filters out entries missing required fields", () => {
    const raw = JSON.stringify([
      { type: "risk", severity: "info" }, // missing title + description
      { type: "risk", severity: "info", title: "", description: "D" }, // empty title
    ]);
    expect(parseAnalysisResponse(raw)).toEqual([]);
  });

  it("truncates long titles and descriptions", () => {
    const raw = JSON.stringify([
      {
        type: "risk",
        severity: "info",
        title: "A".repeat(200),
        description: "B".repeat(600),
      },
    ]);
    const insights = parseAnalysisResponse(raw);
    expect(insights[0].title.length).toBeLessThanOrEqual(100);
    expect(insights[0].description.length).toBeLessThanOrEqual(500);
  });

  it("returns empty array for empty input", () => {
    expect(parseAnalysisResponse("")).toEqual([]);
    expect(parseAnalysisResponse("  ")).toEqual([]);
  });
});

// ── analyzeRecord tests ────────────────────────────────────

describe("analyzeRecord", () => {
  it("returns analysis with parsed insights on success", async () => {
    const mockService: AIService = {
      configured: true,
      defaultProvider: "test",
      providerNames: ["test"],
      complete: async () => ({
        content: JSON.stringify([
          {
            type: "risk",
            severity: "warning",
            title: "High amount",
            description: "Amount is high",
          },
        ]),
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        model: "test-model",
        provider: "test",
        duration: 500,
      }),
    };

    const result = await analyzeRecord(baseRequest, mockService);
    expect(result.recordId).toBe("po-001");
    expect(result.entityName).toBe("purchase_order");
    expect(result.insights).toHaveLength(1);
    expect(result.insights[0].type).toBe("risk");
    expect(result.model).toBe("test-model");
    expect(result.generatedAt).toBeInstanceOf(Date);
  });

  it("returns empty insights when AI fails", async () => {
    const failingService: AIService = {
      configured: true,
      defaultProvider: "test",
      providerNames: ["test"],
      complete: async () => {
        throw new Error("AI service unavailable");
      },
    };

    const result = await analyzeRecord(baseRequest, failingService);
    expect(result.insights).toEqual([]);
    expect(result.model).toBe("unknown");
  });

  it("returns empty insights when AI returns invalid JSON", async () => {
    const badService: AIService = {
      configured: true,
      defaultProvider: "test",
      providerNames: ["test"],
      complete: async () => ({
        content: "I cannot analyze this record",
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        model: "test-model",
        provider: "test",
        duration: 300,
      }),
    };

    const result = await analyzeRecord(baseRequest, badService);
    expect(result.insights).toEqual([]);
  });
});
