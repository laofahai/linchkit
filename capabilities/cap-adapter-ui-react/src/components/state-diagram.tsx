/**
 * StateDiagram — ReactFlow-based state machine visualization with dagre auto-layout.
 *
 * Renders states as styled nodes and transitions as labeled edges.
 * Layout: left-to-right (horizontal), computed automatically by dagre.
 */

import {
  Background,
  Controls,
  type Edge,
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

function getStateLabel(
  stateName: string,
  meta?: Record<string, StateMeta>,
): string {
  return meta?.[stateName]?.label ?? stateName;
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

  return (
    <div
      className="relative rounded-xl px-4 py-3 min-w-[120px] text-center shadow-sm"
      style={{
        backgroundColor: "white",
        border: `${isInitial ? "3px" : "2px"} solid ${color}`,
        outline: isTerminal ? `2px solid ${color}40` : undefined,
        outlineOffset: isTerminal ? "3px" : undefined,
      }}
    >
      <Handle
        type="target"
        position={Position.Left}
        style={{ background: color, width: 8, height: 8 }}
      />

      {/* Colored accent bar at top */}
      <div
        className="absolute top-0 left-0 right-0 h-1 rounded-t-xl"
        style={{ backgroundColor: color, opacity: 0.7 }}
      />

      <div className="flex items-center justify-center gap-1.5">
        {isInitial && (
          <CircleDotIcon className="size-3" style={{ color }} />
        )}
        <span
          className="font-semibold text-sm"
          style={{ color }}
        >
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
        style={{ background: color, width: 8, height: 8 }}
      />
    </div>
  );
}

// ── Node types registry ──────────────────────────────────

const nodeTypes = {
  stateNode: StateNode,
};

// ── Dagre layout ─────────────────────────────────────────

const NODE_WIDTH = 140;
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
    ranksep: 120,
    marginx: 40,
    marginy: 40,
  });

  for (const node of nodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }

  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
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

function buildStateGraph(machine: StateMachineDetail): {
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
    const label = getStateLabel(state, machine.meta);
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
  // Track edge pairs for consistent coloring
  let edgeIdx = 0;

  for (const tr of machine.transitions) {
    const froms = Array.isArray(tr.from) ? tr.from : [tr.from];
    for (const from of froms) {
      const fromColor = getStateColor(from, machine.meta);
      edges.push({
        id: `tr-${edgeIdx++}`,
        source: from,
        target: tr.to,
        type: "smoothstep",
        animated: true,
        label: tr.action,
        style: { stroke: fromColor, strokeWidth: 1.5, strokeOpacity: 0.6 },
        labelStyle: {
          fill: fromColor,
          fontSize: 10,
          fontFamily: "ui-monospace, monospace",
          fontWeight: 500,
        },
        labelBgStyle: { fill: "white", fillOpacity: 0.85 },
        labelBgPadding: [4, 2] as [number, number],
      });
    }
  }

  return getLayoutedElements(nodes, edges);
}

// ── Main component ───────────────────────────────────────

export function StateDiagram({ machine }: { machine: StateMachineDetail }) {
  const { nodes: layoutedNodes, edges: layoutedEdges } = useMemo(
    () => buildStateGraph(machine),
    [machine],
  );

  const [nodes, , onNodesChange] = useNodesState(layoutedNodes);
  const [edges, , onEdgesChange] = useEdgesState(layoutedEdges);

  return (
    <div style={{ width: "100%", height: 350 }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        minZoom={0.3}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={16} size={1} color="#e2e8f0" />
        <Controls showInteractive={false} />
        <MiniMap
          nodeStrokeWidth={3}
          nodeColor={(node) => {
            const data = node.data as StateNodeData;
            return data?.color ?? DEFAULT_STATE_COLOR;
          }}
          maskColor="rgba(0, 0, 0, 0.08)"
        />
      </ReactFlow>
    </div>
  );
}
