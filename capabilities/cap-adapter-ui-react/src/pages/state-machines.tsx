/**
 * StateMachinesPage — Lists all registered state machines with visualization.
 *
 * Route: /admin/states
 * Fetches from /api/states REST endpoint (falls back to demo data).
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
  ArrowLeftIcon,
  ArrowRightIcon,
  CircleDotIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "@tanstack/react-router";

// ── Types ────────────────────────────────────────────────

interface StateMeta {
  label: string;
  color?: string;
  description?: string;
}

interface Transition {
  from: string | string[];
  to: string;
  action: string;
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

interface StateMachineDetail {
  name: string;
  schema: string;
  field: string;
  initial: string;
  states: string[];
  transitions: Transition[];
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
      draft: { label: "Draft", color: "#6b7280" },
      pending: { label: "Pending", color: "#f59e0b" },
      approved: { label: "Approved", color: "#10b981" },
      rejected: { label: "Rejected", color: "#ef4444" },
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
      new: { label: "New", color: "#3b82f6" },
      confirmed: { label: "Confirmed", color: "#8b5cf6" },
      shipped: { label: "Shipped", color: "#f59e0b" },
      delivered: { label: "Delivered", color: "#10b981" },
      cancelled: { label: "Cancelled", color: "#ef4444" },
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
      draft: { label: "Draft", color: "#6b7280" },
      pending: { label: "Pending", color: "#f59e0b" },
      approved: { label: "Approved", color: "#10b981" },
      rejected: { label: "Rejected", color: "#ef4444" },
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
      new: { label: "New", color: "#3b82f6" },
      confirmed: { label: "Confirmed", color: "#8b5cf6" },
      shipped: { label: "Shipped", color: "#f59e0b" },
      delivered: { label: "Delivered", color: "#10b981" },
      cancelled: { label: "Cancelled", color: "#ef4444" },
    },
  },
};

// ── Default state color ──────────────────────────────────

const DEFAULT_STATE_COLOR = "#6b7280";

function getStateColor(stateName: string, meta?: Record<string, StateMeta>): string {
  return meta?.[stateName]?.color ?? DEFAULT_STATE_COLOR;
}

function getStateLabel(stateName: string, meta?: Record<string, StateMeta>): string {
  return meta?.[stateName]?.label ?? stateName;
}

// ── State diagram component ─────────────────────────────

function StateDiagram({ machine }: { machine: StateMachineDetail }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [nodePositions, setNodePositions] = useState<Map<string, { cx: number; cy: number; w: number; h: number }>>(new Map());

  useEffect(() => {
    if (!containerRef.current) return;
    const nodes = containerRef.current.querySelectorAll("[data-state-node]");
    const containerRect = containerRef.current.getBoundingClientRect();
    const positions = new Map<string, { cx: number; cy: number; w: number; h: number }>();
    for (const node of nodes) {
      const el = node as HTMLElement;
      const stateName = el.getAttribute("data-state-node") ?? "";
      const rect = el.getBoundingClientRect();
      positions.set(stateName, {
        cx: rect.left - containerRect.left + rect.width / 2,
        cy: rect.top - containerRect.top + rect.height / 2,
        w: rect.width,
        h: rect.height,
      });
    }
    setNodePositions(positions);
  }, [machine]);

  // Arrange states in a grid layout
  const stateCount = machine.states.length;
  const cols = Math.min(stateCount, 4);
  const rows = Math.ceil(stateCount / cols);

  return (
    <div ref={containerRef} className="relative" style={{ minHeight: rows * 120 + 40 }}>
      {/* SVG arrow layer */}
      {nodePositions.size > 0 && (
        <svg className="absolute inset-0 pointer-events-none" style={{ width: "100%", height: "100%" }}>
          <defs>
            <marker id="state-arrow" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
              <polygon points="0 0, 8 3, 0 6" className="fill-muted-foreground/60" />
            </marker>
          </defs>
          {machine.transitions.map((tr, i) => {
            const froms = Array.isArray(tr.from) ? tr.from : [tr.from];
            return froms.map((fromState) => {
              const fromPos = nodePositions.get(fromState);
              const toPos = nodePositions.get(tr.to);
              if (!fromPos || !toPos) return null;

              // Calculate edge points
              const dx = toPos.cx - fromPos.cx;
              const dy = toPos.cy - fromPos.cy;
              const angle = Math.atan2(dy, dx);

              const startX = fromPos.cx + Math.cos(angle) * (fromPos.w / 2 + 4);
              const startY = fromPos.cy + Math.sin(angle) * (fromPos.h / 2 + 4);
              const endX = toPos.cx - Math.cos(angle) * (toPos.w / 2 + 8);
              const endY = toPos.cy - Math.sin(angle) * (toPos.h / 2 + 8);

              // Curve control point offset
              const midX = (startX + endX) / 2;
              const midY = (startY + endY) / 2;
              const perpX = -Math.sin(angle) * 20;
              const perpY = Math.cos(angle) * 20;

              return (
                <g key={`${fromState}-${tr.to}-${i}`}>
                  <path
                    d={`M ${startX} ${startY} Q ${midX + perpX} ${midY + perpY}, ${endX} ${endY}`}
                    fill="none"
                    className="stroke-muted-foreground/40"
                    strokeWidth="1.5"
                    markerEnd="url(#state-arrow)"
                  />
                  {/* Action label on the arrow */}
                  <text
                    x={midX + perpX * 0.6}
                    y={midY + perpY * 0.6 - 4}
                    className="fill-muted-foreground text-[9px]"
                    textAnchor="middle"
                  >
                    {tr.action}
                  </text>
                </g>
              );
            });
          })}
        </svg>
      )}

      {/* State nodes */}
      <div
        className="grid gap-8 justify-items-center py-6"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
      >
        {machine.states.map((stateName) => {
          const color = getStateColor(stateName, machine.meta);
          const label = getStateLabel(stateName, machine.meta);
          const isInitial = stateName === machine.initial;
          return (
            <div
              key={stateName}
              data-state-node={stateName}
              className="flex flex-col items-center gap-1.5 px-4 py-3 rounded-xl border-2 min-w-[100px] shadow-sm bg-background"
              style={{ borderColor: color }}
            >
              <div className="flex items-center gap-1.5">
                {isInitial && (
                  <CircleDotIcon className="size-3" style={{ color }} />
                )}
                <span className="font-medium text-sm" style={{ color }}>
                  {label}
                </span>
              </div>
              <span className="text-[10px] text-muted-foreground font-mono">
                {stateName}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── State machines list page ─────────────────────────────

export function StateMachinesPage() {
  const { t } = useTranslation();
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

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">{t("stateMachines.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("stateMachines.subtitle")}</p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchMachines} disabled={loading}>
          <RefreshCwIcon className={`size-4 mr-1 ${loading ? "animate-spin" : ""}`} />
          {t("executionLog.refresh")}
        </Button>
      </div>

      {allSchemas.length > 1 && (
        <div className="flex items-center gap-2">
          <Select value={schemaFilter} onValueChange={setSchemaFilter}>
            <SelectTrigger className="w-48">
              <SelectValue placeholder={t("stateMachines.allSchemas")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("stateMachines.allSchemas")}</SelectItem>
              {allSchemas.map((s) => (
                <SelectItem key={s} value={s}>{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-sm text-muted-foreground">
            {filtered.length} {t("stateMachines.machineCount")}
          </span>
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <CircleDotIcon className="size-8 mr-3 opacity-50" />
          <span>{loading ? t("common.loading") : t("stateMachines.noMachines")}</span>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {filtered.map((machine) => (
            <Link
              key={machine.name}
              to={"/admin/states/$name" as "/"}
              params={{ name: machine.name }}
              className="block"
            >
              <Card className="hover:border-primary/50 transition-colors cursor-pointer h-full">
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between">
                    <div>
                      <CardTitle className="text-base">{machine.name}</CardTitle>
                      <CardDescription className="text-xs">
                        {machine.schema}.{machine.field}
                      </CardDescription>
                    </div>
                    <ArrowRightIcon className="size-4 text-muted-foreground shrink-0 mt-1" />
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center gap-2 flex-wrap">
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
                        {getStateLabel(s, machine.meta)}
                      </Badge>
                    ))}
                  </div>
                  <div className="text-xs text-muted-foreground mt-2">
                    {machine.stateCount} {t("stateMachines.states")} / {machine.transitionCount} {t("stateMachines.transitions")}
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
            {machine.schema}.{machine.field} — {t("stateMachines.initial")}: {getStateLabel(machine.initial, machine.meta)}
          </p>
        </div>
      </div>

      {/* State diagram */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("stateMachines.diagram")}</CardTitle>
        </CardHeader>
        <CardContent className="overflow-auto">
          <StateDiagram machine={machine} />
        </CardContent>
      </Card>

      {/* Transitions table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("stateMachines.transitionTable")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="p-2 text-left font-medium">{t("stateMachines.from")}</th>
                  <th className="p-2 text-center font-medium">{t("stateMachines.action")}</th>
                  <th className="p-2 text-left font-medium">{t("stateMachines.to")}</th>
                </tr>
              </thead>
              <tbody>
                {machine.transitions.map((tr, i) => {
                  const froms = Array.isArray(tr.from) ? tr.from : [tr.from];
                  return froms.map((fromState) => (
                    <tr key={`${fromState}-${tr.to}-${i}`} className="border-b">
                      <td className="p-2">
                        <Badge
                          variant="outline"
                          style={{
                            borderColor: getStateColor(fromState, machine.meta),
                            color: getStateColor(fromState, machine.meta),
                          }}
                        >
                          {getStateLabel(fromState, machine.meta)}
                        </Badge>
                      </td>
                      <td className="p-2 text-center">
                        <span className="inline-flex items-center gap-1 text-xs font-mono text-muted-foreground">
                          <ArrowRightIcon className="size-3" />
                          {tr.action}
                        </span>
                      </td>
                      <td className="p-2">
                        <Badge
                          variant="outline"
                          style={{
                            borderColor: getStateColor(tr.to, machine.meta),
                            color: getStateColor(tr.to, machine.meta),
                          }}
                        >
                          {getStateLabel(tr.to, machine.meta)}
                        </Badge>
                      </td>
                    </tr>
                  ));
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
