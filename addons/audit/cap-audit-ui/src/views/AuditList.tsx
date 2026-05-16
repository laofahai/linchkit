/**
 * AuditList — paginated table of execution log entries with a filter
 * toolbar and a side-drawer detail view.
 *
 * Wires together AuditFiltersBar + the audit-api list query + a
 * lightweight pagination footer. Detail view is mounted in a sibling
 * panel when the user clicks a row.
 */

import {
  Badge,
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@linchkit/ui-kit/components";
import { ChevronLeft, ChevronRight, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type AuditFilters as AuditFiltersValue,
  type AuditRow,
  type AuditStatus,
  queryAuditList,
} from "../lib/audit-api";
import AuditDetailView from "./AuditDetail";
import { AuditFiltersBar } from "./AuditFilters";

// ── Helpers ─────────────────────────────────────────────

const PAGE_SIZE = 50;

function statusVariant(status: AuditStatus): "default" | "secondary" | "destructive" | "outline" {
  if (status === "succeeded") return "default";
  if (status === "failed" || status === "blocked") return "destructive";
  return "secondary";
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

// ── Component ───────────────────────────────────────────

export function AuditList() {
  const { t } = useTranslation();
  const [filters, setFilters] = useState<AuditFiltersValue>({});
  // Filters that have actually been submitted — separate so typing
  // in a filter input doesn't hammer the server until the user clicks
  // "Apply" (or presses Enter inside the form).
  const [appliedFilters, setAppliedFilters] = useState<AuditFiltersValue>({});
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await queryAuditList({
        filters: appliedFilters,
        page,
        pageSize: PAGE_SIZE,
      });
      setRows(result.items);
      setTotal(result.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRows([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [appliedFilters, page]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  function handleApply() {
    setAppliedFilters(filters);
    setPage(1);
  }

  function handleReset() {
    setFilters({});
    setAppliedFilters({});
    setPage(1);
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="flex h-full">
      <div className="flex flex-1 flex-col gap-3 p-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold">{t("audit.list.title", "Audit Log")}</h1>
            <p className="text-xs text-muted-foreground">
              {t("audit.list.subtitle", "Every action execution recorded in _linchkit.executions.")}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={refetch}
            disabled={loading}
            aria-label={t("common.refresh", "Refresh")}
          >
            <RefreshCw className={`mr-1 size-3.5 ${loading ? "animate-spin" : ""}`} />
            {t("common.refresh", "Refresh")}
          </Button>
        </div>

        {/* Filters */}
        <AuditFiltersBar
          value={filters}
          onChange={setFilters}
          onApply={handleApply}
          onReset={handleReset}
        />

        {/* Error banner */}
        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* Table */}
        <div className="rounded-md border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-44">{t("audit.list.startedAt", "Started")}</TableHead>
                <TableHead>{t("audit.list.action", "Action")}</TableHead>
                <TableHead>{t("audit.list.entity", "Entity")}</TableHead>
                <TableHead>{t("audit.list.actor", "Actor")}</TableHead>
                <TableHead className="w-28">{t("audit.list.status", "Status")}</TableHead>
                <TableHead className="w-24 text-right">
                  {t("audit.list.duration", "Duration")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-24 text-center">
                    <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
                  </TableCell>
                </TableRow>
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-24 text-center text-sm text-muted-foreground">
                    {t("audit.list.empty", "No execution log entries match the current filters.")}
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((row) => (
                  <TableRow
                    key={row.id}
                    data-state={selectedId === row.id ? "selected" : undefined}
                    className="cursor-pointer"
                    onClick={() => setSelectedId(row.id)}
                  >
                    <TableCell className="font-mono text-xs">
                      {new Date(row.startedAt).toLocaleString()}
                    </TableCell>
                    <TableCell className="font-medium">{row.action}</TableCell>
                    <TableCell>
                      {row.entity ? (
                        <span className="text-xs">
                          <code>{row.entity}</code>
                          {row.recordId && (
                            <span className="text-muted-foreground"> / {row.recordId}</span>
                          )}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {row.actorId ? (
                        <span className="text-xs">
                          <span className="text-muted-foreground">{row.actorType ?? "?"}:</span>{" "}
                          <code>{row.actorId}</code>
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(row.status)}>{row.status}</Badge>
                    </TableCell>
                    <TableCell className="text-right text-xs">
                      {formatDuration(row.durationMs)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        {/* Pagination */}
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {t("audit.list.totalCount", { defaultValue: "{{count}} entries", count: total })}
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1 || loading}
              aria-label={t("common.previous", "Previous")}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <span>
              {page} / {totalPages}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages || loading}
              aria-label={t("common.next", "Next")}
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      </div>

      {/* Detail panel */}
      {selectedId && (
        <AuditDetailView executionId={selectedId} onClose={() => setSelectedId(null)} />
      )}
    </div>
  );
}

export default AuditList;
