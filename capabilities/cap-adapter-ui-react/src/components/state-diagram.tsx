/**
 * StateDiagram — Professional state machine visualization.
 *
 * Uses ReactFlow + dagre for auto-layout. Left-to-right horizontal flow.
 * Clean design: white rounded rectangles, smooth bezier edges, pill labels.
 */

import {
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

const EDGE_COLOR = "#6b7280";
const NODE_WIDTH = 150;
const NODE_HEIGHT = 48;

// ── Helpers ──────────────────────────────────────────────

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

/** Shared label style for edge labels via EdgeLabelRenderer */
const edgeLabelStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#4b5563",
  backgroundColor: "#ffffff",
  padding: "2px 8px",
  borderRadius: 4,
  border: "1px solid #e5e7eb",
  whiteSpace: "nowrap",
  display: "inline-block",
};

// ── Custom state node ────────────────────────────────────

interface StateNodeData {
  label: string;
  isInitial: boolean;
  isTerminal: boolean;
  [key: string]: unknown;
}

function StateNode({ data }: NodeProps<Node<StateNodeData>>) {
  const { label, isInitial, isTerminal } = data;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      {/* Initial state indicator: filled black circle with short arrow */}
      {isInitial && (
        <svg width="24" height="16" style={{ flexShrink: 0 }}>
          <circle cx="5" cy="8" r="5" fill="#1f2937" />
          <line
            x1="10"
            y1="8"
            x2="20"
            y2="8"
            stroke="#1f2937"
            strokeWidth="1.5"
          />
          <polygon points="18,5 24,8 18,11" fill="#1f2937" />
        </svg>
      )}

      <div
        style={{
          width: NODE_WIDTH,
          height: NODE_HEIGHT,
          background: "#ffffff",
          border: "1px solid #d1d5db",
          borderRadius: 8,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          position: "relative",
          // Terminal: double border via inset box-shadow
          boxShadow: isTerminal
            ? "inset 0 0 0 3px #ffffff, inset 0 0 0 4px #d1d5db"
            : "none",
        }}
      >
        {/* Left target handle */}
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
        {/* Right source handle */}
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
        {/* Top handles for self-loops */}
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

        <span
          style={{
            fontSize: 14,
            fontWeight: 500,
            color: "#374151",
            lineHeight: 1,
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </span>
      </div>
    </div>
  );
}

// ── Self-loop edge (arc above the node) ──────────────────

function SelfLoopEdge({ id, sourceX, sourceY, label }: EdgeProps) {
  const loopRadius = 30;
  const loopHeight = 45;

  const path = `M ${sourceX - loopRadius} ${sourceY}
    C ${sourceX - loopRadius} ${sourceY - loopHeight},
      ${sourceX + loopRadius} ${sourceY - loopHeight},
      ${sourceX + loopRadius} ${sourceY}`;

  const labelX = sourceX;
  const labelY = sourceY - loopHeight - 8;

  return (
    <>
      <defs>
        <marker
          id={`arrow-${id}`}
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill={EDGE_COLOR} />
        </marker>
      </defs>
      <path
        id={id}
        d={path}
        fill="none"
        stroke={EDGE_COLOR}
        strokeWidth={1.5}
        markerEnd={`url(#arrow-${id})`}
      />
      {label && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: "all",
            }}
            className="nodrag nopan"
          >
            <span style={edgeLabelStyle}>{label}</span>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

// ── Labeled bezier edge with curvature support ───────────

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

  const curvature = (data?.curvature as number) ?? 0;

  if (curvature !== 0) {
    // Manual quadratic bezier for parallel edges
    const midX = (sourceX + targetX) / 2;
    const midY = (sourceY + targetY) / 2 + curvature * -100;
    const path = `M ${sourceX} ${sourceY} Q ${midX} ${midY} ${targetX} ${targetY}`;
    const lx = (sourceX + targetX) / 2;
    const ly = (sourceY + targetY) / 2 + curvature * -50;

    return (
      <>
        <defs>
          <marker
            id={`arrow-${id}`}
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill={EDGE_COLOR} />
          </marker>
        </defs>
        <path
          id={id}
          d={path}
          fill="none"
          stroke={EDGE_COLOR}
          strokeWidth={1.5}
          markerEnd={`url(#arrow-${id})`}
        />
        {label && (
          <EdgeLabelRenderer>
            <div
              style={{
                position: "absolute",
                transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)`,
                pointerEvents: "all",
              }}
              className="nodrag nopan"
            >
              <span style={edgeLabelStyle}>{label}</span>
            </div>
          </EdgeLabelRenderer>
        )}
      </>
    );
  }

  // Standard bezier path for first edge between a pair
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  return (
    <>
      <defs>
        <marker
          id={`arrow-${id}`}
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill={EDGE_COLOR} />
        </marker>
      </defs>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{ stroke: EDGE_COLOR, strokeWidth: 1.5 }}
        markerEnd={`url(#arrow-${id})`}
      />
      {label && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: "all",
            }}
            className="nodrag nopan"
          >
            <span style={edgeLabelStyle}>{label}</span>
          </div>
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
    nodesep: 80,
    ranksep: 200,
    marginx: 40,
    marginy: 40,
  });

  for (const node of nodes) {
    // Account for initial indicator width
    const extraWidth = node.data.isInitial ? 32 : 0;
    g.setNode(node.id, {
      width: NODE_WIDTH + extraWidth,
      height: NODE_HEIGHT,
    });
  }

  for (const edge of edges) {
    if (edge.source !== edge.target) {
      g.setEdge(edge.source, edge.target);
    }
  }

  dagre.layout(g);

  const layoutedNodes = nodes.map((node) => {
    const pos = g.node(node.id);
    const extraWidth = node.data.isInitial ? 32 : 0;
    return {
      ...node,
      position: {
        x: pos.x - (NODE_WIDTH + extraWidth) / 2,
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
      isInitial: state === machine.initial,
      isTerminal: terminalStates.has(state),
    },
  }));

  // Flatten transitions into individual edges
  const edges: Edge[] = [];
  let edgeIdx = 0;

  // Track edges between each pair for curvature offsets
  const pairCounts = new Map<string, number>();

  interface RawEdge {
    from: string;
    to: string;
    action: string;
  }
  const rawEdges: RawEdge[] = [];

  for (const tr of machine.transitions) {
    const froms = Array.isArray(tr.from) ? tr.from : [tr.from];
    for (const from of froms) {
      rawEdges.push({ from, to: tr.to, action: tr.action });
    }
  }

  // Curvature values for parallel edges between same node pair
  const curvatureSequence = [0, 0.5, -0.5, 1, -1];

  for (const raw of rawEdges) {
    const { from, to, action } = raw;

    // Skip edges referencing non-existent states
    if (!stateSet.has(from) || !stateSet.has(to)) {
      continue;
    }

    const actionLabel = resolveActionLabel(action, machine.actionLabels, t);
    const isSelfLoop = from === to;

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

    // Normalize pair key so A->B and B->A share the same counter
    const pairKey = [from, to].sort().join("::");
    const currentIndex = pairCounts.get(pairKey) ?? 0;
    pairCounts.set(pairKey, currentIndex + 1);

    const curvature =
      curvatureSequence[currentIndex % curvatureSequence.length];

    edges.push({
      id: `tr-${edgeIdx++}`,
      source: from,
      target: to,
      type: "labeled",
      sourceHandle: "right",
      targetHandle: "left",
      label: actionLabel,
      data: { curvature },
    });
  }

  return getLayoutedElements(nodes, edges);
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
        height: 400,
        background: "#fafafa",
        border: "1px solid #e5e7eb",
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
        fitView
        fitViewOptions={{ padding: 0.3 }}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag={true}
        zoomOnScroll={true}
        minZoom={0.5}
        maxZoom={2}
      >
        <Controls
          showInteractive={false}
          position="bottom-left"
          style={{
            borderRadius: 6,
            border: "1px solid #e5e7eb",
            boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
          }}
        />
      </ReactFlow>
    </div>
  );
}
