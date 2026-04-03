/**
 * VersionHistoryPanel — Record version history with field-level diffs.
 *
 * Reconstructs version snapshots from execution logs (create/update actions).
 * Shows a timeline of versions, per-field diffs, side-by-side comparison mode,
 * and restore-to-version functionality.
 *
 * Data source: execution logs filtered by record ID. Each create/update action
 * log entry contains the `input` fields, which are used to compute deltas.
 */

import type { FieldDefinition } from "@linchkit/core/types";
import { Badge, Button, Checkbox, Separator, Skeleton } from "@linchkit/ui-kit/components";
import { cn } from "@linchkit/ui-kit/lib/utils";
import {
  ArrowRight,
  ChevronDown,
  ChevronUp,
  Clock,
  Columns2,
  GitCompare,
  History,
  Loader2,
  RefreshCw,
  RotateCcw,
  User,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { type ExecutionLogEntry, queryExecutionLogs, updateRecord } from "../lib/api";

// ── Types ────────────────────────────────────────────────

interface VersionHistoryPanelProps {
  schemaName: string;
  recordId: string;
  /** Current record data for building the latest snapshot */
  currentRecord?: Record<string, unknown>;
  /** Schema fields for labels and type info */
  fields?: Record<string, FieldDefinition>;
  /** GraphQL field names for the update mutation */
  recordFields?: string[];
  /** Callback after a version restore, to refresh the parent form */
  onRestore?: () => void;
}

/** A reconstructed version snapshot */
interface VersionSnapshot {
  /** Version number (1 = creation) */
  version: number;
  /** Execution log entry that produced this version */
  entry: ExecutionLogEntry;
  /** Cumulative field values at this point in time */
  snapshot: Record<string, unknown>;
  /** Fields changed in this specific version (delta from previous) */
  changedFields: string[];
}

/** A single field-level diff between two versions */
interface FieldDiff {
  field: string;
  label: string;
  oldValue: unknown;
  newValue: unknown;
  changed: boolean;
}

// ── Constants ────────────────────────────────────────────

const SYSTEM_FIELDS = new Set([
  "id",
  "tenant_id",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
  "_version",
  "is_deleted",
]);

// ── Helpers ──────────────────────────────────────────────

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString();
}

function formatRelativeTime(
  iso: string,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return t("time.justNow", { defaultValue: "just now" });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t("time.minutesAgo", { defaultValue: "{{count}}m ago", count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("time.hoursAgo", { defaultValue: "{{count}}h ago", count: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return t("time.daysAgo", { defaultValue: "{{count}}d ago", count: days });
  return new Date(iso).toLocaleDateString();
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function parseInput(input: string | undefined): Record<string, unknown> {
  if (!input) return {};
  try {
    return JSON.parse(input) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function isCreateAction(action: string): boolean {
  return action.startsWith("create_");
}

function isUpdateAction(action: string): boolean {
  return action.startsWith("update_");
}

/** Build version snapshots from execution log entries (oldest first). */
function buildVersions(
  entries: ExecutionLogEntry[],
  currentRecord?: Record<string, unknown>,
): VersionSnapshot[] {
  // Sort chronologically (oldest first)
  const sorted = [...entries].sort(
    (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime(),
  );

  const versions: VersionSnapshot[] = [];
  const cumulative: Record<string, unknown> = {};

  for (const entry of sorted) {
    if (entry.status !== "succeeded") continue;
    if (!isCreateAction(entry.action) && !isUpdateAction(entry.action)) continue;

    const input = parseInput(entry.input);
    const changedFields: string[] = [];

    for (const [key, value] of Object.entries(input)) {
      if (SYSTEM_FIELDS.has(key)) continue;
      // Track what actually changed
      if (formatValue(cumulative[key]) !== formatValue(value)) {
        changedFields.push(key);
      }
    }

    // Merge input into cumulative snapshot
    for (const [key, value] of Object.entries(input)) {
      if (!SYSTEM_FIELDS.has(key)) {
        cumulative[key] = value;
      }
    }

    versions.push({
      version: versions.length + 1,
      entry,
      snapshot: { ...cumulative },
      changedFields,
    });
  }

  // If we have a current record and versions, add implicit "current" if
  // the last version snapshot differs from current record
  if (currentRecord && versions.length > 0) {
    const lastSnapshot = versions[versions.length - 1]?.snapshot ?? {};
    const currentDiffs: string[] = [];
    for (const [key, value] of Object.entries(currentRecord)) {
      if (SYSTEM_FIELDS.has(key)) continue;
      if (formatValue(lastSnapshot[key]) !== formatValue(value)) {
        currentDiffs.push(key);
      }
    }
    // Update the last version's snapshot with current record values
    // to keep it fresh (execution log input may not contain all fields)
    if (currentDiffs.length === 0) {
      // Patch the last snapshot to include any fields from currentRecord
      // that weren't in the execution logs
      const patched = { ...versions[versions.length - 1]?.snapshot };
      for (const [key, value] of Object.entries(currentRecord)) {
        if (!SYSTEM_FIELDS.has(key) && !(key in patched)) {
          patched[key] = value;
        }
      }
      const lastVersion = versions[versions.length - 1];
      if (lastVersion) lastVersion.snapshot = patched;
    }
  }

  return versions;
}

/** Compute field-by-field diffs between two version snapshots. */
function computeDiffs(
  oldSnapshot: Record<string, unknown>,
  newSnapshot: Record<string, unknown>,
  fields?: Record<string, FieldDefinition>,
): FieldDiff[] {
  const allKeys = new Set([...Object.keys(oldSnapshot), ...Object.keys(newSnapshot)]);
  const diffs: FieldDiff[] = [];

  for (const key of allKeys) {
    if (SYSTEM_FIELDS.has(key)) continue;
    const oldVal = oldSnapshot[key];
    const newVal = newSnapshot[key];
    const changed = formatValue(oldVal) !== formatValue(newVal);
    diffs.push({
      field: key,
      label: fields?.[key]?.label ?? key,
      oldValue: oldVal,
      newValue: newVal,
      changed,
    });
  }

  return diffs;
}

// ── Version Entry Component ──────────────────────────────

interface VersionEntryProps {
  version: VersionSnapshot;
  fields?: Record<string, FieldDefinition>;
  previousSnapshot: Record<string, unknown>;
  isSelected: boolean;
  onToggleSelect: () => void;
  compareMode: boolean;
  onRestore?: () => void;
  restoring: boolean;
}

function VersionEntry({
  version,
  fields,
  previousSnapshot,
  isSelected,
  onToggleSelect,
  compareMode,
  onRestore,
  restoring,
}: VersionEntryProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const isCreate = isCreateAction(version.entry.action);
  const diffs = useMemo(
    () => computeDiffs(previousSnapshot, version.snapshot, fields),
    [previousSnapshot, version.snapshot, fields],
  );
  const changedDiffs = diffs.filter((d) => d.changed);

  return (
    <div
      className={cn(
        "rounded-md border px-4 py-3 transition-colors",
        isSelected
          ? "border-primary/50 bg-primary/5"
          : "border-border/50 bg-background hover:bg-muted/30",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0 flex-1">
          {/* Compare checkbox */}
          {compareMode && (
            <Checkbox checked={isSelected} onCheckedChange={onToggleSelect} className="mt-0.5" />
          )}

          <div className="min-w-0 flex-1">
            {/* Version header */}
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant={isCreate ? "default" : "secondary"} className="text-xs">
                {isCreate ? t("versionHistory.created", "Created") : `v${version.version}`}
              </Badge>
              {changedDiffs.length > 0 && !isCreate && (
                <span className="text-xs text-muted-foreground">
                  {t("versionHistory.fieldsChanged", "{{count}} field(s) changed", {
                    count: changedDiffs.length,
                  })}
                </span>
              )}
            </div>

            {/* Actor + timestamp */}
            <div className="flex items-center gap-1.5 mt-1 text-xs text-muted-foreground">
              <User className="size-3" />
              <span>{version.entry.actor.id}</span>
              <span className="text-border">·</span>
              <Clock className="size-3" />
              <span title={formatTimestamp(version.entry.startedAt)}>
                {formatRelativeTime(version.entry.startedAt, t)}
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {/* Restore button */}
          {onRestore && !isCreate && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={onRestore}
              disabled={restoring}
            >
              {restoring ? (
                <Loader2 className="size-3 animate-spin mr-1" />
              ) : (
                <RotateCcw className="size-3 mr-1" />
              )}
              {t("versionHistory.restore", "Restore")}
            </Button>
          )}

          {/* Expand toggle */}
          {changedDiffs.length > 0 && (
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              className="p-1 rounded hover:bg-muted/50 text-muted-foreground transition-colors"
            >
              {expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
            </button>
          )}
        </div>
      </div>

      {/* Expanded diff table */}
      {expanded && changedDiffs.length > 0 && (
        <div className="mt-3 rounded border border-border/50 bg-muted/20 overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border/50 bg-muted/40">
                <th className="text-left px-2.5 py-1.5 font-medium text-muted-foreground w-1/4">
                  {t("versionHistory.field", "Field")}
                </th>
                <th className="text-left px-2.5 py-1.5 font-medium text-muted-foreground w-[37.5%]">
                  {t("versionHistory.oldValue", "Old Value")}
                </th>
                <th className="text-left px-2.5 py-1.5 font-medium text-muted-foreground w-[37.5%]">
                  {t("versionHistory.newValue", "New Value")}
                </th>
              </tr>
            </thead>
            <tbody>
              {changedDiffs.map((diff) => (
                <tr key={diff.field} className="border-b border-border/30 last:border-0">
                  <td className="px-2.5 py-1.5 font-mono text-muted-foreground">{diff.label}</td>
                  <td className="px-2.5 py-1.5">
                    {isCreate ? (
                      <span className="text-muted-foreground/50">-</span>
                    ) : (
                      <span className="text-red-600 dark:text-red-400 line-through">
                        {formatValue(diff.oldValue)}
                      </span>
                    )}
                  </td>
                  <td className="px-2.5 py-1.5">
                    <span className="text-green-600 dark:text-green-400">
                      {formatValue(diff.newValue)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Compare View Component ───────────────────────────────

interface CompareViewProps {
  leftVersion: VersionSnapshot;
  rightVersion: VersionSnapshot;
  fields?: Record<string, FieldDefinition>;
  onClose: () => void;
}

function CompareView({ leftVersion, rightVersion, fields, onClose }: CompareViewProps) {
  const { t } = useTranslation();
  const diffs = useMemo(
    () => computeDiffs(leftVersion.snapshot, rightVersion.snapshot, fields),
    [leftVersion.snapshot, rightVersion.snapshot, fields],
  );

  return (
    <div className="space-y-3">
      {/* Compare header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm">
          <GitCompare className="size-4 text-muted-foreground" />
          <Badge variant="outline">v{leftVersion.version}</Badge>
          <ArrowRight className="size-3 text-muted-foreground" />
          <Badge variant="outline">v{rightVersion.version}</Badge>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t("common.close", "Close")}
        </Button>
      </div>

      {/* Diff table */}
      <div className="rounded border border-border/50 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="text-left px-3 py-2 font-medium text-muted-foreground w-1/4">
                {t("versionHistory.field", "Field")}
              </th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground w-[37.5%]">
                v{leftVersion.version}
              </th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground w-[37.5%]">
                v{rightVersion.version}
              </th>
            </tr>
          </thead>
          <tbody>
            {diffs.map((diff) => (
              <tr
                key={diff.field}
                className={cn(
                  "border-b last:border-0",
                  diff.changed ? "bg-amber-50/50 dark:bg-amber-950/20" : "",
                )}
              >
                <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{diff.label}</td>
                <td className="px-3 py-2 text-xs">
                  <span className={diff.changed ? "text-red-600 dark:text-red-400" : ""}>
                    {formatValue(diff.oldValue)}
                  </span>
                </td>
                <td className="px-3 py-2 text-xs">
                  <span className={diff.changed ? "text-green-600 dark:text-green-400" : ""}>
                    {formatValue(diff.newValue)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Main Panel Component ─────────────────────────────────

export function VersionHistoryPanel({
  schemaName,
  recordId,
  currentRecord,
  fields,
  recordFields,
  onRestore,
}: VersionHistoryPanelProps) {
  const { t } = useTranslation();
  const [versions, setVersions] = useState<VersionSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState(false);
  const [compareMode, setCompareMode] = useState(false);
  const [selectedVersions, setSelectedVersions] = useState<Set<number>>(new Set());
  const [showCompare, setShowCompare] = useState(false);

  const fetchVersions = useCallback(async () => {
    setLoading(true);
    try {
      const result = await queryExecutionLogs({
        schema: schemaName,
        page: 1,
        pageSize: 100,
      });
      // Filter by recordId
      const filtered = result.items.filter((e) => e.recordId === recordId);
      const built = buildVersions(filtered, currentRecord);
      setVersions(built);
    } catch {
      setVersions([]);
    } finally {
      setLoading(false);
    }
  }, [schemaName, recordId, currentRecord]);

  useEffect(() => {
    fetchVersions();
  }, [fetchVersions]);

  // Toggle version selection for compare
  const toggleSelect = useCallback((versionNum: number) => {
    setSelectedVersions((prev) => {
      const next = new Set(prev);
      if (next.has(versionNum)) {
        next.delete(versionNum);
      } else {
        // Max 2 selections
        if (next.size >= 2) {
          // Replace the smallest one
          const sorted = [...next].sort((a, b) => a - b);
          const first = sorted[0];
          if (first !== undefined) next.delete(first);
        }
        next.add(versionNum);
      }
      return next;
    });
  }, []);

  // Start comparison
  const handleCompare = useCallback(() => {
    if (selectedVersions.size === 2) {
      setShowCompare(true);
    }
  }, [selectedVersions]);

  // Restore to a specific version
  const handleRestore = useCallback(
    async (version: VersionSnapshot) => {
      if (!recordFields || recordFields.length === 0) return;
      setRestoring(true);
      try {
        // Build input from the version snapshot, excluding system fields
        const input: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(version.snapshot)) {
          if (!SYSTEM_FIELDS.has(key)) {
            input[key] = value;
          }
        }
        await updateRecord(schemaName, recordId, input, recordFields);
        onRestore?.();
      } catch {
        // Error is shown via toast in the parent
      } finally {
        setRestoring(false);
      }
    },
    [schemaName, recordId, recordFields, onRestore],
  );

  // Get compare pair
  const comparePair = useMemo(() => {
    if (selectedVersions.size !== 2) return null;
    const sorted = [...selectedVersions].sort((a, b) => a - b);
    const left = versions.find((v) => v.version === sorted[0]);
    const right = versions.find((v) => v.version === sorted[1]);
    if (!left || !right) return null;
    return { left, right };
  }, [selectedVersions, versions]);

  // Display versions in reverse chronological order (newest first)
  const displayVersions = useMemo(() => [...versions].reverse(), [versions]);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <History className="size-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold text-muted-foreground">
            {t("versionHistory.title", "Version History")}
          </h3>
          {versions.length > 0 && (
            <Badge variant="secondary" className="text-xs">
              {t("versionHistory.versionCount", "{{count}} version(s)", {
                count: versions.length,
              })}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1">
          {/* Compare mode toggle */}
          {versions.length >= 2 && (
            <Button
              variant={compareMode ? "secondary" : "ghost"}
              size="sm"
              className="h-7 text-xs"
              onClick={() => {
                setCompareMode(!compareMode);
                setSelectedVersions(new Set());
                setShowCompare(false);
              }}
            >
              <Columns2 className="size-3 mr-1" />
              {t("versionHistory.compare", "Compare")}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={fetchVersions} disabled={loading}>
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
          </Button>
        </div>
      </div>

      {/* Compare action bar */}
      {compareMode && selectedVersions.size === 2 && !showCompare && (
        <div className="flex items-center justify-between rounded-md border border-primary/30 bg-primary/5 px-3 py-2">
          <span className="text-xs text-muted-foreground">
            {t("versionHistory.twoSelected", "2 versions selected")}
          </span>
          <Button size="sm" className="h-7 text-xs" onClick={handleCompare}>
            <GitCompare className="size-3 mr-1" />
            {t("versionHistory.compareSelected", "Compare Selected")}
          </Button>
        </div>
      )}

      {/* Compare view */}
      {showCompare && comparePair && (
        <>
          <CompareView
            leftVersion={comparePair.left}
            rightVersion={comparePair.right}
            fields={fields}
            onClose={() => {
              setShowCompare(false);
              setSelectedVersions(new Set());
            }}
          />
          <Separator />
        </>
      )}

      {/* Loading state */}
      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }, (_, i) => `skel-v-${i}`).map((key) => (
            <Skeleton key={key} className="h-16 w-full rounded-md" />
          ))}
        </div>
      ) : versions.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted-foreground">
          {t("versionHistory.noVersions", "No version history available.")}
        </div>
      ) : (
        <div className="space-y-2">
          {displayVersions.map((version) => {
            const prevVersion = versions.find((v) => v.version === version.version - 1);
            const previousSnapshot = prevVersion?.snapshot ?? {};

            return (
              <VersionEntry
                key={version.version}
                version={version}
                fields={fields}
                previousSnapshot={previousSnapshot}
                isSelected={selectedVersions.has(version.version)}
                onToggleSelect={() => toggleSelect(version.version)}
                compareMode={compareMode}
                onRestore={
                  recordFields && recordFields.length > 0 ? () => handleRestore(version) : undefined
                }
                restoring={restoring}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
