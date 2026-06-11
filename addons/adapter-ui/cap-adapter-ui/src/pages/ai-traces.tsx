/**
 * AITracesPage — /admin/ai-traces
 *
 * Read-only admin surface for recent AI traces (Spec 69 — "Langfuse-class
 * observability", issue #350). Consumes `GET /api/ai/traces` via the
 * {@link fetchAITraces} helper and renders a most-recent-first table.
 *
 * Data source audit:
 * - All data: DYNAMIC — fetched from GET /api/ai/traces, served by the active
 *   AI trace sink (Drizzle durable store, or the in-memory hot view fallback).
 * - Refetches on mount and whenever the status filter changes.
 */

import {
  Badge,
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@linchkit/ui-kit/components";
import { formatRelativeTime } from "@linchkit/ui-kit/lib/utils";
import { ActivityIcon, RefreshCwIcon, ShieldOffIcon, XCircleIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type AITrace,
  type AITraceStatus,
  type AITracesResult,
  fetchAITraces,
} from "../lib/ai-traces-client";

// ── Constants ────────────────────────────────────────────

/** Page size requested from the endpoint (server hard-caps at 500). */
const TRACE_LIMIT = 100;

/** Status filter options surfaced in the Select. `__all__` clears the filter. */
const STATUS_OPTIONS: ReadonlyArray<AITraceStatus | "__all__"> = [
  "__all__",
  "ok",
  "error",
  "partial",
];

// ── Helpers ──────────────────────────────────────────────

/** Map a trace status to a Badge variant (ok=green, error=red, partial=amber). */
function statusBadgeClass(status: AITraceStatus): string {
  switch (status) {
    case "ok":
      return "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400";
    case "error":
      return "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400";
    default:
      // partial
      return "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400";
  }
}

/** Format trace duration (endedAt - startedAt) in ms, or "" when unfinished. */
function formatTraceDuration(trace: AITrace): string {
  // `== null` covers both null (common in JSON) and undefined (open trace).
  if (trace.endedAt == null) return "";
  const ms = trace.endedAt - trace.startedAt;
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/** Format a USD cost, or "—" when zero (per spec — `$0.000026`, `—` when 0). */
function formatCost(cost: number): string {
  if (!cost) return "—";
  return `$${cost.toFixed(6)}`;
}

/** Truncate a trace id for compact monospace display. */
function truncateTraceId(traceId: string): string {
  return traceId.length > 12 ? `${traceId.slice(0, 12)}…` : traceId;
}

// ── Sub-components ───────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 8 }).map((_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

function TraceRow({ trace }: { trace: AITrace }) {
  const { t } = useTranslation();
  const duration = formatTraceDuration(trace);
  // Guard against a missing / invalid `startedAt` — `new Date(NaN).toISOString()`
  // throws `RangeError`, which would crash the whole table.
  const started = new Date(trace.startedAt);
  const startedLabel = Number.isNaN(started.getTime())
    ? "—"
    : formatRelativeTime(started.toISOString(), t);
  return (
    <TableRow>
      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
        <div>{startedLabel}</div>
        {duration && <div className="text-[10px] opacity-70">{duration}</div>}
      </TableCell>
      <TableCell>
        <div className="font-medium text-sm">{trace.name}</div>
        {trace.scenario && <div className="text-xs text-muted-foreground">{trace.scenario}</div>}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">{trace.origin}</TableCell>
      <TableCell>
        <Badge variant="secondary" className={`text-[10px] ${statusBadgeClass(trace.status)}`}>
          {t(`aiTraces.status.${trace.status}`, trace.status)}
        </Badge>
      </TableCell>
      <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">
        {(trace.inputTokens ?? 0).toLocaleString()} / {(trace.outputTokens ?? 0).toLocaleString()}
      </TableCell>
      <TableCell className="whitespace-nowrap font-mono text-xs">
        {formatCost(trace.cost)}
      </TableCell>
      <TableCell className="font-mono text-xs text-muted-foreground" title={trace.traceId}>
        {truncateTraceId(trace.traceId)}
      </TableCell>
    </TableRow>
  );
}

// ── Main component ───────────────────────────────────────

export function AITracesPage() {
  const { t } = useTranslation();
  const [result, setResult] = useState<AITracesResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<AITraceStatus | "__all__">("__all__");

  // Monotonic request token: a slow in-flight fetch (e.g. an older status
  // filter) must not overwrite the result of a newer one that already resolved.
  const reqSeq = useRef(0);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      const seq = ++reqSeq.current;
      setLoading(true);
      const next = await fetchAITraces({
        limit: TRACE_LIMIT,
        status: statusFilter === "__all__" ? undefined : statusFilter,
        signal,
      });
      // Drop a stale response superseded by a newer load, or one whose request
      // was aborted (e.g. the component unmounted) — avoid setState-after-unmount.
      if (seq !== reqSeq.current || signal?.aborted) return;
      setResult(next);
      setLoading(false);
    },
    [statusFilter],
  );

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const traces = result?.kind === "ok" ? result.traces : [];

  return (
    <div className="w-full p-4 space-y-4">
      {/* Header row */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <ActivityIcon className="size-5 text-muted-foreground" />
            <h1 className="text-lg font-semibold">{t("aiTraces.title", "AI Traces")}</h1>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t("aiTraces.subtitle", "Recent AI generations — audit cost, tokens, and outcomes.")}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Select
            value={statusFilter}
            onValueChange={(v) => setStatusFilter(v as AITraceStatus | "__all__")}
          >
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((opt) => (
                <SelectItem key={opt} value={opt}>
                  {opt === "__all__"
                    ? t("aiTraces.allStatuses", "All Statuses")
                    : t(`aiTraces.status.${opt}`, opt)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={() => load()} disabled={loading}>
            <RefreshCwIcon className={`size-4 mr-1 ${loading ? "animate-spin" : ""}`} />
            {t("aiTraces.refresh", "Refresh")}
          </Button>
        </div>
      </div>

      {/* Permission-denied state */}
      {result?.kind === "denied" && (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
          <ShieldOffIcon className="size-10 opacity-30" />
          <p className="text-sm">
            {t("aiTraces.denied", "You don't have permission to view AI traces.")}
          </p>
        </div>
      )}

      {/* Error banner */}
      {result?.kind === "error" && (
        <div className="rounded-lg p-4 bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-400 text-sm flex items-center gap-2">
          <XCircleIcon className="size-4 shrink-0" />
          {t("aiTraces.fetchError", "Failed to load AI traces")}: {result.message}
        </div>
      )}

      {/* Loading skeleton (only before first result) */}
      {loading && !result && <LoadingSkeleton />}

      {/* Empty state */}
      {result?.kind === "ok" && traces.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
          <ActivityIcon className="size-10 opacity-30" />
          <p className="text-sm">{t("aiTraces.empty", "No AI traces recorded yet")}</p>
        </div>
      )}

      {/* Traces table */}
      {result?.kind === "ok" && traces.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-xs">{t("aiTraces.time", "Time")}</TableHead>
              <TableHead className="text-xs">{t("aiTraces.name", "Name")}</TableHead>
              <TableHead className="text-xs">{t("aiTraces.origin", "Origin")}</TableHead>
              <TableHead className="text-xs">{t("aiTraces.statusLabel", "Status")}</TableHead>
              <TableHead className="text-xs">{t("aiTraces.tokens", "Tokens (in / out)")}</TableHead>
              <TableHead className="text-xs">{t("aiTraces.cost", "Cost")}</TableHead>
              <TableHead className="text-xs">{t("aiTraces.traceId", "Trace ID")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {traces.map((trace) => (
              <TraceRow key={trace.traceId} trace={trace} />
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
