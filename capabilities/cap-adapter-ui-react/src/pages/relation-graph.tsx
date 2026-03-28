/**
 * RelationGraphPage — /admin/graph
 *
 * Interactive schema relationship diagram.
 * Renders schemas as nodes and links as edges using ReactFlow + dagre auto-layout.
 * Click a node to navigate to the schema list page.
 */

import {
  Background,
  Controls,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  Handle,
  MiniMap,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  getBezierPath,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "dagre";
import { DatabaseIcon, NetworkIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "@tanstack/react-router";
import type { LinkDefinition } from "@linchkit/core/types";
import { useQuery } from "@tanstack/react-query";
import { fetchLinks, fetchSchemas, type SchemaInfo } from "@/lib/api";

// ── Layout constants ─────────────────────────────────────

const NODE_WIDTH = 160;
const NODE_HEIGHT = 52;
const GRAPH_DIRECTION = "TB"; // top-to-bottom

// ── Dagre layout helper ──────────────────────────────────

function applyDagreLayout(nodes: Node[], edges: Edge[]): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: GRAPH_DIRECTION, nodesep: 60, ranksep: 80 });

  for (const node of nodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  return nodes.map((node) => {
    const pos = g.node(node.id);
    return {
      ...node,
      position: {
        x: pos.x - NODE_WIDTH / 2,
        y: pos.y - NODE_HEIGHT / 2,
      },
    };
  });
}

// ── Cardinality label helper ─────────────────────────────

const CARDINALITY_LABEL: Record<string, string> = {
  one_to_one: "1:1",
  one_to_many: "1:N",
  many_to_one: "N:1",
  many_to_many: "N:M",
};

// ── Custom node ──────────────────────────────────────────

interface SchemaNodeData {
  label: string;
  name: string;
  internal: boolean;
  onClick: (name: string) => void;
  [key: string]: unknown;
}

function SchemaNode({ data }: NodeProps<Node<SchemaNodeData>>) {
  const { label, name, internal, onClick } = data;
  return (
    <button
      type="button"
      onClick={() => onClick(name)}
      style={{
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        background: internal ? "#f8fafc" : "#ffffff",
        border: internal ? "1px dashed #94a3b8" : "1px solid #e2e8f0",
        borderRadius: 8,
        boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "0 14px",
        cursor: "pointer",
        userSelect: "none",
        textAlign: "left",
      }}
      className="hover:shadow-md transition-shadow"
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <DatabaseIcon
        size={14}
        style={{ color: internal ? "#94a3b8" : "#6366f1", flexShrink: 0 }}
      />
      <div style={{ overflow: "hidden" }}>
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: internal ? "#64748b" : "#1e293b",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </div>
        {label !== name && (
          <div
            style={{
              fontSize: 10,
              color: "#94a3b8",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {name}
          </div>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </button>
  );
}

// ── Custom edge with cardinality label ───────────────────

interface RelationEdgeData {
  cardinality: string;
  linkName: string;
  [key: string]: unknown;
}

function RelationEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<Edge<RelationEdgeData>>) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const cardinalityLabel = CARDINALITY_LABEL[data?.cardinality ?? ""] ?? data?.cardinality ?? "";

  return (
    <>
      <path
        id={id}
        d={edgePath}
        fill="none"
        stroke="#94a3b8"
        strokeWidth={1.5}
        markerEnd="url(#relation-arrow)"
      />
      {cardinalityLabel && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: "none",
            }}
          >
            <span
              style={{
                fontSize: 10,
                fontWeight: 600,
                color: "#64748b",
                backgroundColor: "#f1f5f9",
                padding: "1px 6px",
                borderRadius: 9999,
                border: "1px solid #e2e8f0",
                whiteSpace: "nowrap",
                lineHeight: "16px",
                display: "inline-block",
              }}
            >
              {cardinalityLabel}
            </span>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

// ── Node / Edge type maps (stable references outside component) ──

const nodeTypes = { schema: SchemaNode };
const edgeTypes = { relation: RelationEdge };

// ── Graph builder ────────────────────────────────────────

function buildGraph(
  schemas: SchemaInfo[],
  links: LinkDefinition[],
  showInternal: boolean,
  onNodeClick: (name: string) => void,
): { nodes: Node[]; edges: Edge[] } {
  // Collect schemas that participate in at least one link
  const linkedSchemas = new Set<string>();
  for (const link of links) {
    linkedSchemas.add(link.from);
    linkedSchemas.add(link.to);
  }

  // Filter: only schemas in links; respect internal toggle
  const visibleSchemas = schemas.filter(
    (s) => linkedSchemas.has(s.name) && (showInternal || !s.internal),
  );

  // Graceful fallback for link endpoints not in schema registry
  const knownNames = new Set(schemas.map((s) => s.name));
  for (const name of linkedSchemas) {
    if (!knownNames.has(name)) {
      visibleSchemas.push({ name, label: name });
    }
  }

  const visibleSet = new Set(visibleSchemas.map((s) => s.name));

  const nodes: Node[] = visibleSchemas.map((s) => ({
    id: s.name,
    type: "schema",
    position: { x: 0, y: 0 },
    data: {
      label: s.label ?? s.name,
      name: s.name,
      internal: s.internal ?? false,
      onClick: onNodeClick,
    },
  }));

  const edges: Edge[] = links
    .filter((l) => visibleSet.has(l.from) && visibleSet.has(l.to))
    .map((l) => ({
      id: l.name,
      source: l.from,
      target: l.to,
      type: "relation",
      data: { cardinality: l.cardinality, linkName: l.name },
    }));

  const laidOutNodes = applyDagreLayout(nodes, edges);
  return { nodes: laidOutNodes, edges };
}

// ── GraphCanvas — inner component that owns ReactFlow state ─

interface GraphCanvasProps {
  schemas: SchemaInfo[];
  links: LinkDefinition[];
  showInternal: boolean;
  onNodeClick: (name: string) => void;
}

function GraphCanvas({ schemas, links, showInternal, onNodeClick }: GraphCanvasProps) {
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node>([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<Edge>([]);

  useEffect(() => {
    const { nodes: n, edges: e } = buildGraph(schemas, links, showInternal, onNodeClick);
    setRfNodes(n);
    setRfEdges(e);
  }, [schemas, links, showInternal, onNodeClick, setRfNodes, setRfEdges]);

  return (
    <div
      style={{ height: "calc(100vh - 200px)", minHeight: 500 }}
      className="overflow-hidden rounded-lg border bg-background"
    >
      {/* Hidden SVG for custom arrow marker — aria-hidden since it's decorative */}
      <svg
        aria-hidden="true"
        focusable="false"
        style={{ position: "absolute", width: 0, height: 0 }}
      >
        <defs>
          <marker
            id="relation-arrow"
            markerWidth="10"
            markerHeight="7"
            refX="9"
            refY="3.5"
            orient="auto"
          >
            <polygon points="0 0, 10 3.5, 0 7" fill="#94a3b8" />
          </marker>
        </defs>
      </svg>
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.3}
        maxZoom={2}
        nodesDraggable
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={16} size={1} color="#f1f5f9" />
        <Controls showInteractive={false} />
        <MiniMap
          nodeColor={(n) => ((n.data as SchemaNodeData).internal ? "#cbd5e1" : "#818cf8")}
          maskColor="rgba(248,250,252,0.7)"
        />
      </ReactFlow>
    </div>
  );
}

// ── Page component ───────────────────────────────────────

export function RelationGraphPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [showInternal, setShowInternal] = useState(false);

  const schemasQuery = useQuery({ queryKey: ["schemas"], queryFn: fetchSchemas });
  const linksQuery = useQuery({ queryKey: ["links"], queryFn: fetchLinks });

  const loading = schemasQuery.isLoading || linksQuery.isLoading;
  const error = schemasQuery.isError || linksQuery.isError;

  const schemas = schemasQuery.data ?? [];
  const links = linksQuery.data ?? [];

  const handleNodeClick = useCallback(
    (name: string) => {
      navigate({ to: "/schemas/$name", params: { name } });
    },
    [navigate],
  );

  if (loading) {
    return (
      <div className="flex flex-col gap-6 p-6">
        <div className="h-8 w-48 animate-pulse rounded bg-muted" />
        <div className="h-[600px] w-full animate-pulse rounded-lg bg-muted" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col gap-6 p-6">
        <h1 className="text-2xl font-bold">{t("relationGraph.title")}</h1>
        <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-6 text-center text-sm text-destructive">
          {t("relationGraph.loadFailed")}
        </div>
      </div>
    );
  }

  const hasLinks = links.length > 0;

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <NetworkIcon className="size-5 text-muted-foreground" />
            <h1 className="text-2xl font-bold tracking-tight">{t("relationGraph.title")}</h1>
          </div>
          <p className="text-sm text-muted-foreground">{t("relationGraph.subtitle")}</p>
        </div>
        {hasLinks && (
          <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={showInternal}
              onChange={(e) => setShowInternal(e.target.checked)}
              className="rounded border-gray-300"
            />
            {t("relationGraph.showInternal")}
          </label>
        )}
      </div>

      {/* Graph or empty state */}
      {!hasLinks ? (
        <div className="flex min-h-[400px] flex-col items-center justify-center gap-3 rounded-lg border border-dashed bg-muted/30 p-12 text-center">
          <NetworkIcon className="size-10 text-muted-foreground/40" />
          <p className="font-medium text-muted-foreground">{t("relationGraph.noLinks")}</p>
          <p className="text-sm text-muted-foreground/70">{t("relationGraph.noLinksDesc")}</p>
        </div>
      ) : (
        <GraphCanvas
          schemas={schemas}
          links={links}
          showInternal={showInternal}
          onNodeClick={handleNodeClick}
        />
      )}
    </div>
  );
}
