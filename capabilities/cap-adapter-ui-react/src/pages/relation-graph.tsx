/**
 * RelationGraphPage — /admin/graph
 *
 * Interactive schema relationship diagram.
 * Renders schemas as nodes and links as edges using ReactFlow + dagre auto-layout.
 * Single-click a node to select it and view impact analysis.
 * Double-click a node to navigate to its schema list page.
 */

import {
  Background,
  Controls,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  getBezierPath,
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
import type { LinkDefinition, SemanticRelation } from "@linchkit/core/types";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import dagre from "dagre";
import { ArrowRightIcon, DatabaseIcon, NetworkIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchLinks, fetchSchemas, fetchSemanticRelations, type SchemaInfo } from "@/lib/api";

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
  selected: boolean;
  dimmed: boolean;
  onSelect: (name: string) => void;
  onNavigate: (name: string) => void;
  [key: string]: unknown;
}

function SchemaNode({ data }: NodeProps<Node<SchemaNodeData>>) {
  const { label, name, internal, selected, dimmed, onSelect, onNavigate } = data;

  const borderColor = selected ? "#6366f1" : internal ? "#94a3b8" : "#e2e8f0";
  const borderStyle = internal ? "dashed" : "solid";
  const borderWidth = selected ? 2 : 1;
  const bg = selected ? "#eef2ff" : internal ? "#f8fafc" : "#ffffff";
  const boxShadow = selected
    ? "0 0 0 3px rgba(99,102,241,0.18), 0 1px 4px rgba(0,0,0,0.08)"
    : "0 1px 4px rgba(0,0,0,0.08)";

  return (
    <button
      type="button"
      onClick={() => onSelect(name)}
      onDoubleClick={() => onNavigate(name)}
      title="Click to select · Double-click to navigate"
      style={{
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        background: bg,
        border: `${borderWidth}px ${borderStyle} ${borderColor}`,
        borderRadius: 8,
        boxShadow,
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "0 14px",
        cursor: "pointer",
        userSelect: "none",
        textAlign: "left",
        opacity: dimmed ? 0.25 : 1,
        transition: "opacity 0.15s, box-shadow 0.15s, border-color 0.15s",
      }}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <DatabaseIcon
        size={14}
        style={{ color: selected ? "#6366f1" : internal ? "#94a3b8" : "#6366f1", flexShrink: 0 }}
      />
      <div style={{ overflow: "hidden" }}>
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: selected ? "#4338ca" : internal ? "#64748b" : "#1e293b",
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
  dimmed: boolean;
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
  const opacity = data?.dimmed ? 0.1 : 1;

  return (
    <>
      <path
        id={id}
        d={edgePath}
        fill="none"
        stroke="#94a3b8"
        strokeWidth={1.5}
        markerEnd="url(#relation-arrow)"
        style={{ opacity, transition: "opacity 0.15s" }}
      />
      {cardinalityLabel && !data?.dimmed && (
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

// ── Semantic relation edge ───────────────────────────────

// Colors per semantic relation type
const SEMANTIC_EDGE_COLOR: Record<string, string> = {
  depends_on: "#6366f1",
  contains: "#0ea5e9",
  references: "#10b981",
  affects: "#f59e0b",
  triggers: "#ef4444",
  orchestrates: "#8b5cf6",
  reads_from: "#ec4899",
  bridges: "#64748b",
};

interface SemanticEdgeData {
  relationType: string;
  inferredFrom?: string;
  dimmed: boolean;
  [key: string]: unknown;
}

function SemanticEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<Edge<SemanticEdgeData>>) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const relType = data?.relationType ?? "";
  const color = SEMANTIC_EDGE_COLOR[relType] ?? "#94a3b8";
  const opacity = data?.dimmed ? 0.08 : 0.7;

  return (
    <>
      <path
        id={id}
        d={edgePath}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeDasharray="5,3"
        markerEnd={`url(#semantic-arrow-${relType})`}
        style={{ opacity, transition: "opacity 0.15s" }}
      />
      {!data?.dimmed && (
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
                fontSize: 9,
                fontWeight: 600,
                color,
                backgroundColor: "white",
                padding: "1px 5px",
                borderRadius: 9999,
                border: `1px solid ${color}`,
                whiteSpace: "nowrap",
                lineHeight: "16px",
                display: "inline-block",
                opacity: 0.9,
              }}
            >
              {relType.replace(/_/g, " ")}
            </span>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

// ── Node / Edge type maps (stable references outside component) ──

const nodeTypes = { schema: SchemaNode };
const edgeTypes = { relation: RelationEdge, semantic: SemanticEdge };

// ── Graph builder ────────────────────────────────────────

function buildGraph(
  schemas: SchemaInfo[],
  links: LinkDefinition[],
  semanticRelations: SemanticRelation[],
  showInternal: boolean,
  showSemantic: boolean,
  selectedNode: string | null,
  onSelect: (name: string) => void,
  onNavigate: (name: string) => void,
): { nodes: Node[]; edges: Edge[] } {
  // Collect schemas that participate in at least one link or semantic relation
  const linkedSchemas = new Set<string>();
  for (const link of links) {
    linkedSchemas.add(link.from);
    linkedSchemas.add(link.to);
  }
  if (showSemantic) {
    for (const rel of semanticRelations) {
      if (rel.from.schema) linkedSchemas.add(rel.from.schema);
      if (rel.to.schema) linkedSchemas.add(rel.to.schema);
    }
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

  // Build connected set for dimming
  const connectedNodes = new Set<string>();
  const connectedEdgeIds = new Set<string>();

  if (selectedNode) {
    connectedNodes.add(selectedNode);
    for (const link of links) {
      if (link.from === selectedNode || link.to === selectedNode) {
        connectedNodes.add(link.from);
        connectedNodes.add(link.to);
        connectedEdgeIds.add(link.name);
      }
    }
    if (showSemantic) {
      for (const rel of semanticRelations) {
        if (rel.from.schema === selectedNode || rel.to.schema === selectedNode) {
          if (rel.from.schema) connectedNodes.add(rel.from.schema);
          if (rel.to.schema) connectedNodes.add(rel.to.schema);
          connectedEdgeIds.add(`sem:${rel.id}`);
        }
      }
    }
  }

  const nodes: Node[] = visibleSchemas.map((s) => ({
    id: s.name,
    type: "schema",
    position: { x: 0, y: 0 },
    data: {
      label: s.label ?? s.name,
      name: s.name,
      internal: s.internal ?? false,
      selected: s.name === selectedNode,
      dimmed: selectedNode !== null && !connectedNodes.has(s.name),
      onSelect,
      onNavigate,
    },
  }));

  const structuralEdges: Edge[] = links
    .filter((l) => visibleSet.has(l.from) && visibleSet.has(l.to))
    .map((l) => ({
      id: l.name,
      source: l.from,
      target: l.to,
      type: "relation",
      data: {
        cardinality: l.cardinality,
        linkName: l.name,
        dimmed: selectedNode !== null && !connectedEdgeIds.has(l.name),
      },
    }));

  const semanticEdges: Edge[] = showSemantic
    ? semanticRelations
        .filter(
          (r) =>
            r.from.schema &&
            r.to.schema &&
            visibleSet.has(r.from.schema) &&
            visibleSet.has(r.to.schema),
        )
        .map((r) => ({
          id: `sem:${r.id}`,
          // biome-ignore lint/style/noNonNullAssertion: filtered above to guarantee schema is present
          source: r.from.schema!,
          // biome-ignore lint/style/noNonNullAssertion: filtered above to guarantee schema is present
          target: r.to.schema!,
          type: "semantic",
          data: {
            relationType: r.type,
            inferredFrom: r.inferredFrom,
            dimmed: selectedNode !== null && !connectedEdgeIds.has(`sem:${r.id}`),
          },
        }))
    : [];

  const edges = [...structuralEdges, ...semanticEdges];
  const laidOutNodes = applyDagreLayout(nodes, edges);
  return { nodes: laidOutNodes, edges };
}

// ── Impact analysis helpers ──────────────────────────────

interface ImpactEntry {
  schema: string;
  label?: string;
  relationLabel: string;
  direction: "outgoing" | "incoming";
  edgeType: "structural" | "semantic";
  relationType?: string;
}

function computeImpact(
  selectedSchema: string,
  schemas: SchemaInfo[],
  links: LinkDefinition[],
  semanticRelations: SemanticRelation[],
): ImpactEntry[] {
  const labelMap = new Map(schemas.map((s) => [s.name, s.label ?? s.name]));
  const entries: ImpactEntry[] = [];

  for (const link of links) {
    if (link.from === selectedSchema) {
      entries.push({
        schema: link.to,
        label: labelMap.get(link.to),
        relationLabel: `${CARDINALITY_LABEL[link.cardinality] ?? link.cardinality} → ${link.name}`,
        direction: "outgoing",
        edgeType: "structural",
      });
    } else if (link.to === selectedSchema) {
      entries.push({
        schema: link.from,
        label: labelMap.get(link.from),
        relationLabel: `${CARDINALITY_LABEL[link.cardinality] ?? link.cardinality} ← ${link.name}`,
        direction: "incoming",
        edgeType: "structural",
      });
    }
  }

  for (const rel of semanticRelations) {
    if (rel.from.schema === selectedSchema && rel.to.schema) {
      entries.push({
        schema: rel.to.schema,
        label: labelMap.get(rel.to.schema),
        relationLabel: rel.type.replace(/_/g, " "),
        direction: "outgoing",
        edgeType: "semantic",
        relationType: rel.type,
      });
    } else if (rel.to.schema === selectedSchema && rel.from.schema) {
      entries.push({
        schema: rel.from.schema,
        label: labelMap.get(rel.from.schema),
        relationLabel: rel.type.replace(/_/g, " "),
        direction: "incoming",
        edgeType: "semantic",
        relationType: rel.type,
      });
    }
  }

  return entries;
}

// ── Impact panel ─────────────────────────────────────────

interface ImpactPanelProps {
  selectedSchema: string;
  schemas: SchemaInfo[];
  links: LinkDefinition[];
  semanticRelations: SemanticRelation[];
  onNavigate: (name: string) => void;
  onClose: () => void;
}

function ImpactPanel({
  selectedSchema,
  schemas,
  links,
  semanticRelations,
  onNavigate,
  onClose,
}: ImpactPanelProps) {
  const { t } = useTranslation();
  const schemaLabel = schemas.find((s) => s.name === selectedSchema)?.label ?? selectedSchema;
  const entries = useMemo(
    () => computeImpact(selectedSchema, schemas, links, semanticRelations),
    [selectedSchema, schemas, links, semanticRelations],
  );

  const outgoing = entries.filter((e) => e.direction === "outgoing");
  const incoming = entries.filter((e) => e.direction === "incoming");

  return (
    <div
      style={{
        width: 280,
        flexShrink: 0,
        background: "#ffffff",
        border: "1px solid #e2e8f0",
        borderRadius: 12,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        maxHeight: "calc(100vh - 200px)",
      }}
    >
      {/* Panel header */}
      <div
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid #f1f5f9",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          background: "#f8fafc",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <DatabaseIcon size={14} style={{ color: "#6366f1", flexShrink: 0 }} />
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontSize: 13,
                fontWeight: 700,
                color: "#1e293b",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {schemaLabel}
            </div>
            {schemaLabel !== selectedSchema && (
              <div style={{ fontSize: 10, color: "#94a3b8" }}>{selectedSchema}</div>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            padding: 4,
            color: "#94a3b8",
            display: "flex",
            alignItems: "center",
            borderRadius: 4,
            flexShrink: 0,
          }}
          aria-label="Close"
        >
          <XIcon size={14} />
        </button>
      </div>

      {/* Navigate button */}
      <div style={{ padding: "10px 16px", borderBottom: "1px solid #f1f5f9" }}>
        <button
          type="button"
          onClick={() => onNavigate(selectedSchema)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12,
            fontWeight: 600,
            color: "#6366f1",
            background: "#eef2ff",
            border: "none",
            borderRadius: 6,
            padding: "6px 12px",
            cursor: "pointer",
            width: "100%",
            justifyContent: "center",
          }}
        >
          <ArrowRightIcon size={12} />
          {t("relationGraph.impact.navigate", "Open schema list")}
        </button>
      </div>

      {/* Connections */}
      <div style={{ overflowY: "auto", flex: 1, padding: "10px 0" }}>
        {entries.length === 0 ? (
          <div
            style={{ padding: "20px 16px", textAlign: "center", fontSize: 12, color: "#94a3b8" }}
          >
            {t("relationGraph.impact.noConnections", "No connections")}
          </div>
        ) : (
          <>
            {outgoing.length > 0 && (
              <ImpactSection
                title={t("relationGraph.impact.outgoing", "Outgoing")}
                entries={outgoing}
                onSchemaClick={onClose}
              />
            )}
            {incoming.length > 0 && (
              <ImpactSection
                title={t("relationGraph.impact.incoming", "Incoming")}
                entries={incoming}
                onSchemaClick={onClose}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

interface ImpactSectionProps {
  title: string;
  entries: ImpactEntry[];
  onSchemaClick: () => void;
}

function ImpactSection({ title, entries }: ImpactSectionProps) {
  return (
    <div style={{ marginBottom: 4 }}>
      <div
        style={{
          padding: "6px 16px 4px",
          fontSize: 10,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          color: "#94a3b8",
        }}
      >
        {title}
      </div>
      {entries.map((entry) => {
        const color =
          entry.edgeType === "semantic" && entry.relationType
            ? (SEMANTIC_EDGE_COLOR[entry.relationType] ?? "#94a3b8")
            : "#94a3b8";
        return (
          <div
            key={`${entry.direction}-${entry.schema}-${entry.relationLabel}`}
            style={{
              padding: "6px 16px",
              display: "flex",
              alignItems: "flex-start",
              gap: 8,
            }}
          >
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: color,
                flexShrink: 0,
                marginTop: 3,
              }}
            />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: "#1e293b",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {entry.label ?? entry.schema}
              </div>
              <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 1 }}>
                {entry.relationLabel}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Semantic legend ──────────────────────────────────────

interface SemanticLegendProps {
  activeTypes: Set<string>;
}

function SemanticLegend({ activeTypes }: SemanticLegendProps) {
  const { t } = useTranslation();
  if (activeTypes.size === 0) return null;

  return (
    <div
      style={{
        position: "absolute",
        bottom: 12,
        left: 12,
        background: "rgba(255,255,255,0.95)",
        border: "1px solid #e2e8f0",
        borderRadius: 8,
        padding: "8px 12px",
        zIndex: 10,
        pointerEvents: "none",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        maxWidth: 200,
        boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
      }}
    >
      <div
        style={{
          fontSize: 9,
          fontWeight: 700,
          textTransform: "uppercase",
          color: "#94a3b8",
          letterSpacing: "0.05em",
          marginBottom: 2,
        }}
      >
        {t("relationGraph.legend.title", "Semantic relations")}
      </div>
      {[...activeTypes].map((type) => {
        const color = SEMANTIC_EDGE_COLOR[type] ?? "#94a3b8";
        return (
          <div key={type} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <svg
              width="20"
              height="10"
              style={{ flexShrink: 0 }}
              aria-hidden="true"
              focusable="false"
            >
              <line
                x1="0"
                y1="5"
                x2="16"
                y2="5"
                stroke={color}
                strokeWidth="1.5"
                strokeDasharray="4,2"
                opacity="0.8"
              />
            </svg>
            <span style={{ fontSize: 10, color: "#475569", whiteSpace: "nowrap" }}>
              {type.replace(/_/g, " ")}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── GraphCanvas — inner component that owns ReactFlow state ─

interface GraphCanvasProps {
  schemas: SchemaInfo[];
  links: LinkDefinition[];
  semanticRelations: SemanticRelation[];
  showInternal: boolean;
  showSemantic: boolean;
  selectedNode: string | null;
  onSelect: (name: string) => void;
  onNavigate: (name: string) => void;
}

function GraphCanvas({
  schemas,
  links,
  semanticRelations,
  showInternal,
  showSemantic,
  selectedNode,
  onSelect,
  onNavigate,
}: GraphCanvasProps) {
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node>([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<Edge>([]);

  useEffect(() => {
    const { nodes: n, edges: e } = buildGraph(
      schemas,
      links,
      semanticRelations,
      showInternal,
      showSemantic,
      selectedNode,
      onSelect,
      onNavigate,
    );
    setRfNodes(n);
    setRfEdges(e);
  }, [
    schemas,
    links,
    semanticRelations,
    showInternal,
    showSemantic,
    selectedNode,
    onSelect,
    onNavigate,
    setRfNodes,
    setRfEdges,
  ]);

  // Compute which semantic relation types are actually visible for the legend
  const activeSemanticTypes = useMemo(() => {
    if (!showSemantic) return new Set<string>();
    const types = new Set<string>();
    for (const rel of semanticRelations) {
      types.add(rel.type);
    }
    return types;
  }, [showSemantic, semanticRelations]);

  return (
    <div
      style={{ height: "calc(100vh - 200px)", minHeight: 500, position: "relative" }}
      className="overflow-hidden rounded-lg border bg-background"
    >
      {/* Hidden SVG for custom arrow markers */}
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
          {Object.entries(SEMANTIC_EDGE_COLOR).map(([type, color]) => (
            <marker
              key={type}
              id={`semantic-arrow-${type}`}
              markerWidth="8"
              markerHeight="6"
              refX="7"
              refY="3"
              orient="auto"
            >
              <polygon points="0 0, 8 3, 0 6" fill={color} fillOpacity={0.7} />
            </marker>
          ))}
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
          nodeColor={(n) => {
            const d = n.data as SchemaNodeData;
            if (d.selected) return "#6366f1";
            if (d.dimmed) return "#e2e8f0";
            return d.internal ? "#cbd5e1" : "#818cf8";
          }}
          maskColor="rgba(248,250,252,0.7)"
        />
      </ReactFlow>
      {showSemantic && <SemanticLegend activeTypes={activeSemanticTypes} />}
    </div>
  );
}

// ── Page component ───────────────────────────────────────

export function RelationGraphPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [showInternal, setShowInternal] = useState(false);
  const [showSemantic, setShowSemantic] = useState(false);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);

  const schemasQuery = useQuery({ queryKey: ["schemas"], queryFn: fetchSchemas });
  const linksQuery = useQuery({ queryKey: ["links"], queryFn: fetchLinks });
  const semanticQuery = useQuery({
    queryKey: ["semantic-relations"],
    queryFn: fetchSemanticRelations,
    enabled: showSemantic,
  });

  const loading = schemasQuery.isLoading || linksQuery.isLoading;
  const error = schemasQuery.isError || linksQuery.isError;

  const schemas = schemasQuery.data ?? [];
  const links = linksQuery.data ?? [];
  const semanticRelations = semanticQuery.data ?? [];

  const handleSelect = useCallback((name: string) => {
    setSelectedNode((prev) => (prev === name ? null : name));
  }, []);

  const handleNavigate = useCallback(
    (name: string) => {
      navigate({ to: "/schemas/$name", params: { name } });
    },
    [navigate],
  );

  const handleClosePanel = useCallback(() => {
    setSelectedNode(null);
  }, []);

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
          <div className="flex items-center gap-4">
            <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={showSemantic}
                onChange={(e) => setShowSemantic(e.target.checked)}
                className="rounded border-gray-300"
              />
              {t("relationGraph.showSemantic", "Show semantic relations")}
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={showInternal}
                onChange={(e) => setShowInternal(e.target.checked)}
                className="rounded border-gray-300"
              />
              {t("relationGraph.showInternal")}
            </label>
          </div>
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
        <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <GraphCanvas
              schemas={schemas}
              links={links}
              semanticRelations={semanticRelations}
              showInternal={showInternal}
              showSemantic={showSemantic}
              selectedNode={selectedNode}
              onSelect={handleSelect}
              onNavigate={handleNavigate}
            />
          </div>
          {selectedNode && (
            <ImpactPanel
              selectedSchema={selectedNode}
              schemas={schemas}
              links={links}
              semanticRelations={semanticRelations}
              onNavigate={handleNavigate}
              onClose={handleClosePanel}
            />
          )}
        </div>
      )}
    </div>
  );
}
