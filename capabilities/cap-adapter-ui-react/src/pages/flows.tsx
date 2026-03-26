/**
 * FlowsPage — Lists all registered flows using AutoList.
 *
 * Route: /admin/flows
 * Fetches from /api/flows REST endpoint (falls back to demo data).
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
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowRightIcon,
  CalendarIcon,
  LinkIcon,
  MousePointerClickIcon,
  PlayIcon,
  RefreshCwIcon,
  ZapIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AutoList, SortableHeader } from "@/components/auto-list";

// ── Types ────────────────────────────────────────────────

interface FlowStepSummary {
  id: string;
  name: string;
  type: string;
}

interface FlowSummary {
  name: string;
  label?: string;
  description?: string;
  version?: number;
  trigger: { type: string; eventType?: string; cron?: string };
  stepCount: number;
  steps: FlowStepSummary[];
  /** Chain indicator — list of downstream flow names triggered on completion */
  chainsTo?: string[];
  /** Chain indicator — list of upstream flow names that trigger this flow */
  chainedFrom?: string[];
}

// No demo data — shows empty state when API is unavailable

// ── Trigger badge ────────────────────────────────────────

function TriggerBadge({ trigger }: { trigger: FlowSummary["trigger"] }) {
  const { t } = useTranslation();
  switch (trigger.type) {
    case "event":
      return (
        <Badge variant="outline" className="gap-1">
          <ZapIcon className="size-3" />
          {t("flows.triggerEvent")}
        </Badge>
      );
    case "schedule":
      return (
        <Badge variant="outline" className="gap-1">
          <CalendarIcon className="size-3" />
          {trigger.cron ?? t("flows.triggerSchedule")}
        </Badge>
      );
    case "manual":
      return (
        <Badge variant="outline" className="gap-1">
          <MousePointerClickIcon className="size-3" />
          {t("flows.triggerManual")}
        </Badge>
      );
    default:
      return <Badge variant="outline">{trigger.type}</Badge>;
  }
}

// ── Step type badge colors ──────────────────────────────

const STEP_TYPE_COLORS: Record<string, string> = {
  action: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
  condition: "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300",
  approval: "bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300",
  ai: "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300",
  wait: "bg-gray-100 text-gray-700 dark:bg-gray-900 dark:text-gray-300",
  parallel: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900 dark:text-cyan-300",
};

function StepTypeBadge({ type }: { type: string }) {
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${STEP_TYPE_COLORS[type] ?? "bg-muted text-muted-foreground"}`}>
      {type}
    </span>
  );
}

/** Mini step pipeline rendered inline in a table cell */
function StepPipeline({ steps }: { steps: FlowStepSummary[] }) {
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {steps.map((step, i) => (
        <div key={step.id} className="flex items-center gap-1">
          <StepTypeBadge type={step.type} />
          {i < steps.length - 1 && (
            <PlayIcon className="size-2.5 text-muted-foreground rotate-0" />
          )}
        </div>
      ))}
    </div>
  );
}

// ── Component ────────────────────────────────────────────

export function FlowsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [flows, setFlows] = useState<FlowSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [triggerFilter, setTriggerFilter] = useState<string>("all");

  const fetchFlows = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/flows");
      if (res.ok) {
        const json = await res.json();
        setFlows(json.data ?? []);
      } else {
        setFlows([]);
      }
    } catch {
      setFlows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchFlows();
  }, [fetchFlows]);

  const filtered = triggerFilter === "all"
    ? flows
    : flows.filter((f) => f.trigger.type === triggerFilter);

  // Build AutoList column definitions
  const columns = useMemo<ColumnDef<Record<string, unknown>, unknown>[]>(() => [
    {
      accessorKey: "label",
      header: ({ column }) => <SortableHeader column={column} label={t("flows.columns.name", { defaultValue: "Name" })} />,
      cell: ({ row }) => {
        const flow = row.original as unknown as FlowSummary;
        return (
          <div>
            <div className="font-medium text-sm">{flow.label ?? flow.name}</div>
            {flow.description && (
              <div className="text-xs text-muted-foreground line-clamp-1">{flow.description}</div>
            )}
          </div>
        );
      },
      // Use label for global filter, fall back to name
      accessorFn: (row) => {
        const flow = row as unknown as FlowSummary;
        return flow.label ?? flow.name;
      },
    },
    {
      id: "trigger",
      header: t("flows.columns.trigger", { defaultValue: "Trigger" }),
      cell: ({ row }) => {
        const flow = row.original as unknown as FlowSummary;
        return <TriggerBadge trigger={flow.trigger} />;
      },
      accessorFn: (row) => {
        const flow = row as unknown as FlowSummary;
        return flow.trigger.type;
      },
      size: 150,
    },
    {
      id: "steps",
      header: t("flows.columns.steps", { defaultValue: "Steps" }),
      cell: ({ row }) => {
        const flow = row.original as unknown as FlowSummary;
        return <StepPipeline steps={flow.steps} />;
      },
      enableSorting: false,
    },
    {
      accessorKey: "stepCount",
      header: ({ column }) => <SortableHeader column={column} label={t("flows.columns.stepCount", { defaultValue: "Count" })} />,
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground">
          {row.getValue("stepCount") as number} {t("flows.steps")}
        </span>
      ),
      size: 80,
    },
    {
      id: "chain",
      header: t("flows.columns.chain", { defaultValue: "Chain" }),
      cell: ({ row }) => {
        const flow = row.original as unknown as FlowSummary;
        const hasChain = (flow.chainsTo?.length ?? 0) > 0 || (flow.chainedFrom?.length ?? 0) > 0;
        if (!hasChain) return null;
        return (
          <div className="flex items-center gap-1">
            {flow.chainedFrom && flow.chainedFrom.length > 0 && (
              <Badge variant="outline" className="text-[9px] gap-0.5 h-5">
                <LinkIcon className="size-2.5" />
                {t("flows.chainIn", { count: flow.chainedFrom.length })}
              </Badge>
            )}
            {flow.chainsTo && flow.chainsTo.length > 0 && (
              <Badge variant="outline" className="text-[9px] gap-0.5 h-5">
                <ArrowRightIcon className="size-2.5" />
                {t("flows.chainOut", { count: flow.chainsTo.length })}
              </Badge>
            )}
          </div>
        );
      },
      size: 100,
    },
    {
      id: "version",
      header: t("flows.columns.version", { defaultValue: "Version" }),
      cell: ({ row }) => {
        const flow = row.original as unknown as FlowSummary;
        return flow.version ? (
          <Badge variant="secondary" className="text-[10px]">v{flow.version}</Badge>
        ) : null;
      },
      size: 80,
    },
  ], [t]);

  // Convert flows to DataRow for AutoList
  const tableData = useMemo<Record<string, unknown>[]>(
    () => filtered.map((f) => ({ ...f }) as Record<string, unknown>),
    [filtered],
  );

  return (
    <div className="p-4">
      <AutoList
        columns={columns}
        data={tableData}
        pageSize={20}
        loading={loading}
        emptyState={{
          title: t("emptyState.flows.title"),
          description: t("emptyState.flows.description"),
        }}
        onRowClick={(id) => {
          navigate({ to: "/admin/flows/$name" as "/", params: { name: id } });
        }}
        toolbarExtra={
          <>
            <Select value={triggerFilter} onValueChange={setTriggerFilter}>
              <SelectTrigger className="w-40 h-7 text-[0.8rem]">
                <SelectValue placeholder={t("flows.allTriggers")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("flows.allTriggers")}</SelectItem>
                <SelectItem value="event">{t("flows.triggerEvent")}</SelectItem>
                <SelectItem value="schedule">{t("flows.triggerSchedule")}</SelectItem>
                <SelectItem value="manual">{t("flows.triggerManual")}</SelectItem>
              </SelectContent>
            </Select>
            <span className="text-sm text-muted-foreground">
              {filtered.length} {t("flows.flowCount")}
            </span>
            <Button variant="outline" size="icon-sm" onClick={fetchFlows} disabled={loading} title={t("executionLog.refresh")}>
              <RefreshCwIcon className={`size-4 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </>
        }
      />
    </div>
  );
}
