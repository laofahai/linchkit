/**
 * Data Quality Scanner — Rule-based quality checks for entity record sets.
 *
 * Implements Spec 52 §4 quality checks without AI:
 *   - completeness: required fields null/empty
 *   - freshness:    records stuck in a state beyond a threshold
 *   - outlier:      numeric fields with z-score > OUTLIER_Z_THRESHOLD
 *   - referential:  FK-style fields (name ends with _id) that are null on a required field
 *
 * The full Spec 52 suite (consistency, duplicates) requires AI or cross-record
 * fuzzy matching and is out of scope for this rule-based phase.
 */

import type { EntityDefinition, FieldDefinition } from "../types/entity";

// ── Public types (mirror Spec 52 §4.2) ─────────────────────

export interface DataQualityIssue {
  type: "completeness" | "consistency" | "outlier" | "duplicate" | "freshness" | "referential";
  severity: "low" | "medium" | "high";
  recordIds: string[];
  fields?: string[];
  description: string;
  suggestedFix?: {
    action: string;
    input: Record<string, unknown>;
    description: string;
  };
}

export interface DataQualityReport {
  schemaName: string;
  score: number;
  issues: DataQualityIssue[];
  stats: {
    totalRecords: number;
    issueCount: number;
    byType: Record<string, number>;
    bySeverity: Record<string, number>;
  };
  scannedAt: Date;
}

export interface DataQualityScanOptions {
  /** Max age (ms) before an unchanged record is flagged as stale. Default: 30 days. */
  freshnessThresholdMs?: number;
  /** Z-score cutoff for numeric outlier detection. Default: 3. */
  outlierZThreshold?: number;
  /** Maximum records to scan. Default: 1000. */
  maxRecords?: number;
}

// ── Constants ───────────────────────────────────────────────

const DEFAULT_FRESHNESS_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const DEFAULT_OUTLIER_Z_THRESHOLD = 3;
const DEFAULT_MAX_RECORDS = 1000;

// ── Helpers ─────────────────────────────────────────────────

function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string" && value.trim() === "") return true;
  return false;
}

function computeZScore(value: number, mean: number, std: number): number {
  if (std === 0) return 0;
  return Math.abs((value - mean) / std);
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stddev(values: number[], avg: number): number {
  if (values.length < 2) return 0;
  const variance = values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

// ── Scoring ─────────────────────────────────────────────────

/**
 * Compute quality score 0–100 from issue list.
 * Deductions are severity-weighted and capped so one category can't dominate.
 */
function computeScore(issues: DataQualityIssue[], totalRecords: number): number {
  if (totalRecords === 0) return 100;

  let deduction = 0;
  const highCount = issues.filter((i) => i.severity === "high").length;
  const medCount = issues.filter((i) => i.severity === "medium").length;
  const lowCount = issues.filter((i) => i.severity === "low").length;

  // Weight deductions relative to record count to keep scores meaningful at scale
  const recordFactor = Math.min(1, 100 / Math.max(1, totalRecords));
  deduction += Math.min(50, highCount * 5 * recordFactor * 100);
  deduction += Math.min(30, medCount * 2 * recordFactor * 100);
  deduction += Math.min(20, lowCount * 0.5 * recordFactor * 100);

  return Math.max(0, Math.round(100 - deduction));
}

// ── Individual checks ───────────────────────────────────────

function checkCompleteness(
  records: Record<string, unknown>[],
  entityDef: EntityDefinition,
): DataQualityIssue[] {
  const requiredFields = Object.entries(entityDef.fields)
    .filter(([, def]: [string, FieldDefinition]) => def.required === true)
    .map(([name]) => name);

  if (requiredFields.length === 0) return [];

  const issues: DataQualityIssue[] = [];

  for (const field of requiredFields) {
    const affected = records.filter((r) => isBlank(r[field])).map((r) => String(r.id ?? ""));

    if (affected.length === 0) continue;

    const ratio = affected.length / records.length;
    const severity: DataQualityIssue["severity"] =
      ratio > 0.3 ? "high" : ratio > 0.05 ? "medium" : "low";

    issues.push({
      type: "completeness",
      severity,
      recordIds: affected,
      fields: [field],
      description: `${affected.length} record(s) have required field "${field}" empty or null (${Math.round(ratio * 100)}% of total).`,
    });
  }

  return issues;
}

function checkFreshness(
  records: Record<string, unknown>[],
  entityDef: EntityDefinition,
  thresholdMs: number,
): DataQualityIssue[] {
  // Only applicable to entities with a state/status field and an updated_at timestamp
  const hasStateField = Object.entries(entityDef.fields).some(
    ([name, def]: [string, FieldDefinition]) =>
      def.type === "state" || name === "status" || name === "state",
  );
  if (!hasStateField) return [];

  const now = Date.now();
  const stale = records.filter((r) => {
    const updatedAt = r.updated_at ?? r.updatedAt;
    if (!updatedAt) return false;
    const ts =
      updatedAt instanceof Date ? updatedAt.getTime() : new Date(String(updatedAt)).getTime();
    return now - ts > thresholdMs;
  });

  if (stale.length === 0) return [];

  const ratio = stale.length / records.length;
  const severity: DataQualityIssue["severity"] =
    ratio > 0.5 ? "high" : ratio > 0.2 ? "medium" : "low";
  const thresholdDays = Math.round(thresholdMs / (24 * 60 * 60 * 1000));

  return [
    {
      type: "freshness",
      severity,
      recordIds: stale.map((r) => String(r.id ?? "")),
      description: `${stale.length} record(s) have not been updated in over ${thresholdDays} days.`,
    },
  ];
}

function checkOutliers(
  records: Record<string, unknown>[],
  entityDef: EntityDefinition,
  zThreshold: number,
): DataQualityIssue[] {
  const numericFields = Object.entries(entityDef.fields)
    .filter(([, def]: [string, FieldDefinition]) => def.type === "number")
    .map(([name]) => name);

  if (numericFields.length === 0 || records.length < 5) return [];

  const issues: DataQualityIssue[] = [];

  for (const field of numericFields) {
    const values: Array<{ id: string; value: number }> = [];
    for (const r of records) {
      const v = r[field];
      if (typeof v === "number" && Number.isFinite(v)) {
        values.push({ id: String(r.id ?? ""), value: v });
      }
    }
    if (values.length < 5) continue;

    const nums = values.map((v) => v.value);
    const avg = mean(nums);
    const std = stddev(nums, avg);
    if (std === 0) continue;

    const outliers = values.filter((v) => computeZScore(v.value, avg, std) > zThreshold);
    if (outliers.length === 0) continue;

    issues.push({
      type: "outlier",
      severity: "medium",
      recordIds: outliers.map((o) => o.id),
      fields: [field],
      description: `${outliers.length} record(s) have statistically extreme values for "${field}" (z-score > ${zThreshold}, mean=${avg.toFixed(2)}, std=${std.toFixed(2)}).`,
    });
  }

  return issues;
}

function checkReferential(
  records: Record<string, unknown>[],
  entityDef: EntityDefinition,
): DataQualityIssue[] {
  // Flag FK-style fields (string fields ending in _id) that hold invalid placeholder values.
  // Non-required fields are targeted here; required blanks are caught by completeness.
  const refFields = Object.entries(entityDef.fields)
    .filter(([name, def]: [string, FieldDefinition]) => {
      if (def.required) return false; // already handled by completeness
      return name.endsWith("_id") && def.type === "string";
    })
    .map(([name]) => name);

  if (refFields.length === 0) return [];

  const issues: DataQualityIssue[] = [];

  for (const field of refFields) {
    // Flag records where the field is non-null but looks like an empty placeholder
    const suspicious = records.filter((r) => {
      const v = r[field];
      if (v === null || v === undefined) return false; // null is fine for non-required refs
      if (typeof v === "string" && (v === "" || v === "null" || v === "undefined")) return true;
      return false;
    });

    if (suspicious.length === 0) continue;

    issues.push({
      type: "referential",
      severity: "low",
      recordIds: suspicious.map((r) => String(r.id ?? "")),
      fields: [field],
      description: `${suspicious.length} record(s) have an invalid placeholder value for reference field "${field}".`,
    });
  }

  return issues;
}

// ── Main Entry Point ────────────────────────────────────────

/**
 * Scan a set of pre-fetched records for data quality issues.
 * All checks are rule-based (no AI calls).
 */
export function scanDataQuality(
  records: Record<string, unknown>[],
  entityDef: EntityDefinition,
  options: DataQualityScanOptions = {},
): DataQualityReport {
  const {
    freshnessThresholdMs = DEFAULT_FRESHNESS_THRESHOLD_MS,
    outlierZThreshold = DEFAULT_OUTLIER_Z_THRESHOLD,
    maxRecords = DEFAULT_MAX_RECORDS,
  } = options;

  const sample = records.slice(0, maxRecords);
  const totalRecords = records.length;

  const issues: DataQualityIssue[] = [
    ...checkCompleteness(sample, entityDef),
    ...checkFreshness(sample, entityDef, freshnessThresholdMs),
    ...checkOutliers(sample, entityDef, outlierZThreshold),
    ...checkReferential(sample, entityDef),
  ];

  const byType: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  for (const issue of issues) {
    byType[issue.type] = (byType[issue.type] ?? 0) + 1;
    bySeverity[issue.severity] = (bySeverity[issue.severity] ?? 0) + 1;
  }

  return {
    schemaName: entityDef.name,
    score: computeScore(issues, totalRecords),
    issues,
    stats: {
      totalRecords,
      issueCount: issues.length,
      byType,
      bySeverity,
    },
    scannedAt: new Date(),
  };
}
