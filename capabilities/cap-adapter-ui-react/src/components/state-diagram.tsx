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
      {/* Left accent bar */}
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          width: 4,
          backgroundColor: color,
          borderRadius: "6px 0 0 6px",
        }}
      />

      <Handle
        type="target"
        position={Position.Left}
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

      <Handle
        type="source"
        position={Position.Right}
        style={{
          background: "transparent",
          border: "none",
          width: 1,
          height: 1,
        }}
      />
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
  const loopWidth = 40;
  const loopHeight = 45;

  // Arc goes up from source handle, curves above the node, returns to same point
  const path = `M ${sourceX} ${sourceY}
    C ${sourceX + loopWidth} ${sourceY - loopHeight},
      ${sourceX - loopWidth - 50} ${sourceY - loopHeight},
      ${sourceX - 50} ${sourceY}`;

  const labelX = sourceX - 25;
  const labelY = sourceY - loopHeight - 6;

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
        <foreignObject
          x={labelX - 45}
          y={labelY - 10}
          width={90}
          height={22}
          requiredExtensions="http://www.w3.org/1999/xhtml"
        >
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
              width: "100%",
              height: "100%",
            }}
          >
            <span
              style={{
                fontSize: 11,
                fontWeight: 500,
                color: "#475569",
                backgroundColor: "#ffffff",
                padding: "1px 6px",
                borderRadius: 9999,
                border: "1px solid #e2e8f0",
                whiteSpace: "nowrap",
                lineHeight: "18px",
              }}
            >
              {label as string}
            </span>
          </div>
        </foreignObject>
      )}
    </>
  );
}

// ── Labeled edge (overrides default to use pill labels) ──

function LabeledEdge(props: EdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, label } = props;

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
      <BaseEdge
        id={id}
        path={edgePath}
        style={{ stroke: EDGE_COLOR, strokeWidth: 1.5 }}
        markerEnd={`url(#${ARROW_ID})`}
      />
      {label && (
        <foreignObject
          x={labelX - 45}
          y={labelY - 11}
          width={90}
          height={22}
          requiredExtensions="http://www.w3.org/1999/xhtml"
        >
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
              width: "100%",
              height: "100%",
            }}
          >
            <span
              style={{
                fontSize: 11,
                fontWeight: 500,
                color: "#475569",
                backgroundColor: "#ffffff",
                padding: "1px 6px",
                borderRadius: 9999,
                border: "1px solid #e2e8f0",
                whiteSpace: "nowrap",
                lineHeight: "18px",
              }}
            >
              {label as string}
            </span>
          </div>
        </foreignObject>
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
    nodesep: 60,
    ranksep: 180,
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

  const edges: Edge[] = [];
  let edgeIdx = 0;

  for (const tr of machine.transitions) {
    const froms = Array.isArray(tr.from) ? tr.from : [tr.from];
    for (const from of froms) {
      const isSelfLoop = from === tr.to;
      edges.push({
        id: `tr-${edgeIdx++}`,
        source: from,
        target: tr.to,
        type: isSelfLoop ? "selfLoop" : "labeled",
        label: tr.action,
      });
    }
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
      <ArrowMarkerDefs />
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
        fitViewOptions={{ padding: 0.3 }}
        minZoom={0.5}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} size={1} color="#e9ecef" />
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
