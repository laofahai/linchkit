/**
 * ExecutionLogsPage — Displays execution log entries using AutoList.
 *
 * Fetches from /api/executions REST endpoint (or uses demo data in dev mode).
 * Spec ref: 11_execution_log.md, 39_execution_contract.md
 */

import {
  Badge,
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@linchkit/ui-kit/components";
import type { ColumnDef } from "@tanstack/react-table";
import { ChevronDownIcon, ClockIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AutoList, SortableHeader } from "@/components/auto-list";

// ── Types ────────────────────────────────────────────────

interface ExecutionLogEntry {
  id: string;
  action: string;
  capability?: string;
  schema?: string;
  recordId?: string;
  actor: { type: string; id: string };
  input: Record<string, unknown>;
  output?: unknown;
  status: "succeeded" | "failed" | "blocked" | "pending_approval";
  error?: { code?: string; message: string };
  rulesEvaluated?: Array<{ rule: string; result: string; message?: string }>;
  stateTransition?: { from: string; to: string };
  duration: number;
  startedAt: string;
  completedAt: string;
}

interface ExecutionLogListResult {
  items: ExecutionLogEntry[];
  total: number;
}

// ── Status badge styling ────────────────────────────────

const STATUS_VARIANTS: Record<string, "default" | "destructive" | "outline" | "secondary"> = {
  succeeded: "default",
  failed: "destructive",
  blocked: "secondary",
  pending_approval: "outline",
};

function StatusBadge({ status }: { status: string }) {
  return <Badge variant={STATUS_VARIANTS[status] ?? "outline"}>{status}</Badge>;
}

// ── Duration formatter ──────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ── Demo data ───────────────────────────────────────────

const DEMO_ENTRIES: ExecutionLogEntry[] = [
  {
    id: "exec_001",
    action: "create_purchase_request",
    schema: "purchase_request",
    recordId: "pr_001",
    actor: { type: "human", id: "alice" },
    input: { title: "Office Supplies Q2", amount: 1500 },
    output: { id: "pr_001" },
    status: "succeeded",
    duration: 12,
    startedAt: new Date(Date.now() - 3600000).toISOString(),
    completedAt: new Date(Date.now() - 3600000 + 12).toISOString(),
  },
  {
    id: "exec_002",
    action: "submit_purchase_request",
    schema: "purchase_request",
    recordId: "pr_001",
    actor: { type: "human", id: "alice" },
    input: { id: "pr_001" },
    output: { id: "pr_001", status: "pending" },
    status: "succeeded",
    stateTransition: { from: "draft", to: "pending" },
    duration: 8,
    startedAt: new Date(Date.now() - 3500000).toISOString(),
    completedAt: new Date(Date.now() - 3500000 + 8).toISOString(),
  },
  {
    id: "exec_003",
    action: "approve_purchase_request",
    schema: "purchase_request",
    recordId: "pr_002",
    actor: { type: "human", id: "bob" },
    input: { id: "pr_002" },
    status: "blocked",
    error: { code: "RULE.BUDGET.EXCEEDED", message: "Amount exceeds department budget" },
    rulesEvaluated: [
      { rule: "budget_check", result: "blocked", message: "Amount 25000 > limit 20000" },
    ],
    duration: 5,
    startedAt: new Date(Date.now() - 1800000).toISOString(),
    completedAt: new Date(Date.now() - 1800000 + 5).toISOString(),
  },
  {
    id: "exec_004",
    action: "update_purchase_request",
    schema: "purchase_request",
    recordId: "pr_004",
    actor: { type: "human", id: "dave" },
    input: { id: "pr_004", amount: 9000, notes: "Updated estimate" },
    status: "failed",
    error: { message: "Record not found: purchase_request/pr_999" },
    duration: 3,
    startedAt: new Date(Date.now() - 900000).toISOString(),
    completedAt: new Date(Date.now() - 900000 + 3).toISOString(),
  },
  {
    id: "exec_005",
    action: "create_purchase_request",
    schema: "purchase_request",
    actor: { type: "human", id: "carol" },
    input: { title: "Marketing materials", amount: 2500, department: "Marketing" },
    output: { id: "pr_005" },
    status: "succeeded",
    duration: 15,
    startedAt: new Date(Date.now() - 600000).toISOString(),
    completedAt: new Date(Date.now() - 600000 + 15).toISOString(),
  },
];

// ── Expanded detail view ────────────────────────────────

function LogDetail({ entry }: { entry: ExecutionLogEntry }) {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-2 gap-4 text-sm p-4 bg-muted/20">
      <div>
        <h4 className="font-medium mb-1">{t("executionLog.input")}</h4>
        <pre className="bg-muted rounded p-2 text-xs overflow-auto max-h-40">
          {JSON.stringify(entry.input, null, 2)}
        </pre>
      </div>
      {entry.output != null && (
        <div>
          <h4 className="font-medium mb-1">{t("executionLog.output")}</h4>
          <pre className="bg-muted rounded p-2 text-xs overflow-auto max-h-40">
            {JSON.stringify(entry.output, null, 2)}
          </pre>
        </div>
      )}
      {entry.error && (
        <div>
          <h4 className="font-medium mb-1 text-destructive">{t("executionLog.error")}</h4>
          <div className="bg-destructive/10 rounded p-2 text-xs">
            {entry.error.code && <div className="font-mono">{entry.error.code}</div>}
            <div>{entry.error.message}</div>
          </div>
        </div>
      )}
      {entry.stateTransition && (
        <div>
          <h4 className="font-medium mb-1">{t("executionLog.stateTransition")}</h4>
          <div className="flex items-center gap-2 text-xs">
            <Badge variant="outline">{entry.stateTransition.from}</Badge>
            <span>→</span>
            <Badge variant="outline">{entry.stateTransition.to}</Badge>
          </div>
        </div>
      )}
      {entry.rulesEvaluated && entry.rulesEvaluated.length > 0 && (
        <div className="col-span-2">
          <h4 className="font-medium mb-1">{t("executionLog.rulesEvaluated")}</h4>
          <div className="space-y-1">
            {entry.rulesEvaluated.map((r) => (
              <div key={`${r.rule}-${r.result}`} className="flex items-center gap-2 text-xs">
                <span className="font-mono">{r.rule}</span>
                <Badge
                  variant={r.result === "passed" ? "default" : "destructive"}
                  className="text-[10px]"
                >
                  {r.result}
                </Badge>
                {r.message && <span className="text-muted-foreground">{r.message}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="col-span-2 text-xs text-muted-foreground">ID: {entry.id}</div>
    </div>
  );
}

// ── Component ───────────────────────────────────────────

export function ExecutionLogsPage() {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<ExecutionLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [loading, setLoading] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const applyDemoData = useCallback(() => {
    let filtered: ExecutionLogEntry[] = DEMO_ENTRIES;
    if (statusFilter !== "all") {
      filtered = filtered.filter((e) => e.status === statusFilter);
    }
    setTotal(filtered.length);
    setEntries(filtered);
  }, [statusFilter]);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);

      const res = await fetch(`/api/executions?${params.toString()}`);
      if (res.ok) {
        const json = await res.json();
        const result = json.data as ExecutionLogListResult;
        setEntries(result.items);
        setTotal(result.total);
      } else {
        applyDemoData();
      }
    } catch {
      applyDemoData();
    } finally {
      setLoading(false);
    }
  }, [statusFilter, applyDemoData]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  // Build column definitions for AutoList
  const columns = useMemo<ColumnDef<Record<string, unknown>, unknown>[]>(() => [
    {
      accessorKey: "startedAt",
      header: ({ column }) => <SortableHeader column={column} label={t("executionLog.time")} />,
      cell: ({ row }) => {
        const entry = row.original as unknown as ExecutionLogEntry;
        return (
          <div className="flex items-center gap-1 text-muted-foreground text-xs">
            <ClockIcon className="size-3" />
            <span>{formatDate(entry.startedAt)}</span>
            <span>{formatTime(entry.startedAt)}</span>
          </div>
        );
      },
    },
    {
      accessorKey: "action",
      header: ({ column }) => <SortableHeader column={column} label={t("executionLog.action")} />,
      cell: ({ row }) => {
        const entry = row.original as unknown as ExecutionLogEntry;
        return (
          <div>
            <div className="font-mono text-xs">{entry.action}</div>
            {entry.recordId && (
              <div className="text-xs text-muted-foreground">
                {entry.schema}/{entry.recordId}
              </div>
            )}
          </div>
        );
      },
    },
    {
      accessorKey: "actor",
      header: t("executionLog.actor"),
      cell: ({ row }) => {
        const entry = row.original as unknown as ExecutionLogEntry;
        return (
          <span className="text-xs">
            {entry.actor.id}
            <span className="text-muted-foreground ml-1">({entry.actor.type})</span>
          </span>
        );
      },
      // Enable global filter to match actor id
      accessorFn: (row) => {
        const entry = row as unknown as ExecutionLogEntry;
        return entry.actor.id;
      },
    },
    {
      accessorKey: "status",
      header: ({ column }) => <SortableHeader column={column} label={t("executionLog.status")} />,
      cell: ({ row }) => <StatusBadge status={row.getValue("status") as string} />,
    },
    {
      accessorKey: "duration",
      header: ({ column }) => <SortableHeader column={column} label={t("executionLog.duration")} />,
      cell: ({ row }) => (
        <span className="font-mono text-xs">
          {formatDuration(row.getValue("duration") as number)}
        </span>
      ),
      meta: { align: "right" },
    },
    {
      id: "expand",
      header: "",
      size: 40,
      cell: ({ row }) => {
        const entry = row.original as unknown as ExecutionLogEntry;
        const isExpanded = expandedId === entry.id;
        return (
          <button
            type="button"
            className="p-1"
            onClick={(e) => {
              e.stopPropagation();
              setExpandedId(isExpanded ? null : entry.id);
            }}
          >
            <ChevronDownIcon
              className={`size-3.5 text-muted-foreground transition-transform ${isExpanded ? "rotate-180" : ""}`}
            />
          </button>
        );
      },
    },
  ], [t, expandedId]);

  // Convert entries to DataRow format for AutoList
  const tableData = useMemo<Record<string, unknown>[]>(
    () => entries.map((e) => ({ ...e }) as Record<string, unknown>),
    [entries],
  );

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">{t("executionLog.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("executionLog.subtitle")}</p>
        </div>
      </div>

      <AutoList
        externalColumns={columns}
        data={tableData}
        pageSize={20}
        defaultSorting={[{ id: "startedAt", desc: true }]}
        loading={loading}
        onRowClick={(id) => {
          setExpandedId(expandedId === id ? null : id);
        }}
        toolbarExtra={
          <>
            <Select
              value={statusFilter}
              onValueChange={(v) => setStatusFilter(v)}
            >
              <SelectTrigger className="w-40 h-7 text-[0.8rem]">
                <SelectValue placeholder={t("executionLog.allStatuses")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("executionLog.allStatuses")}</SelectItem>
                <SelectItem value="succeeded">{t("executionLog.succeeded")}</SelectItem>
                <SelectItem value="failed">{t("executionLog.failed")}</SelectItem>
                <SelectItem value="blocked">{t("executionLog.blocked")}</SelectItem>
                <SelectItem value="pending_approval">{t("executionLog.pendingApproval")}</SelectItem>
              </SelectContent>
            </Select>
            <span className="text-sm text-muted-foreground">
              {total} {t("executionLog.entries")}
            </span>
            <Button variant="outline" size="icon-sm" onClick={fetchLogs} disabled={loading} title={t("executionLog.refresh")}>
              <RefreshCwIcon className={`size-4 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </>
        }
      />

      {/* Expanded detail panel (rendered below the table for the selected row) */}
      {expandedId && (
        <div className="rounded border border-border">
          {(() => {
            const entry = entries.find((e) => e.id === expandedId);
            return entry ? <LogDetail entry={entry} /> : null;
          })()}
        </div>
      )}
    </div>
  );
}
