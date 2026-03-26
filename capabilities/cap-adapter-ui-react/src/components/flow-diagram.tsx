/**
 * FlowDiagram — ReactFlow-based flow step visualization with dagre auto-layout.
 *
 * Renders flow steps as custom-styled nodes connected by animated edges.
 * Layout: left-to-right (horizontal), computed automatically by dagre.
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
  SmoothStepEdge,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "dagre";
import {
  BotIcon,
  ClockIcon,
  GitForkIcon,
  PlayIcon,
  ShieldCheckIcon,
  SparklesIcon,
  SplitIcon,
} from "lucide-react";
import { type ReactNode, useMemo } from "react";

// ── Types ────────────────────────────────────────────────

export interface FlowStep {
  id: string;
  name: string;
  type: string;
  description?: string;
  actionName?: string;
  expression?: string;
  then?: string;
  else?: string;
  prompt?: string | { template: string; variables: Record<string, string> };
  model?: string;
  approvers?: string[];
  timeout?: number;
  onTimeout?: string;
  duration?: number;
  signal?: string;
  steps?: string[];
  joinType?: string;
}

// ── Step type config ─────────────────────────────────────

interface StepTypeConfig {
  color: string;
  bgColor: string;
  borderColor: string;
  darkBgColor: string;
  darkBorderColor: string;
  icon: ReactNode;
  dashed?: boolean;
}

const STEP_CONFIGS: Record<string, StepTypeConfig> = {
  action: {
    color: "#3b82f6",
    bgColor: "#eff6ff",
    borderColor: "#93c5fd",
    darkBgColor: "#172554",
    darkBorderColor: "#1e40af",
    icon: <PlayIcon className="size-3.5" />,
  },
  condition: {
    color: "#f59e0b",
    bgColor: "#fffbeb",
    borderColor: "#fcd34d",
    darkBgColor: "#451a03",
    darkBorderColor: "#92400e",
    icon: <GitForkIcon className="size-3.5" />,
  },
  approval: {
    color: "#8b5cf6",
    bgColor: "#f5f3ff",
    borderColor: "#c4b5fd",
    darkBgColor: "#2e1065",
    darkBorderColor: "#5b21b6",
    icon: <ShieldCheckIcon className="size-3.5" />,
  },
  ai: {
    color: "#10b981",
    bgColor: "#ecfdf5",
    borderColor: "#6ee7b7",
    darkBgColor: "#022c22",
    darkBorderColor: "#065f46",
    icon: <SparklesIcon className="size-3.5" />,
  },
  wait: {
    color: "#6b7280",
    bgColor: "#f9fafb",
    borderColor: "#d1d5db",
    darkBgColor: "#111827",
    darkBorderColor: "#374151",
    icon: <ClockIcon className="size-3.5" />,
    dashed: true,
  },
  parallel: {
    color: "#06b6d4",
    bgColor: "#ecfeff",
    borderColor: "#67e8f9",
    darkBgColor: "#083344",
    darkBorderColor: "#155e75",
    icon: <SplitIcon className="size-3.5" />,
  },
};

function getStepConfig(type: string): StepTypeConfig {
  return (
    STEP_CONFIGS[type] ?? {
      color: "#6b7280",
      bgColor: "#f9fafb",
      borderColor: "#d1d5db",
      darkBgColor: "#111827",
      darkBorderColor: "#374151",
      icon: <PlayIcon className="size-3.5" />,
    }
  );
}

// ── Key params summary ───────────────────────────────────

function getParamsSummary(step: FlowStep): string[] {
  const params: string[] = [];
  switch (step.type) {
    case "action":
      if (step.actionName) params.push(step.actionName);
      break;
    case "condition":
      if (step.expression) {
        const expr =
          step.expression.length > 40
            ? `${step.expression.slice(0, 37)}...`
            : step.expression;
        params.push(expr);
      }
      break;
    case "ai":
      if (step.model) params.push(step.model);
      if (step.prompt) {
        const text =
          typeof step.prompt === "string"
            ? step.prompt
            : step.prompt.template;
        params.push(
          text.length > 35 ? `${text.slice(0, 32)}...` : text,
        );
      }
      break;
    case "approval":
      if (step.approvers?.length)
        params.push(`approvers: ${step.approvers.join(", ")}`);
      if (step.onTimeout) params.push(`timeout: ${step.onTimeout}`);
      break;
    case "wait":
      if (step.signal) params.push(`signal: ${step.signal}`);
      break;
    case "parallel":
      if (step.steps?.length) params.push(step.steps.join(", "));
      if (step.joinType) params.push(`join: ${step.joinType}`);
      break;
  }
  return params;
}

// ── Custom node components ───────────────────────────────

interface FlowNodeData {
  step: FlowStep;
  config: StepTypeConfig;
  params: string[];
  [key: string]: unknown;
}

/** Standard rectangular node (action, approval, ai, wait, parallel) */
function FlowStepNode({ data }: NodeProps<Node<FlowNodeData>>) {
  const { step, config, params } = data;
  const isDashed = config.dashed;

  return (
    <div
      className="rounded-lg px-3 py-2 min-w-[180px] max-w-[240px] shadow-sm"
      style={{
        backgroundColor: config.bgColor,
        border: `2px ${isDashed ? "dashed" : "solid"} ${config.borderColor}`,
      }}
    >
      <Handle
        type="target"
        position={Position.Left}
        style={{ background: config.color, width: 8, height: 8 }}
      />

      {/* Header: icon + name */}
      <div className="flex items-center gap-1.5 mb-1">
        <span style={{ color: config.color }}>{config.icon}</span>
        <span className="font-semibold text-xs text-gray-800 dark:text-gray-200 leading-tight">
          {step.name}
        </span>
      </div>

      {/* Type badge */}
      <div className="mb-1">
        <span
          className="inline-block text-[10px] font-medium px-1.5 py-0.5 rounded"
          style={{
            backgroundColor: `${config.color}20`,
            color: config.color,
          }}
        >
          {step.type}
        </span>
      </div>

      {/* Params summary */}
      {params.length > 0 && (
        <div className="space-y-0.5">
          {params.map((p) => (
            <div
              key={p}
              className="text-[10px] text-gray-500 dark:text-gray-400 truncate leading-tight"
              title={p}
            >
              {p}
            </div>
          ))}
        </div>
      )}

      <Handle
        type="source"
        position={Position.Right}
        style={{ background: config.color, width: 8, height: 8 }}
      />
    </div>
  );
}

/** Diamond-shaped node for condition steps */
function ConditionNode({ data }: NodeProps<Node<FlowNodeData>>) {
  const { step, config, params } = data;

  return (
    <div className="relative flex items-center justify-center" style={{ width: 200, height: 120 }}>
      <Handle
        type="target"
        position={Position.Left}
        style={{
          background: config.color,
          width: 8,
          height: 8,
          left: -4,
          top: "50%",
        }}
      />

      {/* Diamond shape via rotated square */}
      <div
        className="absolute shadow-sm"
        style={{
          width: 100,
          height: 100,
          transform: "rotate(45deg)",
          backgroundColor: config.bgColor,
          border: `2px solid ${config.borderColor}`,
          borderRadius: 8,
        }}
      />

      {/* Content overlay (not rotated) */}
      <div className="relative z-10 text-center px-2" style={{ maxWidth: 180 }}>
        <div className="flex items-center justify-center gap-1 mb-0.5">
          <span style={{ color: config.color }}>{config.icon}</span>
          <span className="font-semibold text-xs text-gray-800 dark:text-gray-200">
            {step.name}
          </span>
        </div>
        <span
          className="inline-block text-[10px] font-medium px-1.5 py-0.5 rounded"
          style={{
            backgroundColor: `${config.color}20`,
            color: config.color,
          }}
        >
          condition
        </span>
        {params.length > 0 && (
          <div className="text-[9px] text-gray-500 dark:text-gray-400 mt-0.5 truncate leading-tight">
            {params[0]}
          </div>
        )}
      </div>

      {/* Source handles: top-right for "then", bottom-right for "else" */}
      <Handle
        type="source"
        position={Position.Right}
        id="then"
        style={{
          background: "#10b981",
          width: 8,
          height: 8,
          right: -4,
          top: "35%",
        }}
      />
      <Handle
        type="source"
        position={Position.Right}
        id="else"
        style={{
          background: "#ef4444",
          width: 8,
          height: 8,
          right: -4,
          top: "65%",
        }}
      />
    </div>
  );
}

// ── Node types registry ──────────────────────────────────

const nodeTypes = {
  flowStep: FlowStepNode,
  conditionStep: ConditionNode,
};

// ── Dagre layout ─────────────────────────────────────────

const NODE_WIDTH = 220;
const NODE_HEIGHT_NORMAL = 80;
const NODE_HEIGHT_CONDITION = 120;

function getLayoutedElements(
  nodes: Node<FlowNodeData>[],
  edges: Edge[],
): { nodes: Node<FlowNodeData>[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "LR", nodesep: 60, ranksep: 100, marginx: 40, marginy: 40 });

  for (const node of nodes) {
    const height =
      node.type === "conditionStep" ? NODE_HEIGHT_CONDITION : NODE_HEIGHT_NORMAL;
    g.setNode(node.id, { width: NODE_WIDTH, height });
  }

  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  const layoutedNodes = nodes.map((node) => {
    const nodeWithPosition = g.node(node.id);
    const height =
      node.type === "conditionStep" ? NODE_HEIGHT_CONDITION : NODE_HEIGHT_NORMAL;
    return {
      ...node,
      position: {
        x: nodeWithPosition.x - NODE_WIDTH / 2,
        y: nodeWithPosition.y - height / 2,
      },
    };
  });

  return { nodes: layoutedNodes, edges };
}

// ── Build nodes and edges from FlowStep[] ────────────────

function buildFlowGraph(steps: FlowStep[]): {
  nodes: Node<FlowNodeData>[];
  edges: Edge[];
} {
  const nodes: Node<FlowNodeData>[] = [];
  const edges: Edge[] = [];
  const stepMap = new Map(steps.map((s) => [s.id, s]));

  for (const step of steps) {
    const config = getStepConfig(step.type);
    const params = getParamsSummary(step);

    nodes.push({
      id: step.id,
      type: step.type === "condition" ? "conditionStep" : "flowStep",
      position: { x: 0, y: 0 }, // Will be computed by dagre
      data: { step, config, params },
    });
  }

  // Build edges: sequential flow + condition branches
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    if (step.type === "condition") {
      // Condition step: explicit then/else edges
      if (step.then && stepMap.has(step.then)) {
        edges.push({
          id: `${step.id}-then-${step.then}`,
          source: step.id,
          target: step.then,
          sourceHandle: "then",
          type: "smoothstep",
          animated: true,
          label: "then",
          style: { stroke: "#10b981", strokeWidth: 2 },
          labelStyle: { fill: "#10b981", fontWeight: 600, fontSize: 11 },
          labelBgStyle: { fill: "white", fillOpacity: 0.8 },
          labelBgPadding: [4, 2] as [number, number],
        });
      }
      if (step.else && stepMap.has(step.else)) {
        edges.push({
          id: `${step.id}-else-${step.else}`,
          source: step.id,
          target: step.else,
          sourceHandle: "else",
          type: "smoothstep",
          animated: true,
          label: "else",
          style: { stroke: "#ef4444", strokeWidth: 2 },
          labelStyle: { fill: "#ef4444", fontWeight: 600, fontSize: 11 },
          labelBgStyle: { fill: "white", fillOpacity: 0.8 },
          labelBgPadding: [4, 2] as [number, number],
        });
      }
      // If condition has no explicit then/else, fall through to next
      if (!step.then && !step.else && i < steps.length - 1) {
        const next = steps[i + 1];
        edges.push({
          id: `${step.id}->${next.id}`,
          source: step.id,
          target: next.id,
          sourceHandle: "then",
          type: "smoothstep",
          animated: true,
          style: { stroke: "#94a3b8", strokeWidth: 2 },
        });
      }
    } else {
      // Non-condition step: connect to next step in sequence
      if (i < steps.length - 1) {
        const next = steps[i + 1];
        // Skip if this step is a branch target (already connected from condition)
        const isConditionTarget = steps.some(
          (s) =>
            s.type === "condition" &&
            (s.then === next.id || s.else === next.id),
        );
        // Always connect sequential steps unless the next step is ONLY reachable
        // via condition branch (i.e., no sequential predecessor should connect to it)
        if (!isConditionTarget) {
          edges.push({
            id: `${step.id}->${next.id}`,
            source: step.id,
            target: next.id,
            type: "smoothstep",
            animated: true,
            style: { stroke: "#94a3b8", strokeWidth: 2 },
          });
        }
      }
    }
  }

  return getLayoutedElements(nodes, edges);
}

// ── Main component ───────────────────────────────────────

export function FlowDiagram({ steps }: { steps: FlowStep[] }) {
  const { nodes: layoutedNodes, edges: layoutedEdges } = useMemo(
    () => buildFlowGraph(steps),
    [steps],
  );

  const [nodes, , onNodesChange] = useNodesState(layoutedNodes);
  const [edges, , onEdgesChange] = useEdgesState(layoutedEdges);

  return (
    <div style={{ width: "100%", height: 420 }}>
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
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.3}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={16} size={1} color="#e2e8f0" />
        <Controls showInteractive={false} />
        <MiniMap
          nodeStrokeWidth={3}
          nodeColor={(node) => {
            const data = node.data as FlowNodeData;
            return data?.config?.color ?? "#6b7280";
          }}
          maskColor="rgba(0, 0, 0, 0.08)"
        />
      </ReactFlow>
    </div>
  );
}
