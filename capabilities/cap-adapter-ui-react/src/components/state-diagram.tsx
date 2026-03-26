/**
 * StateDiagram — Clean, professional state machine visualization.
 *
 * Uses ReactFlow + dagre for auto-layout. Left-to-right horizontal flow.
 * Design: white card nodes with left color accent bar, uniform slate edges.
 */

import {
  Background,
  BaseEdge,
  Controls,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  getBezierPath,
  Handle,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "dagre";
import { CircleIcon } from "lucide-react";
import { useMemo } from "react";

// ── Types ────────────────────────────────────────────────

interface StateMeta {
  label: string;
  color?: string;
  description?: string;
}

export interface StateMachineDetail {
  name: string;
  schema: string;
  field: string;
  initial: string;
  states: string[];
  transitions: Array<{
    from: string | string[];
    to: string;
    action: string;
  }>;
  meta?: Record<string, StateMeta>;
  /** Optional map from action name to display label (for i18n resolution) */
  actionLabels?: Record<string, string>;
}

// ── Constants ────────────────────────────────────────────

const DEFAULT_STATE_COLOR = "#6b7280";
const EDGE_COLOR = "#94a3b8";
const NODE_WIDTH = 140;
const NODE_HEIGHT = 44;
const ARROW_ID = "state-arrow";

// ── Helpers ──────────────────────────────────────────────

function getStateColor(
  stateName: string,
  meta?: Record<string, StateMeta>,
): string {
  return meta?.[stateName]?.color ?? DEFAULT_STATE_COLOR;
}

/**
 * Resolve state label from meta, supporting `t:` i18n prefix.
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

/**
 * Resolve action label: use actionLabels map, then try t() i18n, then fall back to raw name.
 */
function resolveActionLabel(
  actionName: string,
  actionLabels?: Record<string, string>,
  t?: (key: string, opts?: Record<string, unknown>) => string,
): string {
  if (actionLabels?.[actionName]) {
    return actionLabels[actionName];
  }
  if (t) {
    const resolved = t(`actions.${actionName}`, { defaultValue: "" });
    if (resolved && resolved !== "") {
      return resolved;
    }
  }
  return actionName;
}

import { resolveColorToken } from "../lib/state-colors";

/** Tailwind accent bar classes keyed by StateColorToken — single source of truth */
const ACCENT_BAR_CLASS: Record<string, string> = {
  default: "bg-gray-400",
  secondary: "bg-gray-400",
  success: "bg-green-500",
  warning: "bg-amber-500",
  danger: "bg-red-500",
  info: "bg-blue-500",
};

/** Pill-style edge label used by EdgeLabelRenderer */
function EdgeLabel({
  label,
  x,
  y,
}: { label: string; x: number; y: number }) {
  return (
    <div
      style={{
        position: "absolute",
        transform: `translate(-50%, -50%) translate(${x}px, ${y}px)`,
        pointerEvents: "all",
      }}
      className="nodrag nopan"
    >
      <span
        style={{
          fontSize: 10,
          fontWeight: 500,
          color: "#475569",
          backgroundColor: "#ffffff",
          padding: "2px 8px",
          borderRadius: 9999,
          border: "1px solid #e2e8f0",
          whiteSpace: "nowrap",
          lineHeight: "16px",
          display: "inline-block",
        }}
      >
        {label}
      </span>
    </div>
  );
}

// ── Custom state node ────────────────────────────────────

interface StateNodeData {
  label: string;
  color: string;
  isInitial: boolean;
  isTerminal: boolean;
  [key: string]: unknown;
}

function StateNode({ data }: NodeProps<Node<StateNodeData>>) {
  const { label, color, isInitial, isTerminal } = data;

  return (
    <div
      style={{
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        background: "#ffffff",
        border: isTerminal ? "1px dashed #cbd5e1" : "1px solid #e2e8f0",
        borderRadius: 6,
        boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        position: "relative",
        overflow: "hidden",
      }}
    >
      {/* Left accent bar — uses same color tokens as state badges */}
      <div
        className={`absolute left-0 top-0 bottom-0 w-1 rounded-l-md ${ACCENT_BAR_CLASS[resolveColorToken(color)] ?? "bg-gray-400"}`}
      />

      {/* Handles: left target, right source, top target+source, bottom target+source */}
      <Handle
        type="target"
        position={Position.Left}
        id="left"
        style={{
          background: "transparent",
          border: "none",
          width: 1,
          height: 1,
        }}
      />

      <Handle
        type="source"
        position={Position.Right}
        id="right"
        style={{
          background: "transparent",
          border: "none",
          width: 1,
          height: 1,
        }}
      />

      <Handle
        type="source"
        position={Position.Top}
        id="top-source"
        style={{
          background: "transparent",
          border: "none",
          width: 1,
          height: 1,
        }}
      />

      <Handle
        type="target"
        position={Position.Top}
        id="top-target"
        style={{
          background: "transparent",
          border: "none",
          width: 1,
          height: 1,
        }}
      />

      <Handle
        type="source"
        position={Position.Bottom}
        id="bottom-source"
        style={{
          background: "transparent",
          border: "none",
          width: 1,
          height: 1,
        }}
      />

      <Handle
        type="target"
        position={Position.Bottom}
        id="bottom-target"
        style={{
          background: "transparent",
          border: "none",
          width: 1,
          height: 1,
        }}
      />

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 5,
          paddingLeft: 8,
          paddingRight: 4,
        }}
      >
        {isInitial && (
          <CircleIcon
            style={{
              width: 10,
              height: 10,
              color: color,
              fill: color,
              flexShrink: 0,
            }}
          />
        )}
        <span
          style={{
            fontSize: 14,
            fontWeight: 500,
            color: "#1e293b",
            lineHeight: 1,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {label}
        </span>
      </div>
    </div>
  );
}

// ── Self-loop edge ───────────────────────────────────────

function SelfLoopEdge({
  id,
  sourceX,
  sourceY,
  label,
}: EdgeProps) {
  // Self-loop arcs above the node (source and target are top handles)
  const loopWidth = 40;
  const loopHeight = 50;

  const path = `M ${sourceX - 20} ${sourceY}
    C ${sourceX - 20} ${sourceY - loopHeight},
      ${sourceX + 20} ${sourceY - loopHeight},
      ${sourceX + 20} ${sourceY}`;

  const labelX = sourceX;
  const labelY = sourceY - loopHeight - 4;

  return (
    <>
      <path
        id={id}
        d={path}
        fill="none"
        stroke={EDGE_COLOR}
        strokeWidth={1.5}
        markerEnd={`url(#${ARROW_ID})`}
      />
      {label && (
        <EdgeLabelRenderer>
          <EdgeLabel label={label as string} x={labelX} y={labelY} />
        </EdgeLabelRenderer>
      )}
    </>
  );
}

// ── Labeled edge (overrides default to use pill labels) ──

function LabeledEdge(props: EdgeProps) {
  const {
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    label,
    data,
  } = props;

  // Apply vertical offset for parallel edges between the same pair of nodes
  const offsetY = (data?.offsetY as number) ?? 0;

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY: sourceY + offsetY,
    targetX,
    targetY: targetY + offsetY,
    sourcePosition,
    targetPosition,
  });

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{ stroke: EDGE_COLOR, strokeWidth: 1.5 }}
        markerEnd={`url(#${ARROW_ID})`}
      />
      {label && (
        <EdgeLabelRenderer>
          <EdgeLabel label={label as string} x={labelX} y={labelY} />
        </EdgeLabelRenderer>
      )}
    </>
  );
}

// ── Node & edge type registries ──────────────────────────

const nodeTypes = {
  stateNode: StateNode,
};

const edgeTypes = {
  selfLoop: SelfLoopEdge,
  labeled: LabeledEdge,
};

// ── Dagre layout ─────────────────────────────────────────

function getLayoutedElements(
  nodes: Node<StateNodeData>[],
  edges: Edge[],
): { nodes: Node<StateNodeData>[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: "LR",
    nodesep: 120,
    ranksep: 280,
    marginx: 40,
    marginy: 40,
  });

  for (const node of nodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }

  for (const edge of edges) {
    if (edge.source !== edge.target) {
      g.setEdge(edge.source, edge.target);
    }
  }

  dagre.layout(g);

  const layoutedNodes = nodes.map((node) => {
    const pos = g.node(node.id);
    return {
      ...node,
      targetPosition: Position.Left,
      sourcePosition: Position.Right,
      position: {
        x: pos.x - NODE_WIDTH / 2,
        y: pos.y - NODE_HEIGHT / 2,
      },
    };
  });

  return { nodes: layoutedNodes, edges };
}

// ── Build graph from StateMachineDetail ──────────────────

function buildStateGraph(
  machine: StateMachineDetail,
  t?: (key: string, opts?: Record<string, unknown>) => string,
): {
  nodes: Node<StateNodeData>[];
  edges: Edge[];
} {
  const stateSet = new Set(machine.states);

  // Determine terminal states (no outgoing transitions)
  const hasOutgoing = new Set<string>();
  for (const tr of machine.transitions) {
    const froms = Array.isArray(tr.from) ? tr.from : [tr.from];
    for (const f of froms) hasOutgoing.add(f);
  }
  const terminalStates = new Set(
    machine.states.filter((s) => !hasOutgoing.has(s)),
  );

  const nodes: Node<StateNodeData>[] = machine.states.map((state) => ({
    id: state,
    type: "stateNode",
    position: { x: 0, y: 0 },
    data: {
      label: getStateLabel(state, machine.meta, t),
      color: getStateColor(state, machine.meta),
      isInitial: state === machine.initial,
      isTerminal: terminalStates.has(state),
    },
  }));

  // Flatten transitions into individual edges, tracking each (from, to) pair
  const edges: Edge[] = [];
  let edgeIdx = 0;

  // Count edges between each directed pair to apply offset for parallel edges
  const pairEdgeCounts = new Map<string, number>();

  // First pass: collect all edges
  interface RawEdge {
    from: string;
    to: string;
    action: string;
    isSelfLoop: boolean;
  }
  const rawEdges: RawEdge[] = [];

  for (const tr of machine.transitions) {
    const froms = Array.isArray(tr.from) ? tr.from : [tr.from];
    for (const from of froms) {
      rawEdges.push({
        from,
        to: tr.to,
        action: tr.action,
        isSelfLoop: from === tr.to,
      });
    }
  }

  // Second pass: assign offsets for parallel/bidirectional edges
  for (const raw of rawEdges) {
    const { from, to, action, isSelfLoop } = raw;

    // Skip edges referencing non-existent states (prevents dangling arrows)
    if (!stateSet.has(from) || !stateSet.has(to)) {
      continue;
    }

    const actionLabel = resolveActionLabel(action, machine.actionLabels, t);

    if (isSelfLoop) {
      edges.push({
        id: `tr-${edgeIdx++}`,
        source: from,
        target: to,
        type: "selfLoop",
        sourceHandle: "top-source",
        targetHandle: "top-target",
        label: actionLabel,
      });
      continue;
    }

    // Check dagre positions to determine if this is a reverse (right-to-left) edge
    const sourceIdx = machine.states.indexOf(from);
    const targetIdx = machine.states.indexOf(to);
    const isReverse = sourceIdx > targetIdx;

    // Forward: right→left (default flow), Reverse: bottom→bottom (goes around below)
    const sourceHandle = isReverse ? "bottom-source" : "right";
    const targetHandle = isReverse ? "bottom-target" : "left";

    edges.push({
      id: `tr-${edgeIdx++}`,
      source: from,
      target: to,
      type: "smoothstep",
      sourceHandle,
      targetHandle,
      label: actionLabel,
      labelStyle: { fontSize: 11, fill: "#4b5563", fontWeight: 500 },
      labelBgStyle: { fill: "#ffffff", fillOpacity: 0.9 },
      labelBgPadding: [4, 8] as [number, number],
      labelBgBorderRadius: 4,
      style: { stroke: EDGE_COLOR, strokeWidth: 1.5 },
      markerEnd: { type: "arrowclosed" as const, color: EDGE_COLOR },
    });
  }

  return getLayoutedElements(nodes, edges);
}

// ── Arrow marker definition ─────────────────────────────

function ArrowMarkerDefs() {
  return (
    <svg style={{ position: "absolute", width: 0, height: 0 }}>
      <defs>
        <marker
          id={ARROW_ID}
          viewBox="0 0 10 10"
          refX="10"
          refY="5"
          markerWidth="8"
          markerHeight="8"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill={EDGE_COLOR} />
        </marker>
      </defs>
    </svg>
  );
}

// ── Main component ───────────────────────────────────────

export function StateDiagram({
  machine,
  t,
}: {
  machine: StateMachineDetail;
  t?: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const { nodes: layoutedNodes, edges: layoutedEdges } = useMemo(
    () => buildStateGraph(machine, t),
    [machine, t],
  );

  const [nodes, , onNodesChange] = useNodesState(layoutedNodes);
  const [edges, , onEdgesChange] = useEdgesState(layoutedEdges);

  return (
    <div
      style={{
        width: "100%",
        height: 350,
        background: "#f8fafc",
        border: "1px solid #e2e8f0",
        borderRadius: 8,
        overflow: "hidden",
        position: "relative",
      }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        fitView
        fitViewOptions={{ padding: 0.35 }}
        minZoom={0.5}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Controls
          showInteractive={false}
          position="bottom-left"
          style={{
            borderRadius: 6,
            border: "1px solid #e2e8f0",
            boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
          }}
        />
      </ReactFlow>
    </div>
  );
}
