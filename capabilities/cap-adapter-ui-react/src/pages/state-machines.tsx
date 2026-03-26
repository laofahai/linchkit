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

// No demo data — shows empty state when API is unavailable

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
        setMachines([]);
      }
    } catch {
      setMachines([]);
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
    <div className="p-4">
      <AutoList
        columns={columns}
        data={tableData}
        pageSize={20}
        loading={loading}
        emptyState={{
          title: t("emptyState.stateMachines.title"),
          description: t("emptyState.stateMachines.description"),
        }}
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

// ── Transitions AutoList sub-component ───────────────────

interface FlatTransition {
  id: string;
  from: string;
  action: string;
  to: string;
}

function TransitionsAutoList({ machine }: { machine: StateMachineDetail }) {
  const { t } = useTranslation();

  // Flatten transitions (expand multi-from into individual rows)
  const flatTransitions = useMemo<FlatTransition[]>(() => {
    const rows: FlatTransition[] = [];
    for (const tr of machine.transitions) {
      const froms = Array.isArray(tr.from) ? tr.from : [tr.from];
      for (const fromState of froms) {
        rows.push({
          id: `${fromState}-${tr.to}-${tr.action}`,
          from: fromState,
          action: tr.action,
          to: tr.to,
        });
      }
    }
    return rows;
  }, [machine.transitions]);

  const columns = useMemo<ColumnDef<Record<string, unknown>, unknown>[]>(() => [
    {
      accessorKey: "from",
      header: ({ column }) => <SortableHeader column={column} label={t("stateMachines.from")} />,
      cell: ({ row }) => {
        const fromState = row.getValue("from") as string;
        return (
          <Badge
            variant="outline"
            style={{
              borderColor: getStateColor(fromState, machine.meta),
              color: getStateColor(fromState, machine.meta),
            }}
          >
            {getStateLabel(fromState, machine.meta, t)}
          </Badge>
        );
      },
    },
    {
      accessorKey: "action",
      header: ({ column }) => <SortableHeader column={column} label={t("stateMachines.action")} />,
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1 text-xs font-mono text-muted-foreground">
          <ArrowRightIcon className="size-3" />
          {row.getValue("action") as string}
        </span>
      ),
    },
    {
      accessorKey: "to",
      header: ({ column }) => <SortableHeader column={column} label={t("stateMachines.to")} />,
      cell: ({ row }) => {
        const toState = row.getValue("to") as string;
        return (
          <Badge
            variant="outline"
            style={{
              borderColor: getStateColor(toState, machine.meta),
              color: getStateColor(toState, machine.meta),
            }}
          >
            {getStateLabel(toState, machine.meta, t)}
          </Badge>
        );
      },
    },
  ], [t, machine.meta]);

  const tableData = useMemo<Record<string, unknown>[]>(
    () => flatTransitions.map((tr) => ({ ...tr }) as Record<string, unknown>),
    [flatTransitions],
  );

  return (
    <AutoList
      columns={columns}
      data={tableData}
      pageSize={50}
    />
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
        setError(t("stateMachines.notFound", { name }));
      }
    } catch {
      setError(t("stateMachines.loadFailed"));
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
        <CardContent className="pt-4">
          <TransitionsAutoList machine={machine} />
        </CardContent>
      </Card>
    </div>
  );
}
