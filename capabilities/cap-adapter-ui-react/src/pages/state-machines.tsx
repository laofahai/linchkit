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
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "@tanstack/react-router";
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

// ── Layout helpers ───────────────────────────────────────

/** Node dimensions for layout calculation */
const NODE_WIDTH = 140;
const NODE_HEIGHT = 56;
const H_SPACING = 160;
const V_SPACING = 100;
const PADDING = 60;
const INITIAL_DOT_OFFSET = 40;

interface LayoutNode {
  state: string;
  x: number;
  y: number;
  depth: number;
}

/**
 * BFS-based layout: arranges states left-to-right by transition depth.
 * Initial state starts at depth 0; terminal states land on the right.
 */
function computeLayout(machine: StateMachineDetail): LayoutNode[] {
  const { states, transitions, initial } = machine;

  // Build adjacency list
  const adjacency = new Map<string, string[]>();
  for (const s of states) adjacency.set(s, []);
  for (const tr of transitions) {
    const froms = Array.isArray(tr.from) ? tr.from : [tr.from];
    for (const f of froms) {
      adjacency.get(f)?.push(tr.to);
    }
  }

  // BFS from initial state to assign depth
  const depthMap = new Map<string, number>();
  const queue: string[] = [initial];
  depthMap.set(initial, 0);

  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentDepth = depthMap.get(current)!;
    for (const neighbor of adjacency.get(current) ?? []) {
      if (!depthMap.has(neighbor)) {
        depthMap.set(neighbor, currentDepth + 1);
        queue.push(neighbor);
      }
    }
  }

  // Assign depth to any unreachable states (place them at max depth + 1)
  const maxDepth = Math.max(0, ...depthMap.values());
  for (const s of states) {
    if (!depthMap.has(s)) {
      depthMap.set(s, maxDepth + 1);
    }
  }

  // Group states by depth
  const depthGroups = new Map<number, string[]>();
  for (const s of states) {
    const d = depthMap.get(s)!;
    if (!depthGroups.has(d)) depthGroups.set(d, []);
    depthGroups.get(d)!.push(s);
  }

  // Assign positions: columns by depth, rows within each column
  const nodes: LayoutNode[] = [];
  const sortedDepths = [...depthGroups.keys()].sort((a, b) => a - b);

  for (const depth of sortedDepths) {
    const group = depthGroups.get(depth)!;
    const colX = PADDING + INITIAL_DOT_OFFSET + depth * (NODE_WIDTH + H_SPACING);
    const startY = PADDING;

    for (let i = 0; i < group.length; i++) {
      const y = startY + i * (NODE_HEIGHT + V_SPACING);
      nodes.push({ state: group[i], x: colX, y, depth });
    }
  }

  // Center vertically: find max row count across columns, center smaller columns
  const maxGroupSize = Math.max(...[...depthGroups.values()].map((g) => g.length));
  const maxTotalHeight = maxGroupSize * NODE_HEIGHT + (maxGroupSize - 1) * V_SPACING;

  for (const depth of sortedDepths) {
    const group = depthGroups.get(depth)!;
    const groupHeight = group.length * NODE_HEIGHT + (group.length - 1) * V_SPACING;
    const offsetY = (maxTotalHeight - groupHeight) / 2;
    for (const node of nodes) {
      if (node.depth === depth) {
        node.y += offsetY;
      }
    }
  }

  return nodes;
}

/**
 * Determine terminal states: states with no outgoing transitions.
 */
function getTerminalStates(machine: StateMachineDetail): Set<string> {
  const hasOutgoing = new Set<string>();
  for (const tr of machine.transitions) {
    const froms = Array.isArray(tr.from) ? tr.from : [tr.from];
    for (const f of froms) hasOutgoing.add(f);
  }
  return new Set(machine.states.filter((s) => !hasOutgoing.has(s)));
}

/**
 * Compute connection points on rectangle edges for a line from (sx,sy) to (tx,ty).
 */
function getRectEdgePoint(
  rx: number, ry: number, rw: number, rh: number,
  targetX: number, targetY: number,
): { x: number; y: number } {
  const cx = rx + rw / 2;
  const cy = ry + rh / 2;
  const dx = targetX - cx;
  const dy = targetY - cy;

  if (dx === 0 && dy === 0) return { x: cx, y: cy };

  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);
  const scaleX = (rw / 2) / absDx;
  const scaleY = (rh / 2) / absDy;
  const scale = Math.min(scaleX || Infinity, scaleY || Infinity);

  return { x: cx + dx * scale, y: cy + dy * scale };
}

// ── State diagram component ─────────────────────────────

function StateDiagram({ machine, t }: { machine: StateMachineDetail; t: (key: string, opts?: Record<string, unknown>) => string }) {
  const nodes = computeLayout(machine);
  const terminalStates = getTerminalStates(machine);
  const posMap = new Map(nodes.map((n) => [n.state, n]));

  // Calculate SVG dimensions
  const maxX = Math.max(...nodes.map((n) => n.x)) + NODE_WIDTH + PADDING;
  const maxY = Math.max(...nodes.map((n) => n.y)) + NODE_HEIGHT + PADDING;
  const svgWidth = Math.max(maxX, 400);
  const svgHeight = Math.max(maxY, 200);

  // Flatten transitions (expand from-arrays)
  const flatTransitions: { from: string; to: string; action: string }[] = [];
  for (const tr of machine.transitions) {
    const froms = Array.isArray(tr.from) ? tr.from : [tr.from];
    for (const f of froms) {
      flatTransitions.push({ from: f, to: tr.to, action: tr.action });
    }
  }

  // Detect bidirectional pairs to offset curves properly
  const edgePairCount = new Map<string, number>();
  const edgePairIndex = new Map<string, number>();
  for (const tr of flatTransitions) {
    const key = [tr.from, tr.to].sort().join("||");
    edgePairCount.set(key, (edgePairCount.get(key) ?? 0) + 1);
  }
  for (const tr of flatTransitions) {
    const key = [tr.from, tr.to].sort().join("||");
    const idx = edgePairIndex.get(key) ?? 0;
    edgePairIndex.set(key, idx + 1);
    (tr as { _pairIdx?: number })._pairIdx = idx;
    (tr as { _pairTotal?: number })._pairTotal = edgePairCount.get(key) ?? 1;
  }

  return (
    <div className="overflow-x-auto">
      <svg
        width={svgWidth}
        height={svgHeight}
        viewBox={`0 0 ${svgWidth} ${svgHeight}`}
        className="select-none"
      >
        <defs>
          {/* Arrow markers per state color */}
          {machine.states.map((s) => {
            const color = getStateColor(s, machine.meta);
            return (
              <marker
                key={`arrow-${s}`}
                id={`arrow-${s}`}
                markerWidth="10"
                markerHeight="7"
                refX="9"
                refY="3.5"
                orient="auto"
                markerUnits="strokeWidth"
              >
                <polygon points="0 0, 10 3.5, 0 7" fill={color} opacity="0.7" />
              </marker>
            );
          })}
          {/* Initial state arrow marker */}
          <marker
            id="arrow-initial"
            markerWidth="8"
            markerHeight="6"
            refX="7"
            refY="3"
            orient="auto"
          >
            <polygon points="0 0, 8 3, 0 6" fill="#374151" />
          </marker>
          {/* Drop shadow filter */}
          <filter id="node-shadow" x="-10%" y="-10%" width="130%" height="140%">
            <feDropShadow dx="0" dy="2" stdDeviation="3" floodColor="#000" floodOpacity="0.08" />
          </filter>
        </defs>

        {/* Transition arrows */}
        {flatTransitions.map((tr, i) => {
          const fromNode = posMap.get(tr.from);
          const toNode = posMap.get(tr.to);
          if (!fromNode || !toNode) return null;

          const fromCx = fromNode.x + NODE_WIDTH / 2;
          const fromCy = fromNode.y + NODE_HEIGHT / 2;
          const toCx = toNode.x + NODE_WIDTH / 2;
          const toCy = toNode.y + NODE_HEIGHT / 2;

          const color = getStateColor(tr.from, machine.meta);

          // Edge connection points
          const start = getRectEdgePoint(fromNode.x, fromNode.y, NODE_WIDTH, NODE_HEIGHT, toCx, toCy);
          const end = getRectEdgePoint(toNode.x, toNode.y, NODE_WIDTH, NODE_HEIGHT, fromCx, fromCy);

          // Self-loop detection
          if (tr.from === tr.to) {
            const loopX = fromNode.x + NODE_WIDTH / 2;
            const loopY = fromNode.y;
            return (
              <g key={`tr-${i}`}>
                <path
                  d={`M ${loopX - 15} ${loopY} C ${loopX - 30} ${loopY - 50}, ${loopX + 30} ${loopY - 50}, ${loopX + 15} ${loopY}`}
                  fill="none"
                  stroke={color}
                  strokeWidth="1.5"
                  strokeOpacity="0.6"
                  markerEnd={`url(#arrow-${tr.from})`}
                />
                <text
                  x={loopX}
                  y={loopY - 42}
                  textAnchor="middle"
                  fill={color}
                  fontSize="10"
                  fontFamily="ui-monospace, monospace"
                  opacity="0.8"
                >
                  {tr.action}
                </text>
              </g>
            );
          }

          // Curve offset for multiple edges between same pair
          const pairIdx = (tr as { _pairIdx?: number })._pairIdx ?? 0;
          const pairTotal = (tr as { _pairTotal?: number })._pairTotal ?? 1;
          const curveDirection = tr.from < tr.to ? 1 : -1;
          const baseOffset = pairTotal > 1 ? 35 : 20;
          const offsetMultiplier = pairTotal > 1 ? (pairIdx - (pairTotal - 1) / 2) : 0;
          const curveOffset = baseOffset * curveDirection + offsetMultiplier * 25 * curveDirection;

          // Perpendicular offset for curve control point
          const dx = end.x - start.x;
          const dy = end.y - start.y;
          const len = Math.sqrt(dx * dx + dy * dy);
          const nx = len > 0 ? -dy / len : 0;
          const ny = len > 0 ? dx / len : 0;

          const midX = (start.x + end.x) / 2 + nx * curveOffset;
          const midY = (start.y + end.y) / 2 + ny * curveOffset;

          // Label position along the curve
          const labelX = (start.x + 2 * midX + end.x) / 4;
          const labelY = (start.y + 2 * midY + end.y) / 4 - 6;

          return (
            <g key={`tr-${i}`}>
              <path
                d={`M ${start.x} ${start.y} Q ${midX} ${midY}, ${end.x} ${end.y}`}
                fill="none"
                stroke={color}
                strokeWidth="1.5"
                strokeOpacity="0.5"
                markerEnd={`url(#arrow-${tr.from})`}
              />
              {/* Action label background */}
              <text
                x={labelX}
                y={labelY}
                textAnchor="middle"
                stroke="white"
                strokeWidth="3"
                fontSize="10"
                fontFamily="ui-monospace, monospace"
                paintOrder="stroke"
              >
                {tr.action}
              </text>
              {/* Action label */}
              <text
                x={labelX}
                y={labelY}
                textAnchor="middle"
                fill={color}
                fontSize="10"
                fontFamily="ui-monospace, monospace"
                opacity="0.85"
              >
                {tr.action}
              </text>
            </g>
          );
        })}

        {/* Initial state indicator: filled dot + short arrow */}
        {(() => {
          const initNode = posMap.get(machine.initial);
          if (!initNode) return null;
          const dotX = initNode.x - 28;
          const dotY = initNode.y + NODE_HEIGHT / 2;
          return (
            <g>
              <circle cx={dotX} cy={dotY} r="5" fill="#374151" />
              <line
                x1={dotX + 6}
                y1={dotY}
                x2={initNode.x - 2}
                y2={dotY}
                stroke="#374151"
                strokeWidth="1.5"
                markerEnd="url(#arrow-initial)"
              />
            </g>
          );
        })()}

        {/* State nodes */}
        {nodes.map((node) => {
          const color = getStateColor(node.state, machine.meta);
          const label = getStateLabel(node.state, machine.meta, t);
          const isInitial = node.state === machine.initial;
          const isTerminal = terminalStates.has(node.state);

          return (
            <g key={node.state} filter="url(#node-shadow)">
              {/* Terminal state: outer double border */}
              {isTerminal && (
                <rect
                  x={node.x - 4}
                  y={node.y - 4}
                  width={NODE_WIDTH + 8}
                  height={NODE_HEIGHT + 8}
                  rx="14"
                  ry="14"
                  fill="none"
                  stroke={color}
                  strokeWidth="1.5"
                  strokeOpacity="0.4"
                />
              )}
              {/* Main rectangle */}
              <rect
                x={node.x}
                y={node.y}
                width={NODE_WIDTH}
                height={NODE_HEIGHT}
                rx="10"
                ry="10"
                fill="white"
                stroke={color}
                strokeWidth={isInitial ? "2.5" : "1.5"}
              />
              {/* Colored accent bar at top */}
              <rect
                x={node.x}
                y={node.y}
                width={NODE_WIDTH}
                height="4"
                rx="10"
                ry="10"
                fill={color}
                opacity="0.7"
              />
              <clipPath id={`clip-top-${node.state}`}>
                <rect x={node.x} y={node.y} width={NODE_WIDTH} height="4" />
              </clipPath>
              <rect
                x={node.x}
                y={node.y}
                width={NODE_WIDTH}
                height="10"
                rx="10"
                ry="10"
                fill={color}
                opacity="0.7"
                clipPath={`url(#clip-top-${node.state})`}
              />
              {/* State label (from meta.label or fallback) */}
              <text
                x={node.x + NODE_WIDTH / 2}
                y={node.y + NODE_HEIGHT / 2 - 2}
                textAnchor="middle"
                dominantBaseline="middle"
                fill={color}
                fontSize="13"
                fontWeight="600"
                fontFamily="system-ui, -apple-system, sans-serif"
              >
                {label}
              </text>
              {/* Raw state value (smaller, below label) */}
              {label !== node.state && (
                <text
                  x={node.x + NODE_WIDTH / 2}
                  y={node.y + NODE_HEIGHT / 2 + 14}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fill="#9ca3af"
                  fontSize="9"
                  fontFamily="ui-monospace, monospace"
                >
                  {node.state}
                </text>
              )}
            </g>
          );
        })}
      </svg>
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
        <Button variant="outline" size="icon-sm" onClick={fetchMachines} disabled={loading} title={t("executionLog.refresh")}>
          <RefreshCwIcon className={`size-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {allSchemas.length > 1 && (
        <div className="flex items-center gap-2">
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
                        {getStateLabel(s, machine.meta, t)}
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
            {machine.schema}.{machine.field} — {t("stateMachines.initial")}: {getStateLabel(machine.initial, machine.meta, t)}
          </p>
        </div>
      </div>

      {/* State diagram */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("stateMachines.diagram")}</CardTitle>
        </CardHeader>
        <CardContent className="overflow-auto">
          <StateDiagram machine={machine} t={t} />
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
                          {getStateLabel(fromState, machine.meta, t)}
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
                          {getStateLabel(tr.to, machine.meta, t)}
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
