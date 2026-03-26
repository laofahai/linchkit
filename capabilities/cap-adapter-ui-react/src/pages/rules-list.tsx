/**
 * RulesListPage — Lists all registered business rules using AutoList.
 *
 * Fetches from /api/rules REST endpoint (with demo data fallback).
 * Spec ref: 05_rule.md
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
  RefreshCwIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AutoList, SortableHeader } from "@/components/auto-list";

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
    const first = actions[0];
    if (first) {
      const parts = first.split("_");
      if (parts.length > 1) return parts.slice(0, -1).join("_");
    }
  }
  return undefined;
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

// ── Trigger type badge ──────────────────────────────────

const TRIGGER_COLORS: Record<string, string> = {
  action: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
  stateChange: "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300",
  fieldChange: "bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300",
  event: "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300",
  schedule: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900 dark:text-cyan-300",
};

function TriggerTypeBadge({ type }: { type: string }) {
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${TRIGGER_COLORS[type] ?? "bg-muted text-muted-foreground"}`}>
      {type}
    </span>
  );
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
  const navigate = useNavigate();
  const [rules, setRules] = useState<RuleListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [schemaFilter, setSchemaFilter] = useState<string>("all");
  const [triggerFilter, setTriggerFilter] = useState<string>("all");

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
        applyDemoFilters();
      }
    } catch {
      applyDemoFilters();
    } finally {
      setLoading(false);
    }
  }, [schemaFilter, triggerFilter, applyDemoFilters]);

  useEffect(() => {
    fetchRules();
  }, [fetchRules]);

  // Collect unique schemas from rules for filter dropdown
  const schemas = [...new Set(rules.map((r) => getSchemaFromTrigger(r.trigger)).filter(Boolean))] as string[];

  // Build AutoList column definitions
  const columns = useMemo<ColumnDef<Record<string, unknown>, unknown>[]>(() => [
    {
      accessorKey: "label",
      header: ({ column }) => <SortableHeader column={column} label={t("rules.columns.name", { defaultValue: "Name" })} />,
      cell: ({ row }) => {
        const rule = row.original as unknown as RuleListItem;
        return (
          <div>
            <div className="font-medium text-sm">{rule.label}</div>
            <div className="text-xs text-muted-foreground font-mono">{rule.name}</div>
          </div>
        );
      },
    },
    {
      id: "schema",
      header: t("rules.columns.schema", { defaultValue: "Schema" }),
      cell: ({ row }) => {
        const rule = row.original as unknown as RuleListItem;
        const schema = getSchemaFromTrigger(rule.trigger);
        return schema ? (
          <span className="text-xs font-mono">{schema}</span>
        ) : (
          <span className="text-xs text-muted-foreground">-</span>
        );
      },
      accessorFn: (row) => {
        const rule = row as unknown as RuleListItem;
        return getSchemaFromTrigger(rule.trigger) ?? "";
      },
      size: 140,
    },
    {
      id: "triggerType",
      header: t("rules.columns.triggerType", { defaultValue: "Trigger" }),
      cell: ({ row }) => {
        const rule = row.original as unknown as RuleListItem;
        const type = getTriggerType(rule.trigger);
        return (
          <div className="space-y-1">
            <TriggerTypeBadge type={type} />
            <div className="text-xs text-muted-foreground truncate max-w-[200px]">
              {getTriggerSummary(rule.trigger, t)}
            </div>
          </div>
        );
      },
      accessorFn: (row) => {
        const rule = row as unknown as RuleListItem;
        return getTriggerType(rule.trigger);
      },
      size: 220,
    },
    {
      id: "effectType",
      header: t("rules.columns.effect", { defaultValue: "Effect" }),
      cell: ({ row }) => {
        const rule = row.original as unknown as RuleListItem;
        return <EffectBadge type={rule.effect.type} />;
      },
      accessorFn: (row) => {
        const rule = row as unknown as RuleListItem;
        return rule.effect.type;
      },
      size: 130,
    },
    {
      accessorKey: "priority",
      header: ({ column }) => <SortableHeader column={column} label={t("rules.columns.priority", { defaultValue: "Priority" })} />,
      cell: ({ row }) => {
        const priority = row.getValue("priority") as number;
        return priority > 0 ? (
          <Badge variant="outline" className="text-[10px]">P{priority}</Badge>
        ) : (
          <span className="text-xs text-muted-foreground">P0</span>
        );
      },
      size: 80,
    },
  ], [t]);

  // Convert rules to DataRow for AutoList
  const tableData = useMemo<Record<string, unknown>[]>(
    () => rules.map((r) => ({ ...r }) as Record<string, unknown>),
    [rules],
  );

  return (
    <div className="p-4">
      <AutoList
        externalColumns={columns}
        data={tableData}
        pageSize={20}
        loading={loading}
        onRowClick={(id) => {
          navigate({ to: "/admin/rules/$name", params: { name: id } });
        }}
        toolbarExtra={
          <>
            <Select value={triggerFilter} onValueChange={setTriggerFilter}>
              <SelectTrigger className="w-44 h-7 text-[0.8rem]">
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
              <Select value={schemaFilter} onValueChange={setSchemaFilter}>
                <SelectTrigger className="w-44 h-7 text-[0.8rem]">
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
            <span className="text-sm text-muted-foreground">
              {rules.length} {t("rules.rulesCount")}
            </span>
            <Button variant="outline" size="icon-sm" onClick={fetchRules} disabled={loading} title={t("executionLog.refresh")}>
              <RefreshCwIcon className={`size-4 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </>
        }
      />
    </div>
  );
}
