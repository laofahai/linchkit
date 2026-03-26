/**
 * StateDiagram — ReactFlow-based state machine visualization with dagre auto-layout.
 *
 * Renders states as styled nodes and transitions as labeled edges.
 * Layout: left-to-right (horizontal), computed automatically by dagre.
 *
 * Features:
 * - Rounded rectangle nodes with meta.color tinting
 * - Initial state indicator (dot icon + thicker border)
 * - Terminal state indicator (double border)
 * - Smooth bezier edges with labeled transitions
 * - Self-loop handling via curved loopback edges
 * - MiniMap + Controls + fitView
 */

import {
  Background,
  Controls,
  type Edge,
  type EdgeProps,
  Handle,
  MiniMap,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "dagre";
import { CircleDotIcon } from "lucide-react";
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

// ── Helpers ──────────────────────────────────────────────

const DEFAULT_STATE_COLOR = "#6b7280";

function getStateColor(
  stateName: string,
  meta?: Record<string, StateMeta>,
): string {
  return meta?.[stateName]?.color ?? DEFAULT_STATE_COLOR;
}

/**
 * Convert a hex color to an rgba string with the given alpha.
 */
function hexToRgba(hex: string, alpha: number): string {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
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

// ── Custom state node ────────────────────────────────────

interface StateNodeData {
  stateName: string;
  label: string;
  color: string;
  isInitial: boolean;
  isTerminal: boolean;
  [key: string]: unknown;
}

function StateNode({ data }: NodeProps<Node<StateNodeData>>) {
  const { label, color, isInitial, isTerminal, stateName } = data;

  const bgTint = hexToRgba(color, 0.08);
  const borderWidth = isInitial ? 3 : 2;

  return (
    <div
      className="relative px-5 py-3 text-center"
      style={{
        backgroundColor: bgTint,
        border: `${borderWidth}px solid ${color}`,
        borderRadius: 12,
        minWidth: 140,
        minHeight: 50,
        // Terminal states get a double border effect via box-shadow
        boxShadow: isTerminal
          ? `0 0 0 3px white, 0 0 0 5px ${color}`
          : `0 1px 3px ${hexToRgba(color, 0.15)}`,
      }}
    >
      <Handle
        type="target"
        position={Position.Left}
        style={{
          background: color,
          width: 8,
          height: 8,
          border: "2px solid white",
        }}
      />

      {/* Colored accent bar at top */}
      <div
        className="absolute top-0 left-0 right-0"
        style={{
          backgroundColor: color,
          opacity: 0.6,
          height: 3,
          borderRadius: "10px 10px 0 0",
        }}
      />

      <div className="flex items-center justify-center gap-1.5">
        {isInitial && (
          <CircleDotIcon className="size-3.5 flex-shrink-0" style={{ color }} />
        )}
        <span className="font-semibold text-sm leading-tight" style={{ color }}>
          {label}
        </span>
      </div>

      {label !== stateName && (
        <div className="text-[10px] text-gray-400 font-mono mt-0.5">
          {stateName}
        </div>
      )}

      <Handle
        type="source"
        position={Position.Right}
        style={{
          background: color,
          width: 8,
          height: 8,
          border: "2px solid white",
        }}
      />
    </div>
  );
}

// ── Self-loop edge ───────────────────────────────────────

/**
 * Custom edge component that renders a self-referencing loop.
 * Draws an SVG path that goes above the node and curves back.
 */
function SelfLoopEdge({
  id,
  sourceX,
  sourceY,
  label,
  style,
  markerEnd,
}: EdgeProps) {
  // Draw a loop that goes up from the right handle, curves over the node, and comes back to the left handle
  const loopRadius = 30;
  const loopHeight = 50;

  const path = `M ${sourceX} ${sourceY}
    C ${sourceX + loopRadius} ${sourceY - loopHeight},
      ${sourceX - loopRadius - 60} ${sourceY - loopHeight},
      ${sourceX - 60} ${sourceY}`;

  // Label position: centered above the loop
  const labelX = sourceX - 30;
  const labelY = sourceY - loopHeight - 8;

  return (
    <>
      <path
        id={id}
        d={path}
        fill="none"
        style={style}
        markerEnd={markerEnd as string}
      />
      {label && (
        <foreignObject
          x={labelX - 40}
          y={labelY - 10}
          width={80}
          height={24}
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
                fontSize: 10,
                fontFamily: "ui-monospace, monospace",
                fontWeight: 500,
                color: (style as Record<string, unknown>)?.stroke as string ?? "#666",
                backgroundColor: "white",
                padding: "1px 5px",
                borderRadius: 3,
                border: "1px solid #e5e7eb",
                whiteSpace: "nowrap",
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

// ── Node & edge types registry ───────────────────────────

const nodeTypes = {
  stateNode: StateNode,
};

const edgeTypes = {
  selfLoop: SelfLoopEdge,
};

// ── Dagre layout ─────────────────────────────────────────

const NODE_WIDTH = 160;
const NODE_HEIGHT = 60;

function getLayoutedElements(
  nodes: Node<StateNodeData>[],
  edges: Edge[],
): { nodes: Node<StateNodeData>[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: "LR",
    nodesep: 80,
    ranksep: 150,
    marginx: 50,
    marginy: 50,
  });

  for (const node of nodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }

  // Only add non-self-loop edges to dagre (self-loops don't affect layout)
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

  // Build nodes
  const nodes: Node<StateNodeData>[] = machine.states.map((state) => {
    const color = getStateColor(state, machine.meta);
    const label = getStateLabel(state, machine.meta, t);
    return {
      id: state,
      type: "stateNode",
      position: { x: 0, y: 0 },
      data: {
        stateName: state,
        label,
        color,
        isInitial: state === machine.initial,
        isTerminal: terminalStates.has(state),
      },
    };
  });

  // Build edges (flatten from-arrays)
  const edges: Edge[] = [];
  let edgeIdx = 0;

  // Track edge count between same source-target pairs for offsetting parallel edges
  const edgePairCount = new Map<string, number>();

  for (const tr of machine.transitions) {
    const froms = Array.isArray(tr.from) ? tr.from : [tr.from];
    for (const from of froms) {
      const fromColor = getStateColor(from, machine.meta);
      const isSelfLoop = from === tr.to;
      const pairKey = `${from}->${tr.to}`;
      const pairIdx = edgePairCount.get(pairKey) ?? 0;
      edgePairCount.set(pairKey, pairIdx + 1);

      if (isSelfLoop) {
        // Self-loop: use custom edge type
        edges.push({
          id: `tr-${edgeIdx++}`,
          source: from,
          target: tr.to,
          type: "selfLoop",
          label: tr.action,
          style: {
            stroke: fromColor,
            strokeWidth: 1.5,
          },
          markerEnd: {
            type: "arrowclosed" as unknown as undefined,
            color: fromColor,
            width: 16,
            height: 16,
          } as unknown as string,
        });
      } else {
        // Normal edge: smooth bezier
        edges.push({
          id: `tr-${edgeIdx++}`,
          source: from,
          target: tr.to,
          type: "default",
          animated: false,
          label: tr.action,
          style: {
            stroke: fromColor,
            strokeWidth: 1.5,
          },
          labelStyle: {
            fill: "#374151",
            fontSize: 10,
            fontFamily: "ui-monospace, monospace",
            fontWeight: 500,
          },
          labelBgStyle: {
            fill: "white",
            fillOpacity: 0.95,
            stroke: "#e5e7eb",
            strokeWidth: 0.5,
            rx: 3,
            ry: 3,
          },
          labelBgPadding: [6, 3] as [number, number],
          markerEnd: {
            type: "arrowclosed" as unknown as undefined,
            color: fromColor,
            width: 16,
            height: 16,
          } as unknown as string,
        });
      }
    }
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
        border: "1px solid #e5e7eb",
        borderRadius: 8,
        overflow: "hidden",
        background: "#fafafa",
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
        fitViewOptions={{ padding: 0.3 }}
        minZoom={0.3}
        maxZoom={2}
        defaultEdgeOptions={{
          type: "default",
        }}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} size={1} color="#e2e8f0" />
        <Controls showInteractive={false} position="bottom-left" />
        <MiniMap
          position="bottom-right"
          nodeStrokeWidth={3}
          pannable
          zoomable
          nodeColor={(node) => {
            const data = node.data as StateNodeData;
            return data?.color ?? DEFAULT_STATE_COLOR;
          }}
          maskColor="rgba(0, 0, 0, 0.06)"
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: 4,
          }}
        />
      </ReactFlow>
    </div>
  );
}
