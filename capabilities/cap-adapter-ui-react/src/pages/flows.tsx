/**
 * FlowsPage — Lists all registered flows with summary info.
 *
 * Route: /admin/flows
 * Fetches from /api/flows REST endpoint (falls back to demo data).
 */

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@linchkit/ui-kit/components";
import { Link } from "@tanstack/react-router";
import {
  ArrowRightIcon,
  CalendarIcon,
  GitBranchIcon,
  MousePointerClickIcon,
  PlayIcon,
  RefreshCwIcon,
  ZapIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

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
}

// ── Demo data ────────────────────────────────────────────

const DEMO_FLOWS: FlowSummary[] = [
  {
    name: "purchase_approval_flow",
    label: "Purchase Approval",
    description: "Multi-step purchase request approval process with budget check",
    version: 1,
    trigger: { type: "event", eventType: "action.succeeded.submit_request" },
    stepCount: 4,
    steps: [
      { id: "calc", name: "Calculate Total", type: "action" },
      { id: "check", name: "Budget Check", type: "condition" },
      { id: "approval", name: "Manager Approval", type: "approval" },
      { id: "notify", name: "Notify Requester", type: "action" },
    ],
  },
  {
    name: "ai_evolution_analysis",
    label: "AI Evolution Analysis",
    description: "Weekly AI analysis of execution data to discover optimization opportunities",
    version: 1,
    trigger: { type: "schedule", cron: "0 2 * * 1" },
    stepCount: 4,
    steps: [
      { id: "collect", name: "Collect Data", type: "action" },
      { id: "analyze", name: "AI Analyze", type: "ai" },
      { id: "gen_proposals", name: "Generate Proposals", type: "ai" },
      { id: "create", name: "Create Proposals", type: "action" },
    ],
  },
  {
    name: "onboarding_flow",
    label: "Employee Onboarding",
    description: "Automated onboarding process for new employees",
    version: 1,
    trigger: { type: "manual" },
    stepCount: 5,
    steps: [
      { id: "create_account", name: "Create Account", type: "action" },
      { id: "setup", name: "Setup Tasks", type: "parallel" },
      { id: "wait_docs", name: "Wait for Documents", type: "wait" },
      { id: "review", name: "HR Review", type: "approval" },
      { id: "welcome", name: "Send Welcome", type: "action" },
    ],
  },
];

// ── Trigger icon ─────────────────────────────────────────

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

// ── Step type badge colors ───────────────────────────────

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

// ── Component ────────────────────────────────────────────

export function FlowsPage() {
  const { t } = useTranslation();
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
        setFlows(DEMO_FLOWS);
      }
    } catch {
      setFlows(DEMO_FLOWS);
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

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">{t("flows.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("flows.subtitle")}</p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchFlows} disabled={loading}>
          <RefreshCwIcon className={`size-4 mr-1 ${loading ? "animate-spin" : ""}`} />
          {t("executionLog.refresh")}
        </Button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2">
        <Select value={triggerFilter} onValueChange={setTriggerFilter}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder={t("flows.allTriggers")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("flows.allTriggers")}</SelectItem>
            <SelectItem value="event">{t("flows.triggerEvent")}</SelectItem>
            <SelectItem value="schedule">{t("flows.triggerSchedule")}</SelectItem>
            <SelectItem value="manual">{t("flows.triggerManual")}</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-sm text-muted-foreground ml-2">
          {filtered.length} {t("flows.flowCount")}
        </span>
      </div>

      {/* Flow cards */}
      {filtered.length === 0 ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <GitBranchIcon className="size-8 mr-3 opacity-50" />
          <span>{loading ? t("common.loading") : t("flows.noFlows")}</span>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filtered.map((flow) => (
            <Link
              key={flow.name}
              to={"/admin/flows/$name" as "/"}
              params={{ name: flow.name }}
              className="block"
            >
              <Card className="hover:border-primary/50 transition-colors cursor-pointer h-full">
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between">
                    <div className="space-y-1">
                      <CardTitle className="text-base">{flow.label ?? flow.name}</CardTitle>
                      {flow.description && (
                        <CardDescription className="text-xs line-clamp-2">
                          {flow.description}
                        </CardDescription>
                      )}
                    </div>
                    <ArrowRightIcon className="size-4 text-muted-foreground shrink-0 mt-1" />
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center gap-2">
                    <TriggerBadge trigger={flow.trigger} />
                    {flow.version && (
                      <Badge variant="secondary" className="text-[10px]">
                        v{flow.version}
                      </Badge>
                    )}
                  </div>

                  {/* Mini step pipeline */}
                  <div className="flex items-center gap-1 flex-wrap">
                    {flow.steps.map((step, i) => (
                      <div key={step.id} className="flex items-center gap-1">
                        <StepTypeBadge type={step.type} />
                        {i < flow.steps.length - 1 && (
                          <PlayIcon className="size-2.5 text-muted-foreground rotate-0" />
                        )}
                      </div>
                    ))}
                  </div>

                  <div className="text-xs text-muted-foreground">
                    {flow.stepCount} {t("flows.steps")}
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
