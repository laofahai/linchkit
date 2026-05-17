import { describe, expect, it } from "bun:test";
import { scanDataQuality } from "../src/ai/data-quality-scanner";
import type { EntityDefinition } from "../src/types/entity";

// ── Test fixtures ──────────────────────────────────────────

const baseEntity: EntityDefinition = {
  name: "purchase_order",
  label: "Purchase Order",
  fields: {
    title: { type: "string", label: "Title", required: true },
    amount: { type: "number", label: "Amount", required: true },
    status: { type: "state", label: "Status" },
    supplier_id: { type: "string", label: "Supplier ID" },
    notes: { type: "text", label: "Notes" },
  },
};

const nowIso = new Date().toISOString();
const staleIso = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(); // 40 days ago

const goodRecords: Record<string, unknown>[] = [
  {
    id: "r1",
    title: "Office Supplies",
    amount: 1500,
    status: "approved",
    supplier_id: "sup-1",
    updated_at: nowIso,
  },
  {
    id: "r2",
    title: "IT Equipment",
    amount: 3200,
    status: "draft",
    supplier_id: "sup-2",
    updated_at: nowIso,
  },
  {
    id: "r3",
    title: "Furniture",
    amount: 900,
    status: "submitted",
    supplier_id: "sup-1",
    updated_at: nowIso,
  },
];

// ── scanDataQuality - basic ────────────────────────────────

describe("scanDataQuality — basics", () => {
  it("returns score 100 with no records", () => {
    const report = scanDataQuality([], baseEntity);
    expect(report.score).toBe(100);
    expect(report.stats.totalRecords).toBe(0);
    expect(report.issues).toHaveLength(0);
  });

  it("returns score 100 for clean records", () => {
    const report = scanDataQuality(goodRecords, baseEntity);
    expect(report.score).toBe(100);
    expect(report.schemaName).toBe("purchase_order");
    expect(report.issues).toHaveLength(0);
    expect(report.stats.totalRecords).toBe(3);
    expect(report.scannedAt).toBeInstanceOf(Date);
  });

  it("populates stats.byType and stats.bySeverity correctly", () => {
    const records = [{ id: "r1", title: null, amount: 100, status: "draft", updated_at: nowIso }];
    const report = scanDataQuality(records, baseEntity);
    expect(report.stats.byType.completeness).toBeGreaterThan(0);
    expect(Object.keys(report.stats.bySeverity).length).toBeGreaterThan(0);
  });
});

// ── completeness checks ────────────────────────────────────

describe("scanDataQuality — completeness", () => {
  it("flags records with required field null", () => {
    const records = [
      { id: "r1", title: null, amount: 100, status: "draft", updated_at: nowIso },
      { id: "r2", title: "Valid", amount: 200, status: "draft", updated_at: nowIso },
    ];
    const report = scanDataQuality(records, baseEntity);
    const completenessIssues = report.issues.filter((i) => i.type === "completeness");
    expect(completenessIssues.length).toBeGreaterThan(0);
    const titleIssue = completenessIssues.find((i) => i.fields?.includes("title"));
    expect(titleIssue).toBeDefined();
    expect(titleIssue?.recordIds).toContain("r1");
    expect(titleIssue?.recordIds).not.toContain("r2");
  });

  it("flags records with required string field empty", () => {
    const records = [{ id: "r1", title: "", amount: 50, status: "draft", updated_at: nowIso }];
    const report = scanDataQuality(records, baseEntity);
    const issue = report.issues.find(
      (i) => i.type === "completeness" && i.fields?.includes("title"),
    );
    expect(issue).toBeDefined();
    expect(issue?.recordIds).toContain("r1");
  });

  it("does not flag optional fields", () => {
    const records = [
      {
        id: "r1",
        title: "OK",
        amount: 100,
        status: "draft",
        supplier_id: null,
        updated_at: nowIso,
      },
    ];
    const report = scanDataQuality(records, baseEntity);
    const refIssues = report.issues.filter(
      (i) => i.type === "completeness" && i.fields?.includes("supplier_id"),
    );
    expect(refIssues).toHaveLength(0);
  });

  it("severity is 'high' when >30% of records have missing required field", () => {
    const records = Array.from({ length: 10 }, (_, i) => ({
      id: `r${i}`,
      title: i < 4 ? null : "OK",
      amount: 100,
      status: "draft",
      updated_at: nowIso,
    }));
    const report = scanDataQuality(records, baseEntity);
    const issue = report.issues.find(
      (i) => i.type === "completeness" && i.fields?.includes("title"),
    );
    expect(issue?.severity).toBe("high");
  });

  it("severity is 'low' when <5% of records have missing required field", () => {
    const records = Array.from({ length: 100 }, (_, i) => ({
      id: `r${i}`,
      title: i === 0 ? null : "OK",
      amount: 100,
      status: "draft",
      updated_at: nowIso,
    }));
    const report = scanDataQuality(records, baseEntity);
    const issue = report.issues.find(
      (i) => i.type === "completeness" && i.fields?.includes("title"),
    );
    expect(issue?.severity).toBe("low");
  });
});

// ── freshness checks ───────────────────────────────────────

describe("scanDataQuality — freshness", () => {
  it("flags stale records (updated_at older than threshold)", () => {
    const records = [
      { id: "r1", title: "Old", amount: 100, status: "draft", updated_at: staleIso },
      { id: "r2", title: "New", amount: 200, status: "draft", updated_at: nowIso },
    ];
    const report = scanDataQuality(records, baseEntity);
    const freshnessIssue = report.issues.find((i) => i.type === "freshness");
    expect(freshnessIssue).toBeDefined();
    expect(freshnessIssue?.recordIds).toContain("r1");
    expect(freshnessIssue?.recordIds).not.toContain("r2");
  });

  it("respects custom freshnessThresholdMs", () => {
    const records = [
      { id: "r1", title: "Recent", amount: 100, status: "draft", updated_at: nowIso },
    ];
    // Set threshold to 0 so even fresh records count as stale
    const report = scanDataQuality(records, baseEntity, { freshnessThresholdMs: 0 });
    const issue = report.issues.find((i) => i.type === "freshness");
    expect(issue).toBeDefined();
    expect(issue?.recordIds).toContain("r1");
  });

  it("skips freshness check on entities without state/status field", () => {
    const entityWithoutState: EntityDefinition = {
      name: "config_item",
      fields: {
        key: { type: "string", required: true },
        value: { type: "string" },
      },
    };
    const records = [{ id: "r1", key: "foo", value: "bar", updated_at: staleIso }];
    const report = scanDataQuality(records, entityWithoutState);
    expect(report.issues.filter((i) => i.type === "freshness")).toHaveLength(0);
  });

  it("skips records without updated_at", () => {
    const records = [{ id: "r1", title: "No timestamp", amount: 100, status: "draft" }];
    const report = scanDataQuality(records, baseEntity);
    expect(report.issues.filter((i) => i.type === "freshness")).toHaveLength(0);
  });
});

// ── outlier checks ─────────────────────────────────────────

describe("scanDataQuality — outliers", () => {
  it("flags numeric outliers by z-score", () => {
    // 99 records around 100, 1 extreme outlier — need large n to exceed z=3 bound
    const records = Array.from({ length: 99 }, (_, i) => ({
      id: `r${i}`,
      title: "Normal",
      amount: 100 + (i % 10),
      status: "draft",
      updated_at: nowIso,
    }));
    records.push({
      id: "r99",
      title: "Outlier",
      amount: 10000,
      status: "draft",
      updated_at: nowIso,
    });

    const report = scanDataQuality(records, baseEntity);
    const outlierIssue = report.issues.find((i) => i.type === "outlier");
    expect(outlierIssue).toBeDefined();
    expect(outlierIssue?.recordIds).toContain("r99");
    expect(outlierIssue?.fields).toContain("amount");
  });

  it("skips outlier check when fewer than 5 records", () => {
    const records = [
      { id: "r1", title: "A", amount: 9999, status: "draft", updated_at: nowIso },
      { id: "r2", title: "B", amount: 1, status: "draft", updated_at: nowIso },
    ];
    const report = scanDataQuality(records, baseEntity);
    expect(report.issues.filter((i) => i.type === "outlier")).toHaveLength(0);
  });

  it("skips entity with no numeric fields", () => {
    const textOnlyEntity: EntityDefinition = {
      name: "tag",
      fields: { name: { type: "string", required: true } },
    };
    const records = [{ id: "r1", name: "foo", updated_at: nowIso }];
    const report = scanDataQuality(records, textOnlyEntity);
    expect(report.issues.filter((i) => i.type === "outlier")).toHaveLength(0);
  });

  it("respects custom outlierZThreshold", () => {
    const records = Array.from({ length: 10 }, (_, i) => ({
      id: `r${i}`,
      title: "T",
      amount: i === 9 ? 500 : 100,
      status: "draft",
      updated_at: nowIso,
    }));
    // With default z=3 the mild outlier might not be flagged; with z=1 it should be
    const report = scanDataQuality(records, baseEntity, { outlierZThreshold: 1 });
    const outlierIssue = report.issues.find((i) => i.type === "outlier");
    expect(outlierIssue).toBeDefined();
  });
});

// ── referential integrity checks ───────────────────────────

describe("scanDataQuality — referential", () => {
  it("flags _id fields with empty string placeholder", () => {
    const records = [
      { id: "r1", title: "T", amount: 100, status: "draft", supplier_id: "", updated_at: nowIso },
    ];
    const report = scanDataQuality(records, baseEntity);
    const refIssue = report.issues.find(
      (i) => i.type === "referential" && i.fields?.includes("supplier_id"),
    );
    expect(refIssue).toBeDefined();
    expect(refIssue?.recordIds).toContain("r1");
  });

  it("does not flag valid _id field values", () => {
    const records = [
      {
        id: "r1",
        title: "T",
        amount: 100,
        status: "draft",
        supplier_id: "sup-123",
        updated_at: nowIso,
      },
    ];
    const report = scanDataQuality(records, baseEntity);
    expect(report.issues.filter((i) => i.type === "referential")).toHaveLength(0);
  });
});

// ── score and stats ────────────────────────────────────────

describe("scanDataQuality — score", () => {
  it("score decreases with more issues", () => {
    const cleanReport = scanDataQuality(goodRecords, baseEntity);
    const dirtyRecords = [
      { id: "r1", title: null, amount: null, status: "draft", updated_at: staleIso },
    ];
    const dirtyReport = scanDataQuality(dirtyRecords, baseEntity);
    expect(dirtyReport.score).toBeLessThan(cleanReport.score);
  });

  it("score is never below 0", () => {
    // Lots of issues
    const records = Array.from({ length: 50 }, (_, i) => ({
      id: `r${i}`,
      title: null,
      amount: null,
      status: "draft",
      updated_at: staleIso,
    }));
    const report = scanDataQuality(records, baseEntity);
    expect(report.score).toBeGreaterThanOrEqual(0);
  });

  it("respects maxRecords option", () => {
    const records = Array.from({ length: 500 }, (_, i) => ({
      id: `r${i}`,
      title: "T",
      amount: 100,
      status: "draft",
      updated_at: nowIso,
    }));
    // Inject a completeness violation beyond the first 10 records
    records[250] = {
      id: "r250",
      title: null as unknown as string,
      amount: 100,
      status: "draft",
      updated_at: nowIso,
    };
    const report = scanDataQuality(records, baseEntity, { maxRecords: 10 });
    // Total count reflects full input; scanned set is sliced to 10
    expect(report.stats.totalRecords).toBe(500);
    // Record r250 is beyond the scan window — must not appear in any issue
    expect(report.issues.some((i) => i.recordIds.includes("r250"))).toBe(false);
  });
});
