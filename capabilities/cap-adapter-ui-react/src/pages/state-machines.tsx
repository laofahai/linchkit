/**
 * StateMachinesPage — Lists all registered state machines using AutoList.
 *
 * Route: /admin/states
 * Fetches from /api/states REST endpoint (falls back to demo data).
 */

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@linchkit/ui-kit/components";
import type { ColumnDef } from "@tanstack/react-table";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CircleDotIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "@tanstack/react-router";
import { AutoList, SortableHeader } from "@/components/auto-list";
import {
  StateDiagram,
  type StateMachineDetail,
} from "../components/state-diagram";

// ── Types ────────────────────────────────────────────────

interface StateMeta {
  label: string;
  color?: string;
  description?: string;
}

interface StateMachineSummary {
  name: string;
  schema: string;
  field: string;
  initial: string;
  stateCount: number;
  transitionCount: number;
  states: string[];
  meta?: Record<string, StateMeta>;
}

// ── Demo data ────────────────────────────────────────────

const DEMO_STATES: StateMachineSummary[] = [
  {
    name: "purchase_request_lifecycle",
    schema: "purchase_request",
    field: "status",
    initial: "draft",
    stateCount: 4,
    transitionCount: 4,
    states: ["draft", "pending", "approved", "rejected"],
    meta: {
      draft: { label: "t:states.draft", color: "#6b7280" },
      pending: { label: "t:states.pending", color: "#f59e0b" },
      approved: { label: "t:states.approved", color: "#10b981" },
      rejected: { label: "t:states.rejected", color: "#ef4444" },
    },
  },
  {
    name: "order_lifecycle",
    schema: "order",
    field: "status",
    initial: "new",
    stateCount: 5,
    transitionCount: 5,
    states: ["new", "confirmed", "shipped", "delivered", "cancelled"],
    meta: {
      new: { label: "t:states.new", color: "#3b82f6" },
      confirmed: { label: "t:states.confirmed", color: "#8b5cf6" },
      shipped: { label: "t:states.shipped", color: "#f59e0b" },
      delivered: { label: "t:states.delivered", color: "#10b981" },
      cancelled: { label: "t:states.cancelled", color: "#ef4444" },
    },
  },
];

const DEMO_DETAILS: Record<string, StateMachineDetail> = {
  purchase_request_lifecycle: {
    name: "purchase_request_lifecycle",
    schema: "purchase_request",
    field: "status",
    initial: "draft",
    states: ["draft", "pending", "approved", "rejected"],
    transitions: [
      { from: "draft", to: "pending", action: "submit_for_approval" },
      { from: "pending", to: "approved", action: "approve" },
      { from: "pending", to: "rejected", action: "reject" },
      { from: "rejected", to: "draft", action: "reopen" },
    ],
    meta: {
      draft: { label: "t:states.draft", color: "#6b7280" },
      pending: { label: "t:states.pending", color: "#f59e0b" },
      approved: { label: "t:states.approved", color: "#10b981" },
      rejected: { label: "t:states.rejected", color: "#ef4444" },
    },
  },
  order_lifecycle: {
    name: "order_lifecycle",
    schema: "order",
    field: "status",
    initial: "new",
    states: ["new", "confirmed", "shipped", "delivered", "cancelled"],
    transitions: [
      { from: "new", to: "confirmed", action: "confirm_order" },
      { from: "confirmed", to: "shipped", action: "ship_order" },
      { from: "shipped", to: "delivered", action: "deliver_order" },
      { from: "new", to: "cancelled", action: "cancel_order" },
      { from: "confirmed", to: "cancelled", action: "cancel_order" },
    ],
    meta: {
      new: { label: "t:states.new", color: "#3b82f6" },
      confirmed: { label: "t:states.confirmed", color: "#8b5cf6" },
      shipped: { label: "t:states.shipped", color: "#f59e0b" },
      delivered: { label: "t:states.delivered", color: "#10b981" },
      cancelled: { label: "t:states.cancelled", color: "#ef4444" },
    },
  },
};

// ── Default state color ──────────────────────────────────

const DEFAULT_STATE_COLOR = "#6b7280";

function getStateColor(stateName: string, meta?: Record<string, StateMeta>): string {
  return meta?.[stateName]?.color ?? DEFAULT_STATE_COLOR;
}

/**
 * Resolve state label from meta, supporting `t:` i18n prefix.
 * Falls back to raw state name if no label is found.
 */
function getStateLabel(
  stateName: string,
  meta?: Record<string, StateMeta>,
  t?: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const raw = meta?.[stateName]?.label ?? stateName;
  if (raw.startsWith("t:") && t) {
    const key = raw.slice(2);
    return t(key, { defaultValue: stateName });
  }
  return raw;
}

// ── State machines list page ─────────────────────────────

export function StateMachinesPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [machines, setMachines] = useState<StateMachineSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [schemaFilter, setSchemaFilter] = useState<string>("all");

  const fetchMachines = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/states");
      if (res.ok) {
        const json = await res.json();
        setMachines(json.data ?? []);
      } else {
        setMachines(DEMO_STATES);
      }
    } catch {
      setMachines(DEMO_STATES);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMachines();
  }, [fetchMachines]);

  const allSchemas = [...new Set(machines.map((m) => m.schema))];
  const filtered = schemaFilter === "all"
    ? machines
    : machines.filter((m) => m.schema === schemaFilter);

  // Build AutoList column definitions
  const columns = useMemo<ColumnDef<Record<string, unknown>, unknown>[]>(() => [
    {
      accessorKey: "name",
      header: ({ column }) => <SortableHeader column={column} label={t("stateMachines.columns.name", { defaultValue: "Name" })} />,
      cell: ({ row }) => {
        const machine = row.original as unknown as StateMachineSummary;
        return (
          <div>
            <div className="font-medium text-sm">{machine.name}</div>
            <div className="text-xs text-muted-foreground font-mono">
              {machine.schema}.{machine.field}
            </div>
          </div>
        );
      },
    },
    {
      accessorKey: "schema",
      header: ({ column }) => <SortableHeader column={column} label={t("stateMachines.columns.schema", { defaultValue: "Schema" })} />,
      cell: ({ row }) => (
        <span className="text-xs font-mono">{row.getValue("schema") as string}</span>
      ),
      size: 140,
    },
    {
      id: "states",
      header: t("stateMachines.columns.states", { defaultValue: "States" }),
      cell: ({ row }) => {
        const machine = row.original as unknown as StateMachineSummary;
        return (
          <div className="flex items-center gap-1 flex-wrap">
            {machine.states.map((s) => (
              <Badge
                key={s}
                variant="outline"
                className="text-[10px]"
                style={{
                  borderColor: getStateColor(s, machine.meta),
                  color: getStateColor(s, machine.meta),
                }}
              >
                {s === machine.initial && <CircleDotIcon className="size-2.5 mr-0.5" />}
                {getStateLabel(s, machine.meta, t)}
              </Badge>
            ))}
          </div>
        );
      },
    },
    {
      accessorKey: "stateCount",
      header: ({ column }) => <SortableHeader column={column} label={t("stateMachines.states", { defaultValue: "States" })} />,
      cell: ({ row }) => {
        const machine = row.original as unknown as StateMachineSummary;
        return (
          <span className="text-xs text-muted-foreground">
            {machine.stateCount} / {machine.transitionCount}
          </span>
        );
      },
      size: 100,
    },
    {
      id: "navigate",
      header: "",
      size: 40,
      cell: () => (
        <ArrowRightIcon className="size-4 text-muted-foreground" />
      ),
    },
  ], [t]);

  // Convert to DataRow for AutoList
  const tableData = useMemo<Record<string, unknown>[]>(
    () => filtered.map((m) => ({ ...m, id: m.name }) as Record<string, unknown>),
    [filtered],
  );

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">{t("stateMachines.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("stateMachines.subtitle")}</p>
        </div>
      </div>

      <AutoList
        externalColumns={columns}
        data={tableData}
        pageSize={20}
        loading={loading}
        onRowClick={(id) => {
          navigate({ to: "/admin/states/$name" as string, params: { name: id } } as Parameters<typeof navigate>[0]);
        }}
        toolbarExtra={
          <>
            {allSchemas.length > 1 && (
              <Select value={schemaFilter} onValueChange={setSchemaFilter}>
                <SelectTrigger className="w-48 h-7 text-[0.8rem]">
                  <SelectValue placeholder={t("stateMachines.allSchemas")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("stateMachines.allSchemas")}</SelectItem>
                  {allSchemas.map((s) => (
                    <SelectItem key={s} value={s}>{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <span className="text-sm text-muted-foreground">
              {filtered.length} {t("stateMachines.machineCount")}
            </span>
            <Button variant="outline" size="icon-sm" onClick={fetchMachines} disabled={loading} title={t("executionLog.refresh")}>
              <RefreshCwIcon className={`size-4 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </>
        }
      />
    </div>
  );
}

// ── State machine detail page ────────────────────────────

export function StateMachineDetailPage() {
  const { t } = useTranslation();
  // biome-ignore lint/suspicious/noExplicitAny: TanStack Router param typing
  const { name } = useParams({ strict: false }) as any;
  const [machine, setMachine] = useState<StateMachineDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchMachine = useCallback(async () => {
    if (!name) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/states/${name}`);
      if (res.ok) {
        const json = await res.json();
        setMachine(json.data);
      } else {
        const demo = DEMO_DETAILS[name as string];
        if (demo) {
          setMachine(demo);
        } else {
          setError(t("stateMachines.notFound", { name }));
        }
      }
    } catch {
      const demo = DEMO_DETAILS[name as string];
      if (demo) {
        setMachine(demo);
      } else {
        setError(t("stateMachines.loadFailed"));
      }
    } finally {
      setLoading(false);
    }
  }, [name, t]);

  useEffect(() => {
    fetchMachine();
  }, [fetchMachine]);

  if (loading) {
    return (
      <div className="p-4 flex items-center justify-center py-16 text-muted-foreground">
        {t("common.loading")}
      </div>
    );
  }

  if (error || !machine) {
    return (
      <div className="p-4 space-y-4">
        <Link to={"/admin/states" as "/"}>
          <Button variant="ghost" size="sm">
            <ArrowLeftIcon className="size-4 mr-1" />
            {t("common.back")}
          </Button>
        </Link>
        <div className="flex items-center justify-center py-16 text-destructive">
          {error ?? t("stateMachines.notFound", { name })}
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link to={"/admin/states" as "/"}>
          <Button variant="ghost" size="icon-sm">
            <ArrowLeftIcon className="size-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-lg font-semibold">{machine.name}</h1>
          <p className="text-sm text-muted-foreground">
            {machine.schema}.{machine.field} — {t("stateMachines.initial")}: {getStateLabel(machine.initial, machine.meta, t)}
          </p>
        </div>
      </div>

      {/* State diagram */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("stateMachines.diagram")}</CardTitle>
        </CardHeader>
        <CardContent>
          <StateDiagram machine={machine} t={t} />
        </CardContent>
      </Card>

      {/* Transitions table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("stateMachines.transitionTable")}</CardTitle>
        </CardHeader>
        <CardContent>
          <TransitionsAutoList machine={machine} />
        </CardContent>
      </Card>
    </div>
  );
}
