/**
 * FlowDetailPage — Visual flow step diagram with step details.
 *
 * Route: /admin/flows/$name
 * Renders flow steps using ReactFlow with dagre auto-layout.
 */

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@linchkit/ui-kit/components";
import { Link, useParams } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ClockIcon,
  GitBranchIcon,
  GitForkIcon,
  LinkIcon,
  PlayIcon,
  ShieldCheckIcon,
  SparklesIcon,
  SplitIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AutoList, SortableHeader } from "@/components/auto-list";
import { FlowDiagram, type FlowStep } from "../components/flow-diagram";
import { useSchemaLabel } from "../i18n/use-schema-label";

// ── Types ────────────────────────────────────────────────

interface FlowChainConfig {
  flow: string;
  inputMapping?: Record<string, string>;
  onStatus?: "completed" | "failed";
}

interface FlowDependencyInfo {
  upstream: string[];
  downstream: string[];
}

interface FlowDetail {
  name: string;
  label?: string;
  description?: string;
  version?: number;
  trigger: { type: string; eventType?: string; cron?: string };
  steps: FlowStep[];
  onError?: string;
  maxRetries?: number;
  timeout?: number;
  onComplete?: FlowChainConfig | FlowChainConfig[];
  /** Populated by the API with upstream/downstream dependency info */
  dependencies?: FlowDependencyInfo;
}

// No demo data — shows empty state when API is unavailable

// ── Step styling config ──────────────────────────────────

const STEP_CONFIG: Record<string, { color: string; bgClass: string; icon: React.ReactNode }> = {
  action: {
    color: "#3b82f6",
    bgClass: "bg-blue-50 border-blue-200 dark:bg-blue-950 dark:border-blue-800",
    icon: <PlayIcon className="size-4" />,
  },
  condition: {
    color: "#f59e0b",
    bgClass: "bg-amber-50 border-amber-200 dark:bg-amber-950 dark:border-amber-800",
    icon: <GitForkIcon className="size-4" />,
  },
  approval: {
    color: "#8b5cf6",
    bgClass: "bg-purple-50 border-purple-200 dark:bg-purple-950 dark:border-purple-800",
    icon: <ShieldCheckIcon className="size-4" />,
  },
  ai: {
    color: "#10b981",
    bgClass: "bg-emerald-50 border-emerald-200 dark:bg-emerald-950 dark:border-emerald-800",
    icon: <SparklesIcon className="size-4" />,
  },
  wait: {
    color: "#6b7280",
    bgClass: "bg-gray-50 border-gray-200 dark:bg-gray-900 dark:border-gray-700",
    icon: <ClockIcon className="size-4" />,
  },
  parallel: {
    color: "#06b6d4",
    bgClass: "bg-cyan-50 border-cyan-200 dark:bg-cyan-950 dark:border-cyan-800",
    icon: <SplitIcon className="size-4" />,
  },
};

function getStepConfig(type: string) {
  return (
    STEP_CONFIG[type] ?? {
      color: "#6b7280",
      bgClass: "bg-muted border-border",
      icon: <PlayIcon className="size-4" />,
    }
  );
}

// ── Step list AutoList sub-component ─────────────────────

function StepListAutoList({
  steps,
  resolveLabel,
}: {
  steps: FlowStep[];
  resolveLabel: (key: string, fallback: string) => string;
}) {
  const { t } = useTranslation();

  const columns = useMemo<ColumnDef<Record<string, unknown>, unknown>[]>(
    () => [
      {
        id: "index",
        header: "#",
        size: 50,
        cell: ({ row }) => <span className="text-muted-foreground">{row.index + 1}</span>,
      },
      {
        accessorKey: "id",
        header: "ID",
        size: 120,
        cell: ({ row }) => (
          <span className="font-mono text-xs">{row.getValue("id") as string}</span>
        ),
      },
      {
        accessorKey: "name",
        header: ({ column }) => <SortableHeader column={column} label={t("flows.stepName")} />,
        cell: ({ row }) => {
          const step = row.original as unknown as FlowStep;
          return <span className="font-medium">{resolveLabel(step.name, step.name)}</span>;
        },
      },
      {
        accessorKey: "type",
        header: ({ column }) => <SortableHeader column={column} label={t("flows.stepType")} />,
        cell: ({ row }) => {
          const step = row.original as unknown as FlowStep;
          const config = getStepConfig(step.type);
          return (
            <div className="flex items-center gap-1.5" style={{ color: config.color }}>
              {config.icon}
              <span className="text-xs">{step.type}</span>
            </div>
          );
        },
        size: 120,
      },
      {
        id: "details",
        header: t("flows.stepDetails"),
        cell: ({ row }) => {
          const step = row.original as unknown as FlowStep;
          let detail = "";
          if (step.type === "action" && step.actionName) detail = step.actionName;
          else if (step.type === "condition" && step.expression) detail = step.expression;
          else if (step.type === "ai" && typeof step.prompt === "string")
            detail = step.prompt.slice(0, 60);
          else if (step.type === "approval" && step.approvers) detail = step.approvers.join(", ");
          else if (step.type === "wait") detail = step.signal ?? "duration";
          else if (step.type === "parallel" && step.steps) detail = step.steps.join(", ");
          return (
            <span className="text-xs text-muted-foreground max-w-xs truncate block">{detail}</span>
          );
        },
      },
    ],
    [t, resolveLabel],
  );

  const tableData = useMemo<Record<string, unknown>[]>(
    () => steps.map((s) => ({ ...s }) as Record<string, unknown>),
    [steps],
  );

  return <AutoList columns={columns} data={tableData} pageSize={50} />;
}

// ── Main component ───────────────────────────────────────

export function FlowDetailPage() {
  const { t } = useTranslation();
  const { resolveLabel } = useSchemaLabel();
  // biome-ignore lint/suspicious/noExplicitAny: TanStack Router param typing
  const { name } = useParams({ strict: false }) as any;
  const [flow, setFlow] = useState<FlowDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchFlow = useCallback(async () => {
    if (!name) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/flows/${name}`);
      if (res.ok) {
        const json = await res.json();
        setFlow(json.data);
      } else {
        setError(t("flows.notFound", { name }));
      }
    } catch {
      setError(t("flows.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [name, t]);

  useEffect(() => {
    fetchFlow();
  }, [fetchFlow]);

  if (loading) {
    return (
      <div className="p-4 flex items-center justify-center py-16 text-muted-foreground">
        {t("common.loading")}
      </div>
    );
  }

  if (error || !flow) {
    return (
      <div className="p-4 space-y-4">
        <Link to={"/schemas/flow" as "/"}>
          <Button variant="ghost" size="sm">
            <ArrowLeftIcon className="size-4 mr-1" />
            {t("common.back")}
          </Button>
        </Link>
        <div className="flex items-center justify-center py-16 text-destructive">
          {error ?? t("flows.notFound", { name })}
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link to={"/schemas/flow" as "/"}>
          <Button variant="ghost" size="icon-sm">
            <ArrowLeftIcon className="size-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-lg font-semibold">{flow.label ?? flow.name}</h1>
          {flow.description && <p className="text-sm text-muted-foreground">{flow.description}</p>}
        </div>
      </div>

      {/* Meta info */}
      <div className="flex items-center gap-3 flex-wrap">
        <Badge variant="outline">
          {flow.trigger.type === "event" && `Event: ${flow.trigger.eventType}`}
          {flow.trigger.type === "schedule" && `Cron: ${flow.trigger.cron}`}
          {flow.trigger.type === "manual" && t("flows.triggerManual")}
        </Badge>
        {flow.version && <Badge variant="secondary">v{flow.version}</Badge>}
        {flow.onError && (
          <Badge variant="secondary">
            {t("flows.onError")}: {flow.onError}
          </Badge>
        )}
        <span className="text-sm text-muted-foreground">
          {flow.steps.length} {t("flows.steps")}
        </span>
      </div>

      {/* Flow chain dependencies */}
      {(flow.dependencies?.upstream?.length ||
        flow.dependencies?.downstream?.length ||
        flow.onComplete) && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <LinkIcon className="size-4" />
              {t("flows.chainDependencies", { defaultValue: "Flow Chain" })}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {/* Upstream flows */}
              {flow.dependencies?.upstream && flow.dependencies.upstream.length > 0 && (
                <div className="flex items-start gap-2">
                  <span className="text-xs text-muted-foreground font-medium min-w-[90px]">
                    {t("flows.triggeredBy", { defaultValue: "Triggered by" })}:
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {flow.dependencies.upstream.map((name) => (
                      <Link key={name} to={"/admin/flows/$name" as "/"} params={{ name }}>
                        <Badge variant="outline" className="gap-1 cursor-pointer hover:bg-accent">
                          <GitBranchIcon className="size-3" />
                          {name}
                          <ArrowRightIcon className="size-3" />
                        </Badge>
                      </Link>
                    ))}
                  </div>
                </div>
              )}
              {/* Downstream flows (from onComplete) */}
              {flow.dependencies?.downstream && flow.dependencies.downstream.length > 0 && (
                <div className="flex items-start gap-2">
                  <span className="text-xs text-muted-foreground font-medium min-w-[90px]">
                    {t("flows.triggers", { defaultValue: "Triggers" })}:
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {flow.dependencies.downstream.map((name) => (
                      <Link key={name} to={"/admin/flows/$name" as "/"} params={{ name }}>
                        <Badge variant="outline" className="gap-1 cursor-pointer hover:bg-accent">
                          <ArrowRightIcon className="size-3" />
                          {name}
                          <GitBranchIcon className="size-3" />
                        </Badge>
                      </Link>
                    ))}
                  </div>
                </div>
              )}
              {/* onComplete config details */}
              {flow.onComplete && (
                <div className="flex items-start gap-2">
                  <span className="text-xs text-muted-foreground font-medium min-w-[90px]">
                    {t("flows.onComplete", { defaultValue: "On Complete" })}:
                  </span>
                  <div className="text-xs text-muted-foreground">
                    {(Array.isArray(flow.onComplete) ? flow.onComplete : [flow.onComplete]).map(
                      (c) => (
                        <div key={c.flow} className="flex items-center gap-1">
                          <ArrowRightIcon className="size-3" />
                          <span className="font-mono">{c.flow}</span>
                          {c.onStatus && (
                            <Badge variant="secondary" className="text-[9px] h-4">
                              {c.onStatus}
                            </Badge>
                          )}
                          {c.inputMapping && (
                            <span className="text-muted-foreground/60">
                              (
                              {t("flows.mappedFields", {
                                count: Object.keys(c.inputMapping).length,
                              })}
                              )
                            </span>
                          )}
                        </div>
                      ),
                    )}
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Flow diagram */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("flows.diagram")}</CardTitle>
        </CardHeader>
        <CardContent>
          <FlowDiagram steps={flow.steps} resolveLabel={resolveLabel} />
        </CardContent>
      </Card>

      {/* Step list table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("flows.stepList")}</CardTitle>
        </CardHeader>
        <CardContent>
          <StepListAutoList steps={flow.steps} resolveLabel={resolveLabel} />
        </CardContent>
      </Card>
    </div>
  );
}
