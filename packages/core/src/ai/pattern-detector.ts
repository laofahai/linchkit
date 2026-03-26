/**
 * AI Pattern Detection Engine
 *
 * Analyzes execution logs and data patterns to generate insights.
 * Rule-based/statistical analysis — no LLM required for detection.
 * LLM only used (optionally) for generating human-readable descriptions.
 *
 * Pattern types:
 * - repetitive_action: same action with similar inputs repeated frequently
 * - default_value: a field almost always has the same value
 * - validation_pattern: submitted data follows a consistent pattern
 * - state_flow: common paths through state machines
 * - timing: actions performed at specific times of day/week
 *
 * See spec 22_ai_rule_boundary.md §7 (Evolution Cycle).
 */

import type { ExecutionLogEntry, ExecutionLogger } from "../types/execution-log";
import type { ProposalDraft } from "./proposal-engine";

// ── Pattern insight types ────────────────────────────────

export type PatternType =
  | "repetitive_action"
  | "default_value"
  | "validation_pattern"
  | "state_flow"
  | "timing";

/** Evidence supporting a detected pattern */
export interface PatternEvidence {
  /** Number of occurrences observed */
  count: number;
  /** Human-readable timespan (e.g. "7 days", "30 days") */
  timespan: string;
  /** Sample data points illustrating the pattern */
  examples: unknown[];
}

/** A detected pattern insight ready for proposal generation */
export interface PatternInsight {
  /** Unique insight identifier */
  id: string;
  /** Type of pattern detected */
  type: PatternType;
  /** Schema name this pattern relates to */
  schema: string;
  /** Human-readable description of the pattern */
  description: string;
  /** Confidence score 0-1 */
  confidence: number;
  /** Supporting evidence */
  evidence: PatternEvidence;
  /** Suggested change based on this pattern */
  suggestedAction: ProposalDraft;
}

// ── Detector configuration ───────────────────────────────

export interface PatternDetectorConfig {
  /** Minimum number of occurrences to consider a pattern (default: 5) */
  minOccurrences?: number;
  /** Minimum confidence threshold to report a pattern (default: 0.7) */
  minConfidence?: number;
  /** Maximum number of days to look back (default: 30) */
  lookbackDays?: number;
  /** Maximum number of examples to include in evidence (default: 3) */
  maxExamples?: number;
  /** Pattern types to detect (default: all) */
  enabledPatterns?: PatternType[];
}

// ── Default configuration ────────────────────────────────

const DEFAULT_CONFIG: Required<PatternDetectorConfig> = {
  minOccurrences: 5,
  minConfidence: 0.7,
  lookbackDays: 30,
  maxExamples: 3,
  enabledPatterns: [
    "repetitive_action",
    "default_value",
    "validation_pattern",
    "state_flow",
    "timing",
  ],
};

// ── Pattern Detector ─────────────────────────────────────

export class PatternDetector {
  private readonly config: Required<PatternDetectorConfig>;
  private idCounter = 0;

  constructor(config?: PatternDetectorConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Analyze execution logs and detect all enabled pattern types.
   * Returns insights sorted by confidence (highest first).
   */
  async analyze(logger: ExecutionLogger): Promise<PatternInsight[]> {
    const since = new Date();
    since.setDate(since.getDate() - this.config.lookbackDays);
    const entries = await logger.findMany({
      since: since.toISOString(),
      status: "succeeded",
      pageSize: 1000,
    });

    const logs = entries.items;
    if (logs.length === 0) return [];

    const insights: PatternInsight[] = [];

    for (const patternType of this.config.enabledPatterns) {
      let detected: PatternInsight[];

      switch (patternType) {
        case "repetitive_action":
          detected = this.detectRepetitiveActions(logs);
          break;
        case "default_value":
          detected = this.detectDefaultValues(logs);
          break;
        case "validation_pattern":
          detected = this.detectValidationPatterns(logs);
          break;
        case "state_flow":
          detected = this.detectStateFlowPatterns(logs);
          break;
        case "timing":
          detected = this.detectTimingPatterns(logs);
          break;
        default:
          detected = [];
      }

      insights.push(...detected);
    }

    // Filter by minimum confidence and sort descending
    return insights
      .filter((i) => i.confidence >= this.config.minConfidence)
      .sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Analyze a specific schema's execution logs.
   */
  async analyzeSchema(
    logger: ExecutionLogger,
    schemaName: string,
  ): Promise<PatternInsight[]> {
    const since = new Date();
    since.setDate(since.getDate() - this.config.lookbackDays);
    const entries = await logger.findMany({
      schema: schemaName,
      since: since.toISOString(),
      status: "succeeded",
      pageSize: 1000,
    });

    const logs = entries.items;
    if (logs.length === 0) return [];

    const insights: PatternInsight[] = [];

    for (const patternType of this.config.enabledPatterns) {
      let detected: PatternInsight[];

      switch (patternType) {
        case "repetitive_action":
          detected = this.detectRepetitiveActions(logs);
          break;
        case "default_value":
          detected = this.detectDefaultValues(logs);
          break;
        case "validation_pattern":
          detected = this.detectValidationPatterns(logs);
          break;
        case "state_flow":
          detected = this.detectStateFlowPatterns(logs);
          break;
        case "timing":
          detected = this.detectTimingPatterns(logs);
          break;
        default:
          detected = [];
      }

      insights.push(...detected);
    }

    return insights
      .filter((i) => i.confidence >= this.config.minConfidence)
      .sort((a, b) => b.confidence - a.confidence);
  }

  // ── Repetitive Action Detection ────────────────────────

  /**
   * Detect when users repeatedly perform the same action with similar inputs.
   * E.g. always approving requests under $5000 → suggest automation rule.
   */
  private detectRepetitiveActions(logs: ExecutionLogEntry[]): PatternInsight[] {
    const insights: PatternInsight[] = [];

    // Group by action + actor
    const groups = new Map<string, ExecutionLogEntry[]>();
    for (const log of logs) {
      const key = `${log.action}::${log.actor.id}`;
      const group = groups.get(key);
      if (group) {
        group.push(log);
      } else {
        groups.set(key, [log]);
      }
    }

    for (const [key, entries] of groups) {
      if (entries.length < this.config.minOccurrences) continue;

      const [actionName] = key.split("::");
      const schema = entries[0].schema ?? "unknown";

      // Check for similar input patterns using field value frequency
      const fieldPatterns = this.analyzeInputSimilarity(entries);

      for (const pattern of fieldPatterns) {
        if (pattern.frequency < this.config.minConfidence) continue;

        const confidence = pattern.frequency;
        const timespan = this.calculateTimespan(entries);

        insights.push({
          id: this.nextId(),
          type: "repetitive_action",
          schema,
          description:
            `Action "${actionName}" is repeatedly executed with ${pattern.field} = ${JSON.stringify(pattern.commonValue)} ` +
            `(${Math.round(confidence * 100)}% of ${entries.length} executions over ${timespan})`,
          confidence,
          evidence: {
            count: entries.length,
            timespan,
            examples: entries.slice(0, this.config.maxExamples).map((e) => ({
              action: e.action,
              input: e.input,
              actor: e.actor.id,
              time: e.startedAt,
            })),
          },
          suggestedAction: {
            type: "add_rule",
            description: `Auto-apply "${actionName}" when ${pattern.field} = ${JSON.stringify(pattern.commonValue)}`,
            targetSchema: schema,
            details: {
              action: actionName,
              field: pattern.field,
              value: pattern.commonValue,
            },
          },
        });
      }
    }

    return insights;
  }

  // ── Default Value Detection ────────────────────────────

  /**
   * Detect when a field almost always has the same value.
   * E.g. currency is always "USD" → suggest setting it as default.
   */
  private detectDefaultValues(logs: ExecutionLogEntry[]): PatternInsight[] {
    const insights: PatternInsight[] = [];

    // Group by schema + action (create actions are most relevant)
    const schemaLogs = new Map<string, ExecutionLogEntry[]>();
    for (const log of logs) {
      if (!log.schema) continue;
      const group = schemaLogs.get(log.schema);
      if (group) {
        group.push(log);
      } else {
        schemaLogs.set(log.schema, [log]);
      }
    }

    for (const [schema, entries] of schemaLogs) {
      if (entries.length < this.config.minOccurrences) continue;

      // Collect field value frequencies from inputs
      const fieldValues = new Map<string, Map<string, number>>();

      for (const entry of entries) {
        for (const [field, value] of Object.entries(entry.input)) {
          if (value === undefined || value === null) continue;
          // Skip complex objects, only track primitives
          if (typeof value === "object") continue;

          let valueMap = fieldValues.get(field);
          if (!valueMap) {
            valueMap = new Map();
            fieldValues.set(field, valueMap);
          }
          const valueKey = String(value);
          valueMap.set(valueKey, (valueMap.get(valueKey) ?? 0) + 1);
        }
      }

      for (const [field, valueCounts] of fieldValues) {
        // Find the most common value
        let maxCount = 0;
        let maxValue = "";
        for (const [value, count] of valueCounts) {
          if (count > maxCount) {
            maxCount = count;
            maxValue = value;
          }
        }

        const frequency = maxCount / entries.length;
        if (frequency < this.config.minConfidence || maxCount < this.config.minOccurrences) {
          continue;
        }

        const timespan = this.calculateTimespan(entries);

        insights.push({
          id: this.nextId(),
          type: "default_value",
          schema,
          description:
            `Field "${field}" has value "${maxValue}" in ${Math.round(frequency * 100)}% of records ` +
            `(${maxCount}/${entries.length} over ${timespan})`,
          confidence: frequency,
          evidence: {
            count: maxCount,
            timespan,
            examples: entries
              .filter((e) => String(e.input[field]) === maxValue)
              .slice(0, this.config.maxExamples)
              .map((e) => ({ [field]: e.input[field], action: e.action })),
          },
          suggestedAction: {
            type: "modify_schema",
            description: `Set default value for "${field}" to "${maxValue}" in schema "${schema}"`,
            targetSchema: schema,
            details: { field, defaultValue: maxValue },
          },
        });
      }
    }

    return insights;
  }

  // ── Validation Pattern Detection ───────────────────────

  /**
   * Detect when submitted data consistently follows a pattern.
   * E.g. phone numbers always match a format → suggest validation rule.
   */
  private detectValidationPatterns(logs: ExecutionLogEntry[]): PatternInsight[] {
    const insights: PatternInsight[] = [];

    // Group by schema
    const schemaLogs = new Map<string, ExecutionLogEntry[]>();
    for (const log of logs) {
      if (!log.schema) continue;
      const group = schemaLogs.get(log.schema);
      if (group) {
        group.push(log);
      } else {
        schemaLogs.set(log.schema, [log]);
      }
    }

    for (const [schema, entries] of schemaLogs) {
      if (entries.length < this.config.minOccurrences) continue;

      // Collect string field values
      const fieldStrings = new Map<string, string[]>();
      for (const entry of entries) {
        for (const [field, value] of Object.entries(entry.input)) {
          if (typeof value !== "string" || value.length === 0) continue;
          let arr = fieldStrings.get(field);
          if (!arr) {
            arr = [];
            fieldStrings.set(field, arr);
          }
          arr.push(value);
        }
      }

      for (const [field, values] of fieldStrings) {
        if (values.length < this.config.minOccurrences) continue;

        // Check common patterns
        const patterns = this.detectStringPatterns(values);
        for (const pattern of patterns) {
          if (pattern.matchRate < this.config.minConfidence) continue;

          const timespan = this.calculateTimespan(entries);

          insights.push({
            id: this.nextId(),
            type: "validation_pattern",
            schema,
            description:
              `Field "${field}" consistently matches pattern "${pattern.name}" ` +
              `(${Math.round(pattern.matchRate * 100)}% of ${values.length} values)`,
            confidence: pattern.matchRate,
            evidence: {
              count: values.length,
              timespan,
              examples: values.slice(0, this.config.maxExamples),
            },
            suggestedAction: {
              type: "add_rule",
              description: `Add validation rule for "${field}": must match ${pattern.name} format`,
              targetSchema: schema,
              details: {
                field,
                pattern: pattern.regex,
                patternName: pattern.name,
              },
            },
          });
        }
      }
    }

    return insights;
  }

  // ── State Flow Pattern Detection ───────────────────────

  /**
   * Detect common paths through state machines.
   * E.g. 90% of records go draft → submitted → approved → done.
   */
  private detectStateFlowPatterns(logs: ExecutionLogEntry[]): PatternInsight[] {
    const insights: PatternInsight[] = [];

    // Collect state transitions grouped by schema + record, with timestamps for ordering
    const transitions = new Map<string, Array<{ from: string; to: string; action: string; time: number }>>();

    for (const log of logs) {
      if (!log.stateTransition || !log.schema || !log.recordId) continue;

      const key = `${log.schema}::${log.recordId}`;
      let list = transitions.get(key);
      if (!list) {
        list = [];
        transitions.set(key, list);
      }
      list.push({
        from: log.stateTransition.from,
        to: log.stateTransition.to,
        action: log.action,
        time: log.startedAt.getTime(),
      });
    }

    // Group by schema and build transition path frequencies
    const schemaPaths = new Map<string, Map<string, number>>();
    for (const [key, trans] of transitions) {
      const schema = key.split("::")[0];
      let pathMap = schemaPaths.get(schema);
      if (!pathMap) {
        pathMap = new Map();
        schemaPaths.set(schema, pathMap);
      }
      // Sort transitions by time ascending to build correct path
      trans.sort((a, b) => a.time - b.time);
      // Build path string: "draft→submitted→approved→done"
      const states = [trans[0].from, ...trans.map((t) => t.to)];
      const pathStr = states.join("→");
      pathMap.set(pathStr, (pathMap.get(pathStr) ?? 0) + 1);
    }

    for (const [schema, pathMap] of schemaPaths) {
      const totalRecords = Array.from(pathMap.values()).reduce((a, b) => a + b, 0);
      if (totalRecords < this.config.minOccurrences) continue;

      // Find the dominant path
      let maxCount = 0;
      let dominantPath = "";
      for (const [path, count] of pathMap) {
        if (count > maxCount) {
          maxCount = count;
          dominantPath = path;
        }
      }

      const frequency = maxCount / totalRecords;
      if (frequency < this.config.minConfidence) continue;

      const allLogs = logs.filter((l) => l.schema === schema && l.stateTransition);
      const timespan = this.calculateTimespan(allLogs);

      insights.push({
        id: this.nextId(),
        type: "state_flow",
        schema,
        description:
          `${Math.round(frequency * 100)}% of "${schema}" records follow the path: ${dominantPath} ` +
          `(${maxCount}/${totalRecords} records over ${timespan})`,
        confidence: frequency,
        evidence: {
          count: maxCount,
          timespan,
          examples: Array.from(pathMap.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, this.config.maxExamples)
            .map(([path, count]) => ({ path, count, percentage: Math.round((count / totalRecords) * 100) })),
        },
        suggestedAction: {
          type: "add_automation",
          description: `Consider automating the common flow: ${dominantPath} for schema "${schema}"`,
          targetSchema: schema,
          details: {
            path: dominantPath,
            steps: dominantPath.split("→"),
          },
        },
      });
    }

    return insights;
  }

  // ── Timing Pattern Detection ───────────────────────────

  /**
   * Detect when actions are typically performed at certain times.
   * E.g. "approve_request" is always done between 9-10am → suggest scheduled batch.
   */
  private detectTimingPatterns(logs: ExecutionLogEntry[]): PatternInsight[] {
    const insights: PatternInsight[] = [];

    // Group by action
    const actionLogs = new Map<string, ExecutionLogEntry[]>();
    for (const log of logs) {
      const group = actionLogs.get(log.action);
      if (group) {
        group.push(log);
      } else {
        actionLogs.set(log.action, [log]);
      }
    }

    for (const [action, entries] of actionLogs) {
      if (entries.length < this.config.minOccurrences) continue;
      const schema = entries[0].schema ?? "unknown";

      // Analyze hour-of-day distribution
      const hourCounts = new Array<number>(24).fill(0);
      for (const entry of entries) {
        const hour = entry.startedAt.getHours();
        hourCounts[hour]++;
      }

      // Find peak hours (consecutive hours with > 60% of total)
      const totalCount = entries.length;
      const peakHours = this.findPeakWindow(hourCounts, totalCount);

      if (peakHours && peakHours.concentration >= this.config.minConfidence) {
        const timespan = this.calculateTimespan(entries);

        insights.push({
          id: this.nextId(),
          type: "timing",
          schema,
          description:
            `Action "${action}" is concentrated between ${peakHours.startHour}:00-${peakHours.endHour}:00 ` +
            `(${Math.round(peakHours.concentration * 100)}% of ${totalCount} executions over ${timespan})`,
          confidence: peakHours.concentration,
          evidence: {
            count: totalCount,
            timespan,
            examples: [
              {
                peakHours: `${peakHours.startHour}:00 - ${peakHours.endHour}:00`,
                executionsInPeak: peakHours.countInPeak,
                totalExecutions: totalCount,
                hourDistribution: hourCounts.reduce(
                  (acc, count, hour) => {
                    if (count > 0) acc[`${hour}:00`] = count;
                    return acc;
                  },
                  {} as Record<string, number>,
                ),
              },
            ],
          },
          suggestedAction: {
            type: "add_automation",
            description:
              `Consider scheduling "${action}" as a batch job at ${peakHours.startHour}:00`,
            targetSchema: schema,
            details: {
              action,
              suggestedCron: `0 ${peakHours.startHour} * * *`,
              peakHours: { start: peakHours.startHour, end: peakHours.endHour },
            },
          },
        });
      }

      // Analyze day-of-week distribution
      const dayCounts = new Array<number>(7).fill(0);
      for (const entry of entries) {
        const day = entry.startedAt.getDay();
        dayCounts[day]++;
      }

      // Check if action is concentrated on specific days
      const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      const peakDays = this.findPeakDays(dayCounts, totalCount);

      if (peakDays && peakDays.concentration >= this.config.minConfidence) {
        const timespan = this.calculateTimespan(entries);
        const dayStr = peakDays.days.map((d) => dayNames[d]).join(", ");

        insights.push({
          id: this.nextId(),
          type: "timing",
          schema,
          description:
            `Action "${action}" is concentrated on ${dayStr} ` +
            `(${Math.round(peakDays.concentration * 100)}% of ${totalCount} executions)`,
          confidence: peakDays.concentration,
          evidence: {
            count: totalCount,
            timespan,
            examples: [
              {
                peakDays: dayStr,
                dayDistribution: dayCounts.reduce(
                  (acc, count, day) => {
                    if (count > 0) acc[dayNames[day]] = count;
                    return acc;
                  },
                  {} as Record<string, number>,
                ),
              },
            ],
          },
          suggestedAction: {
            type: "add_automation",
            description: `Consider automating "${action}" on ${dayStr}`,
            targetSchema: schema,
            details: {
              action,
              peakDays: peakDays.days,
              suggestedCron: `0 9 * * ${peakDays.days.join(",")}`,
            },
          },
        });
      }
    }

    return insights;
  }

  // ── Private helpers ────────────────────────────────────

  /** Analyze input field similarity across execution entries */
  private analyzeInputSimilarity(
    entries: ExecutionLogEntry[],
  ): Array<{ field: string; commonValue: unknown; frequency: number }> {
    const results: Array<{ field: string; commonValue: unknown; frequency: number }> = [];

    // Collect all field values
    const fieldValues = new Map<string, Map<string, { value: unknown; count: number }>>();

    for (const entry of entries) {
      for (const [field, value] of Object.entries(entry.input)) {
        if (value === undefined || value === null) continue;
        if (typeof value === "object") continue;

        let valueMap = fieldValues.get(field);
        if (!valueMap) {
          valueMap = new Map();
          fieldValues.set(field, valueMap);
        }
        const key = String(value);
        const existing = valueMap.get(key);
        if (existing) {
          existing.count++;
        } else {
          valueMap.set(key, { value, count: 1 });
        }
      }
    }

    for (const [field, valueMap] of fieldValues) {
      // Find most common value
      let maxEntry: { value: unknown; count: number } | undefined;
      for (const entry of valueMap.values()) {
        if (!maxEntry || entry.count > maxEntry.count) {
          maxEntry = entry;
        }
      }

      if (maxEntry && maxEntry.count >= this.config.minOccurrences) {
        results.push({
          field,
          commonValue: maxEntry.value,
          frequency: maxEntry.count / entries.length,
        });
      }
    }

    return results;
  }

  /** Detect common string format patterns */
  private detectStringPatterns(
    values: string[],
  ): Array<{ name: string; regex: string; matchRate: number }> {
    const patterns: Array<{ name: string; regex: RegExp; regexStr: string }> = [
      { name: "email", regex: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, regexStr: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$" },
      { name: "phone", regex: /^\+?[\d\s\-()]{7,15}$/, regexStr: "^\\+?[\\d\\s\\-()]{7,15}$" },
      { name: "url", regex: /^https?:\/\/.+$/, regexStr: "^https?://.+$" },
      { name: "uuid", regex: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, regexStr: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" },
      { name: "date_iso", regex: /^\d{4}-\d{2}-\d{2}$/, regexStr: "^\\d{4}-\\d{2}-\\d{2}$" },
      { name: "numeric_string", regex: /^\d+$/, regexStr: "^\\d+$" },
      { name: "uppercase", regex: /^[A-Z][A-Z0-9_\-]+$/, regexStr: "^[A-Z][A-Z0-9_\\-]+$" },
    ];

    const results: Array<{ name: string; regex: string; matchRate: number }> = [];

    for (const pattern of patterns) {
      const matchCount = values.filter((v) => pattern.regex.test(v)).length;
      const matchRate = matchCount / values.length;
      if (matchRate >= this.config.minConfidence) {
        results.push({ name: pattern.name, regex: pattern.regexStr, matchRate });
      }
    }

    return results;
  }

  /** Find a peak window of consecutive hours containing a high % of actions */
  private findPeakWindow(
    hourCounts: number[],
    total: number,
  ): { startHour: number; endHour: number; concentration: number; countInPeak: number } | null {
    if (total === 0) return null;

    // Try windows of 1-4 hours
    let best: { startHour: number; endHour: number; concentration: number; countInPeak: number } | null = null;

    for (let windowSize = 1; windowSize <= 4; windowSize++) {
      for (let start = 0; start < 24; start++) {
        let count = 0;
        for (let i = 0; i < windowSize; i++) {
          count += hourCounts[(start + i) % 24];
        }
        const concentration = count / total;
        if (!best || concentration > best.concentration) {
          best = {
            startHour: start,
            endHour: (start + windowSize) % 24,
            concentration,
            countInPeak: count,
          };
        }
      }
    }

    return best;
  }

  /** Find peak days of the week with high concentration */
  private findPeakDays(
    dayCounts: number[],
    total: number,
  ): { days: number[]; concentration: number } | null {
    if (total === 0) return null;

    // Sort days by count and find minimal set covering > minConfidence
    const sorted = dayCounts
      .map((count, day) => ({ day, count }))
      .filter((d) => d.count > 0)
      .sort((a, b) => b.count - a.count);

    let accumulated = 0;
    const peakDays: number[] = [];
    for (const entry of sorted) {
      accumulated += entry.count;
      peakDays.push(entry.day);
      const concentration = accumulated / total;
      // Only report if we need at most 3 days to cover the threshold
      if (concentration >= this.config.minConfidence && peakDays.length <= 3) {
        return { days: peakDays.sort((a, b) => a - b), concentration };
      }
    }

    return null;
  }

  /** Calculate human-readable timespan from log entries */
  private calculateTimespan(entries: ExecutionLogEntry[]): string {
    if (entries.length < 2) return "1 day";

    const dates = entries.map((e) => e.startedAt.getTime());
    const minDate = Math.min(...dates);
    const maxDate = Math.max(...dates);
    const diffMs = maxDate - minDate;
    const diffDays = Math.max(1, Math.round(diffMs / (1000 * 60 * 60 * 24)));

    if (diffDays === 1) return "1 day";
    if (diffDays < 7) return `${diffDays} days`;
    if (diffDays < 30) return `${Math.round(diffDays / 7)} weeks`;
    return `${Math.round(diffDays / 30)} months`;
  }

  /** Generate a unique insight ID */
  private nextId(): string {
    this.idCounter++;
    return `insight-${Date.now()}-${this.idCounter}`;
  }
}
