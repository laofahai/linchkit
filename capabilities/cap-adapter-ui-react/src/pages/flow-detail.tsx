/**
 * FlowDetailPage — Visual flow step diagram with step details.
 *
 * Route: /admin/flows/$name
 * Renders flow steps as connected boxes with SVG arrows.
 */

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@linchkit/ui-kit/components";
import { useParams } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  BotIcon,
  CheckCircle2Icon,
  ClockIcon,
  GitForkIcon,
  PlayIcon,
  ShieldCheckIcon,
  SplitIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "@tanstack/react-router";

// ── Types ────────────────────────────────────────────────

interface FlowStep {
  id: string;
  name: string;
  type: string;
  description?: string;
  actionName?: string;
  expression?: string;
  then?: string;
  else?: string;
  prompt?: string | { template: string; variables: Record<string, string> };
  model?: string;
  approvers?: string[];
  timeout?: number;
  onTimeout?: string;
  duration?: number;
  signal?: string;
  steps?: string[];
  joinType?: string;
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
}

// ── Demo data ────────────────────────────────────────────

const DEMO_FLOWS: Record<string, FlowDetail> = {
  purchase_approval_flow: {
    name: "purchase_approval_flow",
    label: "Purchase Approval",
    description: "Multi-step purchase request approval process with budget check",
    version: 1,
    trigger: { type: "event", eventType: "action.succeeded.submit_request" },
    onError: "compensate",
    steps: [
      { id: "calc", name: "Calculate Total", type: "action", actionName: "calculate_total" },
      { id: "check", name: "Budget Check", type: "condition", expression: "$prev.output.amount > 10000", then: "approval", else: "notify" },
      { id: "approval", name: "Manager Approval", type: "approval", approvers: ["managers"], timeout: 604800000, onTimeout: "reject" },
      { id: "notify", name: "Notify Requester", type: "action", actionName: "notify_requester" },
    ],
  },
  ai_evolution_analysis: {
    name: "ai_evolution_analysis",
    label: "AI Evolution Analysis",
    description: "Weekly AI analysis of execution data to discover optimization opportunities",
    version: 1,
    trigger: { type: "schedule", cron: "0 2 * * 1" },
    steps: [
      { id: "collect", name: "Collect Data", type: "action", actionName: "collect_execution_stats" },
      { id: "analyze", name: "AI Analyze", type: "ai", prompt: "Analyze execution data for optimization", model: "claude-sonnet" },
      { id: "gen_proposals", name: "Generate Proposals", type: "ai", prompt: "Generate Rule/Schema change suggestions" },
      { id: "create", name: "Create Proposals", type: "action", actionName: "create_proposal" },
    ],
  },
  onboarding_flow: {
    name: "onboarding_flow",
    label: "Employee Onboarding",
    description: "Automated onboarding process for new employees",
    version: 1,
    trigger: { type: "manual" },
    steps: [
      { id: "create_account", name: "Create Account", type: "action", actionName: "create_employee_account" },
      { id: "setup", name: "Setup Tasks", type: "parallel", steps: ["provision_laptop", "create_email"], joinType: "all" },
      { id: "wait_docs", name: "Wait for Documents", type: "wait", signal: "documents_uploaded", timeout: 259200000 },
      { id: "review", name: "HR Review", type: "approval", approvers: ["hr_team"] },
      { id: "welcome", name: "Send Welcome", type: "action", actionName: "send_welcome_email" },
    ],
  },
};

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
    icon: <BotIcon className="size-4" />,
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
  return STEP_CONFIG[type] ?? {
    color: "#6b7280",
    bgClass: "bg-muted border-border",
    icon: <CheckCircle2Icon className="size-4" />,
  };
}

// ── Step detail summary ──────────────────────────────────

function StepDetail({ step }: { step: FlowStep }) {
  const { t } = useTranslation();
  const details: Array<{ label: string; value: string }> = [];

  if (step.type === "action" && step.actionName) {
    details.push({ label: t("flows.stepAction"), value: step.actionName });
  }
  if (step.type === "condition" && step.expression) {
    details.push({ label: t("flows.stepCondition"), value: step.expression });
    if (step.then) details.push({ label: "Then", value: step.then });
    if (step.else) details.push({ label: "Else", value: step.else });
  }
  if (step.type === "ai") {
    const promptText = typeof step.prompt === "string" ? step.prompt : step.prompt?.template ?? "";
    if (promptText) details.push({ label: t("flows.stepPrompt"), value: promptText.slice(0, 80) + (promptText.length > 80 ? "..." : "") });
    if (step.model) details.push({ label: t("flows.stepModel"), value: step.model });
  }
  if (step.type === "approval") {
    if (step.approvers?.length) details.push({ label: t("flows.stepApprovers"), value: step.approvers.join(", ") });
    if (step.onTimeout) details.push({ label: t("flows.stepOnTimeout"), value: step.onTimeout });
  }
  if (step.type === "wait") {
    if (step.signal) details.push({ label: t("flows.stepSignal"), value: step.signal });
  }
  if (step.type === "parallel") {
    if (step.steps?.length) details.push({ label: t("flows.stepParallelSteps"), value: step.steps.join(", ") });
    if (step.joinType) details.push({ label: t("flows.stepJoinType"), value: step.joinType });
  }

  if (details.length === 0) return null;

  return (
    <div className="mt-1 space-y-0.5">
      {details.map((d) => (
        <div key={d.label} className="text-[10px] text-muted-foreground truncate">
          <span className="font-medium">{d.label}:</span> {d.value}
        </div>
      ))}
    </div>
  );
}

// ── Flow diagram component ───────────────────────────────

function FlowDiagram({ steps }: { steps: FlowStep[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [positions, setPositions] = useState<Array<{ x: number; y: number; w: number; h: number }>>([]);

  useEffect(() => {
    if (!containerRef.current) return;
    const nodes = containerRef.current.querySelectorAll("[data-step-node]");
    const newPositions: Array<{ x: number; y: number; w: number; h: number }> = [];
    const containerRect = containerRef.current.getBoundingClientRect();
    for (const node of nodes) {
      const rect = (node as HTMLElement).getBoundingClientRect();
      newPositions.push({
        x: rect.left - containerRect.left + rect.width / 2,
        y: rect.top - containerRect.top,
        w: rect.width,
        h: rect.height,
      });
    }
    setPositions(newPositions);
  }, [steps]);

  return (
    <div ref={containerRef} className="relative py-4">
      {/* SVG arrows layer */}
      {positions.length > 1 && (
        <svg
          className="absolute inset-0 pointer-events-none"
          style={{ width: "100%", height: "100%" }}
        >
          <defs>
            <marker
              id="arrowhead"
              markerWidth="8"
              markerHeight="6"
              refX="7"
              refY="3"
              orient="auto"
            >
              <polygon
                points="0 0, 8 3, 0 6"
                className="fill-muted-foreground/50"
              />
            </marker>
          </defs>
          {positions.map((pos, i) => {
            if (i === 0) return null;
            const prev = positions[i - 1];
            if (!prev) return null;
            const startY = prev.y + prev.h;
            const endY = pos.y;
            const midY = (startY + endY) / 2;
            return (
              <path
                key={`arrow-${i}`}
                d={`M ${prev.x} ${startY} C ${prev.x} ${midY}, ${pos.x} ${midY}, ${pos.x} ${endY}`}
                fill="none"
                className="stroke-muted-foreground/40"
                strokeWidth="2"
                markerEnd="url(#arrowhead)"
              />
            );
          })}
        </svg>
      )}

      {/* Step nodes */}
      <div className="flex flex-col items-center gap-6">
        {steps.map((step) => {
          const config = getStepConfig(step.type);
          const isCondition = step.type === "condition";
          return (
            <div
              key={step.id}
              data-step-node
              className={`
                relative border rounded-lg p-3 w-64 shadow-sm
                ${config.bgClass}
                ${isCondition ? "rotate-0" : ""}
              `}
              style={{
                borderLeftWidth: "3px",
                borderLeftColor: config.color,
              }}
            >
              <div className="flex items-center gap-2">
                <span style={{ color: config.color }}>{config.icon}</span>
                <span className="font-medium text-sm">{step.name}</span>
              </div>
              <div className="flex items-center gap-1 mt-1">
                <Badge variant="secondary" className="text-[10px] h-4">
                  {step.type}
                </Badge>
              </div>
              <StepDetail step={step} />
              {isCondition && (
                <div className="absolute -right-2 top-1/2 -translate-y-1/2 flex flex-col gap-1 text-[9px] text-muted-foreground">
                  {step.then && <span className="bg-emerald-100 dark:bg-emerald-900 rounded px-1">Y: {step.then}</span>}
                  {step.else && <span className="bg-red-100 dark:bg-red-900 rounded px-1">N: {step.else}</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Main component ───────────────────────────────────────

export function FlowDetailPage() {
  const { t } = useTranslation();
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
        // Try demo data
        const demo = DEMO_FLOWS[name as string];
        if (demo) {
          setFlow(demo);
        } else {
          setError(t("flows.notFound", { name }));
        }
      }
    } catch {
      const demo = DEMO_FLOWS[name as string];
      if (demo) {
        setFlow(demo);
      } else {
        setError(t("flows.loadFailed"));
      }
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
        <Link to={"/admin/flows" as "/"}>
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
        <Link to={"/admin/flows" as "/"}>
          <Button variant="ghost" size="icon-sm">
            <ArrowLeftIcon className="size-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-lg font-semibold">{flow.label ?? flow.name}</h1>
          {flow.description && (
            <p className="text-sm text-muted-foreground">{flow.description}</p>
          )}
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
        {flow.onError && <Badge variant="secondary">{t("flows.onError")}: {flow.onError}</Badge>}
        <span className="text-sm text-muted-foreground">
          {flow.steps.length} {t("flows.steps")}
        </span>
      </div>

      {/* Flow diagram */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("flows.diagram")}</CardTitle>
        </CardHeader>
        <CardContent className="flex justify-center overflow-auto">
          <FlowDiagram steps={flow.steps} />
        </CardContent>
      </Card>

      {/* Step list table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("flows.stepList")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="p-2 text-left font-medium">#</th>
                  <th className="p-2 text-left font-medium">ID</th>
                  <th className="p-2 text-left font-medium">{t("flows.stepName")}</th>
                  <th className="p-2 text-left font-medium">{t("flows.stepType")}</th>
                  <th className="p-2 text-left font-medium">{t("flows.stepDetails")}</th>
                </tr>
              </thead>
              <tbody>
                {flow.steps.map((step, i) => {
                  const config = getStepConfig(step.type);
                  return (
                    <tr key={step.id} className="border-b">
                      <td className="p-2 text-muted-foreground">{i + 1}</td>
                      <td className="p-2 font-mono text-xs">{step.id}</td>
                      <td className="p-2 font-medium">{step.name}</td>
                      <td className="p-2">
                        <div className="flex items-center gap-1.5" style={{ color: config.color }}>
                          {config.icon}
                          <span className="text-xs">{step.type}</span>
                        </div>
                      </td>
                      <td className="p-2 text-xs text-muted-foreground max-w-xs truncate">
                        {step.type === "action" && step.actionName}
                        {step.type === "condition" && step.expression}
                        {step.type === "ai" && (typeof step.prompt === "string" ? step.prompt.slice(0, 60) : "")}
                        {step.type === "approval" && step.approvers?.join(", ")}
                        {step.type === "wait" && (step.signal ?? "duration")}
                        {step.type === "parallel" && step.steps?.join(", ")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
