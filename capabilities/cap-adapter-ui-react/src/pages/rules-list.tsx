/**
 * RulesListPage — Lists all registered business rules with filtering.
 *
 * Fetches from /api/rules REST endpoint (with demo data fallback).
 * Spec ref: 05_rule.md
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
  ChevronRightIcon,
  FilterIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

// ── Types ────────────────────────────────────────────────

interface SerializedCondition {
  type?: "code";
  field?: string;
  operator?: string;
  value?: unknown;
  conditions?: SerializedCondition[];
}

interface RuleTrigger {
  action?: string | string[];
  stateChange?: { schema: string; from?: string; to?: string };
  fieldChange?: { schema: string; field: string };
  event?: string;
  schedule?: string;
}

interface RuleEffect {
  type: "block" | "warn" | "require_approval" | "enrich" | "execute_action";
  message?: string;
  reason?: string;
  level?: string;
  action?: string;
  setFields?: Record<string, unknown>;
  params?: Record<string, unknown>;
}

export interface RuleListItem {
  name: string;
  label: string;
  description?: string;
  priority: number;
  trigger: RuleTrigger;
  condition: SerializedCondition;
  effect: RuleEffect;
}

// ── Helpers ────────────────────────────────────────────────

function getTriggerType(trigger: RuleTrigger): string {
  if ("action" in trigger && trigger.action) return "action";
  if ("stateChange" in trigger && trigger.stateChange) return "stateChange";
  if ("fieldChange" in trigger && trigger.fieldChange) return "fieldChange";
  if ("event" in trigger && trigger.event) return "event";
  if ("schedule" in trigger && trigger.schedule) return "schedule";
  return "unknown";
}

function getTriggerSummary(trigger: RuleTrigger, t: (key: string) => string): string {
  if ("action" in trigger && trigger.action) {
    const actions = Array.isArray(trigger.action) ? trigger.action : [trigger.action];
    return `${t("rules.triggerTypes.action")}: ${actions.join(", ")}`;
  }
  if ("stateChange" in trigger && trigger.stateChange) {
    const sc = trigger.stateChange;
    const parts = [sc.schema];
    if (sc.from) parts.push(`${sc.from} ->`);
    if (sc.to) parts.push(sc.to);
    return `${t("rules.triggerTypes.stateChange")}: ${parts.join(" ")}`;
  }
  if ("fieldChange" in trigger && trigger.fieldChange) {
    return `${t("rules.triggerTypes.fieldChange")}: ${trigger.fieldChange.schema}.${trigger.fieldChange.field}`;
  }
  if ("event" in trigger && trigger.event) {
    return `${t("rules.triggerTypes.event")}: ${trigger.event}`;
  }
  if ("schedule" in trigger && trigger.schedule) {
    return `${t("rules.triggerTypes.schedule")}: ${trigger.schedule}`;
  }
  return t("common.none");
}

function getSchemaFromTrigger(trigger: RuleTrigger): string | undefined {
  if ("stateChange" in trigger && trigger.stateChange) return trigger.stateChange.schema;
  if ("fieldChange" in trigger && trigger.fieldChange) return trigger.fieldChange.schema;
  if ("action" in trigger && trigger.action) {
    const actions = Array.isArray(trigger.action) ? trigger.action : [trigger.action];
    // Extract schema from action name (convention: schema_action)
    const first = actions[0];
    if (first) {
      const parts = first.split("_");
      if (parts.length > 1) return parts.slice(0, -1).join("_");
    }
  }
  return undefined;
}

function getConditionSummary(condition: SerializedCondition): string {
  if (condition.type === "code") return "Code condition";
  if (condition.field && condition.operator) {
    const val = condition.value !== undefined ? ` ${JSON.stringify(condition.value)}` : "";
    return `${condition.field} ${condition.operator}${val}`;
  }
  if (condition.operator && condition.conditions) {
    return `${condition.operator.toUpperCase()} (${condition.conditions.length} conditions)`;
  }
  return "N/A";
}

// ── Effect badge ────────────────────────────────────────

const EFFECT_VARIANTS: Record<string, "default" | "destructive" | "outline" | "secondary"> = {
  block: "destructive",
  warn: "secondary",
  require_approval: "outline",
  enrich: "default",
  execute_action: "default",
};

function EffectBadge({ type }: { type: string }) {
  return <Badge variant={EFFECT_VARIANTS[type] ?? "outline"}>{type}</Badge>;
}

// ── Demo data ────────────────────────────────────────────

const DEMO_RULES: RuleListItem[] = [
  {
    name: "amount_check",
    label: "High-value purchase requires approval",
    description: "Purchase requests over 10,000 require director approval",
    priority: 10,
    trigger: { action: "submit_request" },
    condition: { field: "target.amount", operator: "gt", value: 10000 },
    effect: { type: "require_approval", level: "director", message: "Amount exceeds 10,000 — director approval required" },
  },
  {
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
  {
    name: "auto_priority",
    label: "Auto-set priority for large orders",
    priority: 5,
    trigger: { action: "create_purchase_request" },
    condition: { field: "target.amount", operator: "gte", value: 5000 },
    effect: { type: "enrich", setFields: { priority: "high" } },
  },
  {
    name: "state_notification",
    label: "Notify on approval",
    priority: 0,
    trigger: { stateChange: { schema: "purchase_request", to: "approved" } },
    condition: { type: "code" },
    effect: { type: "execute_action", action: "send_notification", params: { template: "approval_notice" } },
  },
];

// ── Component ────────────────────────────────────────────

export function RulesListPage() {
  const { t } = useTranslation();
  const [rules, setRules] = useState<RuleListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [schemaFilter, setSchemaFilter] = useState<string>("all");
  const [triggerFilter, setTriggerFilter] = useState<string>("all");

  const fetchRules = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (schemaFilter !== "all") params.set("schema", schemaFilter);
      if (triggerFilter !== "all") params.set("triggerType", triggerFilter);

      const res = await fetch(`/api/rules?${params.toString()}`);
      if (res.ok) {
        const json = await res.json();
        setRules(json.data ?? []);
      } else {
        // Fallback to demo data
        applyDemoFilters();
      }
    } catch {
      applyDemoFilters();
    } finally {
      setLoading(false);
    }
  }, [schemaFilter, triggerFilter]);

  const applyDemoFilters = useCallback(() => {
    let filtered = DEMO_RULES;
    if (schemaFilter !== "all") {
      filtered = filtered.filter((r) => {
        const schema = getSchemaFromTrigger(r.trigger);
        return schema?.includes(schemaFilter);
      });
    }
    if (triggerFilter !== "all") {
      filtered = filtered.filter((r) => getTriggerType(r.trigger) === triggerFilter);
    }
    setRules(filtered);
  }, [schemaFilter, triggerFilter]);

  useEffect(() => {
    fetchRules();
  }, [fetchRules]);

  // Collect unique schemas from rules for filter dropdown
  const schemas = [...new Set(rules.map((r) => getSchemaFromTrigger(r.trigger)).filter(Boolean))] as string[];

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">{t("rules.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("rules.subtitle")}</p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchRules} disabled={loading}>
          <RefreshCwIcon className={`size-4 mr-1 ${loading ? "animate-spin" : ""}`} />
          {t("executionLog.refresh")}
        </Button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2">
        <FilterIcon className="size-4 text-muted-foreground" />
        <Select
          value={triggerFilter}
          onValueChange={(v) => setTriggerFilter(v)}
        >
          <SelectTrigger className="w-44">
            <SelectValue placeholder={t("rules.allTriggers")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("rules.allTriggers")}</SelectItem>
            <SelectItem value="action">{t("rules.triggerTypes.action")}</SelectItem>
            <SelectItem value="stateChange">{t("rules.triggerTypes.stateChange")}</SelectItem>
            <SelectItem value="fieldChange">{t("rules.triggerTypes.fieldChange")}</SelectItem>
            <SelectItem value="event">{t("rules.triggerTypes.event")}</SelectItem>
            <SelectItem value="schedule">{t("rules.triggerTypes.schedule")}</SelectItem>
          </SelectContent>
        </Select>
        {schemas.length > 0 && (
          <Select
            value={schemaFilter}
            onValueChange={(v) => setSchemaFilter(v)}
          >
            <SelectTrigger className="w-44">
              <SelectValue placeholder={t("rules.allSchemas")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("rules.allSchemas")}</SelectItem>
              {schemas.map((s) => (
                <SelectItem key={s} value={s}>{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <span className="text-sm text-muted-foreground ml-2">
          {rules.length} {t("rules.rulesCount")}
        </span>
      </div>

      {/* Rules Grid */}
      {rules.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <ShieldCheckIcon className="size-12 mb-4 opacity-50" />
          <p className="text-sm">{loading ? t("common.loading") : t("rules.noRules")}</p>
        </div>
      ) : (
        <div className="grid gap-3">
          {rules.map((rule) => (
            <Link
              key={rule.name}
              to="/admin/rules/$name"
              params={{ name: rule.name }}
              className="block"
            >
              <Card className="hover:bg-muted/30 transition-colors cursor-pointer">
                <CardHeader className="py-3 px-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <CardTitle className="text-sm font-medium">{rule.label}</CardTitle>
                      <EffectBadge type={rule.effect.type} />
                      {rule.priority > 0 && (
                        <Badge variant="outline" className="text-[10px]">
                          P{rule.priority}
                        </Badge>
                      )}
                    </div>
                    <ChevronRightIcon className="size-4 text-muted-foreground" />
                  </div>
                  <CardDescription className="text-xs font-mono">{rule.name}</CardDescription>
                </CardHeader>
                <CardContent className="py-2 px-4 pb-3">
                  <div className="grid grid-cols-3 gap-4 text-xs">
                    <div>
                      <span className="text-muted-foreground">{t("rules.trigger")}:</span>{" "}
                      <span>{getTriggerSummary(rule.trigger, t)}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">{t("rules.condition")}:</span>{" "}
                      <span className="font-mono">{getConditionSummary(rule.condition)}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">{t("rules.effectLabel")}:</span>{" "}
                      <span>{rule.effect.message ?? rule.effect.type}</span>
                    </div>
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
