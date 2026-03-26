/**
 * RuleDetailPage — Displays full rule definition with condition tree visualization.
 *
 * Fetches from /api/rules/:name REST endpoint (with demo data fallback).
 * Spec ref: 05_rule.md
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
import {
  ArrowLeftIcon,
  BanIcon,
  BellIcon,
  BracketsIcon,
  CalendarIcon,
  CheckCircleIcon,
  ChevronRightIcon,
  ClipboardCheckIcon,
  CodeIcon,
  GitBranchIcon,
  PlayIcon,
  ShieldAlertIcon,
  TriangleAlertIcon,
  ZapIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RuleListItem } from "./rules-list";

// ── Types ────────────────────────────────────────────────

interface SerializedCondition {
  type?: "code";
  field?: string;
  operator?: string;
  value?: unknown;
  conditions?: SerializedCondition[];
  condition?: SerializedCondition;
}

// ── Trigger display ────────────────────────────────────────

function TriggerDisplay({ trigger, t }: { trigger: RuleListItem["trigger"]; t: (key: string) => string }) {
  if ("action" in trigger && trigger.action) {
    const actions = Array.isArray(trigger.action) ? trigger.action : [trigger.action];
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <PlayIcon className="size-4" />
          {t("rules.triggerTypes.action")}
        </div>
        <div className="flex flex-wrap gap-1">
          {actions.map((a) => (
            <Badge key={a} variant="outline" className="font-mono text-xs">{a}</Badge>
          ))}
        </div>
      </div>
    );
  }
  if ("stateChange" in trigger && trigger.stateChange) {
    const sc = trigger.stateChange;
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <GitBranchIcon className="size-4" />
          {t("rules.triggerTypes.stateChange")}
        </div>
        <div className="flex items-center gap-2 text-xs">
          <Badge variant="outline">{sc.schema}</Badge>
          {sc.from && <Badge variant="secondary">{sc.from}</Badge>}
          {(sc.from || sc.to) && <ChevronRightIcon className="size-3" />}
          {sc.to && <Badge variant="secondary">{sc.to}</Badge>}
        </div>
      </div>
    );
  }
  if ("fieldChange" in trigger && trigger.fieldChange) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <BracketsIcon className="size-4" />
          {t("rules.triggerTypes.fieldChange")}
        </div>
        <div className="text-xs">
          <Badge variant="outline" className="font-mono">
            {trigger.fieldChange.schema}.{trigger.fieldChange.field}
          </Badge>
        </div>
      </div>
    );
  }
  if ("event" in trigger && trigger.event) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <ZapIcon className="size-4" />
          {t("rules.triggerTypes.event")}
        </div>
        <Badge variant="outline" className="font-mono text-xs">{trigger.event}</Badge>
      </div>
    );
  }
  if ("schedule" in trigger && trigger.schedule) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <CalendarIcon className="size-4" />
          {t("rules.triggerTypes.schedule")}
        </div>
        <Badge variant="outline" className="font-mono text-xs">{trigger.schedule}</Badge>
      </div>
    );
  }
  return <span className="text-muted-foreground text-sm">N/A</span>;
}

// ── Condition tree visualization ────────────────────────

function ConditionNode({ condition, depth = 0 }: { condition: SerializedCondition; depth?: number }) {
  if (condition.type === "code") {
    return (
      <div className="flex items-center gap-2 text-xs p-2 bg-muted/50 rounded border" style={{ marginLeft: depth * 16 }}>
        <CodeIcon className="size-3.5 text-muted-foreground shrink-0" />
        <span className="text-muted-foreground italic">Code-based condition (function)</span>
      </div>
    );
  }

  // Simple condition: field operator value
  if (condition.field && condition.operator) {
    return (
      <div className="flex items-center gap-2 text-xs p-2 bg-muted/50 rounded border" style={{ marginLeft: depth * 16 }}>
        <span className="font-mono font-medium text-blue-600 dark:text-blue-400">{condition.field}</span>
        <Badge variant="outline" className="text-[10px] shrink-0">{condition.operator}</Badge>
        {condition.value !== undefined && (
          <span className="font-mono text-green-600 dark:text-green-400">{JSON.stringify(condition.value)}</span>
        )}
      </div>
    );
  }

  // Composite condition: AND/OR
  if (condition.operator && condition.conditions) {
    return (
      <div className="space-y-1" style={{ marginLeft: depth * 16 }}>
        <div className="flex items-center gap-1 text-xs font-medium">
          <Badge variant="secondary" className="text-[10px]">{condition.operator.toUpperCase()}</Badge>
        </div>
        {condition.conditions.map((child, i) => (
          <ConditionNode key={`${child.field ?? child.operator ?? "n"}-${i}`} condition={child} depth={depth + 1} />
        ))}
      </div>
    );
  }

  // NOT condition
  if (condition.operator === "not" && condition.condition) {
    return (
      <div className="space-y-1" style={{ marginLeft: depth * 16 }}>
        <Badge variant="secondary" className="text-[10px]">NOT</Badge>
        <ConditionNode condition={condition.condition} depth={depth + 1} />
      </div>
    );
  }

  return <span className="text-xs text-muted-foreground" style={{ marginLeft: depth * 16 }}>N/A</span>;
}

// ── Effect display ────────────────────────────────────────

function EffectDisplay({ effect, t }: { effect: RuleListItem["effect"]; t: (key: string) => string }) {
  const iconMap: Record<string, React.ReactNode> = {
    block: <BanIcon className="size-4 text-destructive" />,
    warn: <TriangleAlertIcon className="size-4 text-yellow-500" />,
    require_approval: <ClipboardCheckIcon className="size-4 text-blue-500" />,
    enrich: <CheckCircleIcon className="size-4 text-green-500" />,
    execute_action: <PlayIcon className="size-4 text-purple-500" />,
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        {iconMap[effect.type] ?? <ShieldAlertIcon className="size-4" />}
        <span className="text-sm font-medium">{t(`rules.effectTypes.${effect.type}`)}</span>
      </div>
      {effect.message && (
        <div className="text-sm bg-muted/50 rounded p-2 border">
          <BellIcon className="size-3 inline mr-1 text-muted-foreground" />
          {effect.message}
        </div>
      )}
      {effect.reason && (
        <div className="text-xs text-muted-foreground">
          {t("rules.reason")}: <code className="bg-muted px-1 rounded">{effect.reason}</code>
        </div>
      )}
      {effect.level && (
        <div className="text-xs text-muted-foreground">
          {t("rules.approvalLevel")}: <Badge variant="outline">{effect.level}</Badge>
        </div>
      )}
      {effect.action && (
        <div className="text-xs text-muted-foreground">
          {t("rules.targetAction")}: <Badge variant="outline" className="font-mono">{effect.action}</Badge>
        </div>
      )}
      {effect.setFields && Object.keys(effect.setFields).length > 0 && (
        <div className="text-xs">
          <span className="text-muted-foreground">{t("rules.enrichFields")}:</span>
          <pre className="bg-muted rounded p-2 mt-1 text-xs overflow-auto max-h-32">
            {JSON.stringify(effect.setFields, null, 2)}
          </pre>
        </div>
      )}
      {effect.params && Object.keys(effect.params).length > 0 && (
        <div className="text-xs">
          <span className="text-muted-foreground">{t("rules.actionParams")}:</span>
          <pre className="bg-muted rounded p-2 mt-1 text-xs overflow-auto max-h-32">
            {JSON.stringify(effect.params, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

// ── Demo fallback ────────────────────────────────────────

const DEMO_RULES: Record<string, RuleListItem> = {
  amount_check: {
    name: "amount_check",
    label: "High-value purchase requires approval",
    description: "Purchase requests over 10,000 require director approval",
    priority: 10,
    trigger: { action: "submit_request" },
    condition: { field: "target.amount", operator: "gt", value: 10000 },
    effect: { type: "require_approval", level: "director", message: "Amount exceeds 10,000 — director approval required" },
  },
  budget_check: {
    name: "budget_check",
    label: "Department budget limit",
    description: "Block purchases that exceed department quarterly budget",
    priority: 20,
    trigger: { action: "submit_request" },
    condition: { operator: "and", conditions: [
      { field: "target.amount", operator: "gt", value: 20000 },
      { field: "target.department", operator: "eq", value: "Engineering" },
    ] },
    effect: { type: "block", message: "Amount exceeds department budget", reason: "BUDGET.EXCEEDED" },
  },
  auto_priority: {
    name: "auto_priority",
    label: "Auto-set priority for large orders",
    description: "Automatically set priority to high for orders >= 5000",
    priority: 5,
    trigger: { action: "create_purchase_request" },
    condition: { field: "target.amount", operator: "gte", value: 5000 },
    effect: { type: "enrich", setFields: { priority: "high" } },
  },
  state_notification: {
    name: "state_notification",
    label: "Notify on approval",
    description: "Send notification email when a purchase request is approved",
    priority: 0,
    trigger: { stateChange: { schema: "purchase_request", to: "approved" } },
    condition: { type: "code" },
    effect: { type: "execute_action", action: "send_notification", params: { template: "approval_notice" } },
  },
};

// ── Component ────────────────────────────────────────────

export function RuleDetailPage() {
  const { t } = useTranslation();
  // biome-ignore lint/suspicious/noExplicitAny: TanStack Router params typing
  const { name } = useParams({ strict: false }) as any;
  const [rule, setRule] = useState<RuleListItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchRule = useCallback(async () => {
    if (!name) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/rules/${name}`);
      if (res.ok) {
        const json = await res.json();
        setRule(json.data ?? null);
      } else if (res.status === 404) {
        // Try demo data
        const demo = DEMO_RULES[name];
        if (demo) {
          setRule(demo);
        } else {
          setError(t("rules.ruleNotFound"));
        }
      } else {
        const demo = DEMO_RULES[name];
        setRule(demo ?? null);
      }
    } catch {
      const demo = DEMO_RULES[name];
      if (demo) {
        setRule(demo);
      } else {
        setError(t("rules.ruleNotFound"));
      }
    } finally {
      setLoading(false);
    }
  }, [name, t]);

  useEffect(() => {
    fetchRule();
  }, [fetchRule]);

  if (loading) {
    return (
      <div className="p-4 flex items-center justify-center py-16">
        <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
      </div>
    );
  }

  if (error || !rule) {
    return (
      <div className="p-4 space-y-4">
        <Button variant="ghost" size="sm" asChild>
          <Link to="/admin/rules">
            <ArrowLeftIcon className="size-4 mr-1" />
            {t("common.back")}
          </Link>
        </Button>
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <ShieldAlertIcon className="size-12 mb-4 opacity-50" />
          <p className="text-sm">{error ?? t("rules.ruleNotFound")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4">
      {/* Back + Header */}
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" asChild>
          <Link to="/admin/rules">
            <ArrowLeftIcon className="size-4 mr-1" />
            {t("common.back")}
          </Link>
        </Button>
      </div>

      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold">{rule.label}</h1>
          <Badge variant={rule.effect.type === "block" ? "destructive" : rule.effect.type === "warn" ? "secondary" : "outline"}>
            {rule.effect.type}
          </Badge>
          {rule.priority > 0 && (
            <Badge variant="outline" className="text-[10px]">P{rule.priority}</Badge>
          )}
        </div>
        <p className="text-sm text-muted-foreground font-mono">{rule.name}</p>
        {rule.description && (
          <p className="text-sm text-muted-foreground mt-1">{rule.description}</p>
        )}
      </div>

      {/* Three column layout */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Trigger */}
        <Card>
          <CardHeader className="py-3 px-4">
            <CardTitle className="text-sm">{t("rules.trigger")}</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <TriggerDisplay trigger={rule.trigger} t={t} />
          </CardContent>
        </Card>

        {/* Condition */}
        <Card>
          <CardHeader className="py-3 px-4">
            <CardTitle className="text-sm">{t("rules.condition")}</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <ConditionNode condition={rule.condition} />
          </CardContent>
        </Card>

        {/* Effect */}
        <Card>
          <CardHeader className="py-3 px-4">
            <CardTitle className="text-sm">{t("rules.effectLabel")}</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <EffectDisplay effect={rule.effect} t={t} />
          </CardContent>
        </Card>
      </div>

      {/* Raw JSON */}
      <Card>
        <CardHeader className="py-3 px-4">
          <CardTitle className="text-sm">{t("rules.rawDefinition")}</CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          <pre className="bg-muted rounded p-3 text-xs overflow-auto max-h-64 font-mono">
            {JSON.stringify(rule, null, 2)}
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}
