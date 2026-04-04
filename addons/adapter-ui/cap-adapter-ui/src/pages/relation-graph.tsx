/**
 * RelationGraphPage — /admin/graph
 *
 * Interactive schema relationship diagram.
 * Renders schemas as nodes and relationships as edges using ReactFlow + dagre auto-layout.
 *
 * Visual hierarchy:
 * - SemanticRelation edges are primary (colored solid lines, labeled by relation type)
 * - Link edges are secondary — merged onto semantic edges as cardinality annotations,
 *   or shown as gray dashed "structural-only" edges when no semantic match exists.
 * - Non-schema endpoints (actions, capabilities) from semantic relations are filtered out.
 *
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
import type { RelationDefinition, SemanticRelation } from "@linchkit/core/types";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import dagre from "dagre";
import { ArrowRightIcon, DatabaseIcon, NetworkIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useEntityLabel } from "@/i18n/use-entity-label";
import { fetchLinks, fetchEntities, fetchSemanticRelations, type EntityInfo } from "@/lib/api";

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

// ── Colors per semantic relation type ────────────────────

const SEMANTIC_EDGE_COLOR: Record<string, string> = {
  depends_on: "#6366f1",
  contains: "#0ea5e9",
  references: "#10b981",
  affects: "#f59e0b",
  triggers: "#ef4444",
  orchestrates: "#8b5cf6",
  reads_from: "#ec4899",
  bridges: "#64748b",
  conflicts_with: "#dc2626",
  replaces: "#a855f7",
  derived_from: "#14b8a6",
};

// ── Custom node ──────────────────────────────────────────

interface SchemaNodeData {
  label: string;
  name: string;
  internal: boolean;
  selected: boolean;
  dimmed: boolean;
  linkCount?: number;
  onSelect: (name: string) => void;
  onNavigate: (name: string) => void;
  [key: string]: unknown;
}

function SchemaNode({ data }: NodeProps<Node<SchemaNodeData>>) {
  const { label, name, internal, selected, dimmed, linkCount, onSelect, onNavigate } = data;

  const borderColor = selected ? "#6366f1" : internal ? "#94a3b8" : "#e2e8f0";
  const borderStyle = internal ? "dashed" : "solid";
  const borderWidth = selected ? 2 : 1;
  const bg = selected ? "#eef2ff" : internal ? "#f8fafc" : "#ffffff";
  const boxShadow = selected
    ? "0 0 0 3px rgba(99,102,241,0.18), 0 1px 4px rgba(0,0,0,0.08)"
    : "0 1px 4px rgba(0,0,0,0.08)";

  // Tooltip with schema details
  const tooltipParts = [name];
  if (linkCount !== undefined && linkCount > 0) tooltipParts.push(`Relations: ${linkCount}`);
  tooltipParts.push("Click to select \u00B7 Double-click to navigate");
  const tooltip = tooltipParts.join("\n");

  return (
    <button
      type="button"
      onClick={() => onSelect(name)}
      onDoubleClick={() => onNavigate(name)}
      title={tooltip}
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

// ── Semantic edge (primary — colored solid lines) ────────

interface SemanticEdgeData {
  relationType: string;
  inferredFrom?: string;
  /** Merged cardinality from a matching Link (if any) */
  cardinality?: string;
  /** Matching Link name (if any) */
  linkName?: string;
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
  const opacity = data?.dimmed ? 0.08 : 0.85;
  const cardLabel = data?.cardinality ? (CARDINALITY_LABEL[data.cardinality] ?? "") : "";

  // Build hover tooltip
  const tooltipParts = [`Type: ${relType.replace(/_/g, " ")}`];
  if (data?.inferredFrom) tooltipParts.push(`Inferred from: ${data.inferredFrom}`);
  if (cardLabel) tooltipParts.push(`Cardinality: ${cardLabel}`);
  if (data?.linkName) tooltipParts.push(`Link: ${data.linkName}`);

  return (
    <>
      <path
        id={id}
        d={edgePath}
        fill="none"
        stroke={color}
        strokeWidth={2}
        markerEnd={`url(#semantic-arrow-${relType})`}
        style={{ opacity, transition: "opacity 0.15s" }}
      >
        <title>{tooltipParts.join("\n")}</title>
      </path>
      {!data?.dimmed && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: "all",
            }}
            title={tooltipParts.join("\n")}
          >
            <span
              style={{
                fontSize: 10,
                fontWeight: 600,
                color,
                backgroundColor: "white",
                padding: "1px 6px",
                borderRadius: 9999,
                border: `1px solid ${color}`,
                whiteSpace: "nowrap",
                lineHeight: "16px",
                display: "inline-block",
              }}
            >
              {relType.replace(/_/g, " ")}
              {cardLabel && (
                <span style={{ marginLeft: 4, fontSize: 9, opacity: 0.7 }}>{cardLabel}</span>
              )}
            </span>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

// ── Structural edge (secondary — orphan links only, gray dashed) ─

interface StructuralEdgeData {
  cardinality: string;
  linkName: string;
  dimmed: boolean;
  [key: string]: unknown;
}

function StructuralEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<Edge<StructuralEdgeData>>) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const cardinalityLabel = CARDINALITY_LABEL[data?.cardinality ?? ""] ?? data?.cardinality ?? "";
  const opacity = data?.dimmed ? 0.1 : 0.5;

  const tooltipParts = [`Link: ${data?.linkName ?? ""}`, `Cardinality: ${cardinalityLabel}`];

  return (
    <>
      <path
        id={id}
        d={edgePath}
        fill="none"
        stroke="#94a3b8"
        strokeWidth={1}
        strokeDasharray="6,4"
        markerEnd="url(#relation-arrow)"
        style={{ opacity, transition: "opacity 0.15s" }}
      >
        <title>{tooltipParts.join("\n")}</title>
      </path>
      {cardinalityLabel && !data?.dimmed && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: "all",
            }}
            title={tooltipParts.join("\n")}
          >
            <span
              style={{
                fontSize: 9,
                fontWeight: 500,
                color: "#94a3b8",
                backgroundColor: "#f8fafc",
                padding: "1px 5px",
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
const edgeTypes = { semantic: SemanticEdge, structural: StructuralEdge };

// ── Merge helper: match Links to SemanticRelations ──────

/**
 * Find the Link that corresponds to a given semantic relation (same from/to schemas).
 * Returns the matched link or undefined.
 */
function findMatchingLink(
  rel: SemanticRelation,
  links: RelationDefinition[],
): RelationDefinition | undefined {
  if (!rel.from.entity || !rel.to.entity) return undefined;
  return links.find(
    (l) =>
      (l.from === rel.from.entity && l.to === rel.to.entity) ||
      (l.from === rel.to.entity && l.to === rel.from.entity),
  );
}

// ── Graph builder ────────────────────────────────────────

function buildGraph(
  schemas: EntityInfo[],
  links: RelationDefinition[],
  semanticRelations: SemanticRelation[],
  showInternal: boolean,
  showSemantic: boolean,
  selectedNode: string | null,
  onSelect: (name: string) => void,
  onNavigate: (name: string) => void,
  resolveLabel: (label: string | undefined, fallback: string) => string,
): { nodes: Node[]; edges: Edge[] } {
  const knownSchemaNames = new Set(schemas.map((s) => s.name));

  // Collect schemas that participate in at least one link or semantic relation
  const linkedSchemas = new Set<string>();
  for (const link of links) {
    linkedSchemas.add(link.from);
    linkedSchemas.add(link.to);
  }

  // Track which links are covered by semantic relations (for deduplication)
  const coveredLinks = new Set<string>();

  if (showSemantic) {
    for (const rel of semanticRelations) {
      // Only include endpoints that are actual known schemas (filter out action/capability nodes)
      if (rel.from.entity && knownSchemaNames.has(rel.from.entity)) {
        linkedSchemas.add(rel.from.entity);
      }
      if (rel.to.entity && knownSchemaNames.has(rel.to.entity)) {
        linkedSchemas.add(rel.to.entity);
      }
    }
  }

  // Filter: only known schemas that participate in links; respect internal toggle.
  // No fallback for unknown endpoints — this prevents "action" ghost nodes.
  const visibleSchemas = schemas.filter(
    (s) => linkedSchemas.has(s.name) && (showInternal || !s.internal),
  );
  const visibleSet = new Set(visibleSchemas.map((s) => s.name));

  // Count relations per schema for tooltip
  const linkCountMap = new Map<string, number>();
  for (const link of links) {
    if (visibleSet.has(link.from)) linkCountMap.set(link.from, (linkCountMap.get(link.from) ?? 0) + 1);
    if (visibleSet.has(link.to)) linkCountMap.set(link.to, (linkCountMap.get(link.to) ?? 0) + 1);
  }
  if (showSemantic) {
    for (const rel of semanticRelations) {
      if (rel.from.entity && visibleSet.has(rel.from.entity)) {
        linkCountMap.set(rel.from.entity, (linkCountMap.get(rel.from.entity) ?? 0) + 1);
      }
      if (rel.to.entity && visibleSet.has(rel.to.entity)) {
        linkCountMap.set(rel.to.entity, (linkCountMap.get(rel.to.entity) ?? 0) + 1);
      }
    }
  }

  // Build connected set for dimming when a node is selected
  const connectedNodes = new Set<string>();
  const connectedEdgeIds = new Set<string>();

  if (selectedNode) {
    connectedNodes.add(selectedNode);
    for (const link of links) {
      if (link.from === selectedNode || link.to === selectedNode) {
        connectedNodes.add(link.from);
        connectedNodes.add(link.to);
        connectedEdgeIds.add(`structural:${link.name}`);
      }
    }
    if (showSemantic) {
      for (const rel of semanticRelations) {
        if (rel.from.entity === selectedNode || rel.to.entity === selectedNode) {
          if (rel.from.entity) connectedNodes.add(rel.from.entity);
          if (rel.to.entity) connectedNodes.add(rel.to.entity);
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
      label: resolveLabel(s.label, s.name),
      name: s.name,
      internal: s.internal ?? false,
      selected: s.name === selectedNode,
      dimmed: selectedNode !== null && !connectedNodes.has(s.name),
      linkCount: linkCountMap.get(s.name) ?? 0,
      onSelect,
      onNavigate,
    },
  }));

  // Build semantic edges first (they are primary)
  const semanticEdges: Edge[] = [];
  if (showSemantic) {
    for (const r of semanticRelations) {
      // Only include edges where both endpoints are known visible schemas
      if (
        !r.from.entity ||
        !r.to.entity ||
        !visibleSet.has(r.from.entity) ||
        !visibleSet.has(r.to.entity)
      ) {
        continue;
      }

      // Find matching Link for cardinality annotation
      const matchedLink = findMatchingLink(r, links);
      if (matchedLink) {
        coveredLinks.add(matchedLink.name);
      }

      semanticEdges.push({
        id: `sem:${r.id}`,
        source: r.from.entity,
        target: r.to.entity,
        type: "semantic",
        data: {
          relationType: r.type,
          inferredFrom: r.inferredFrom,
          cardinality: matchedLink?.cardinality,
          linkName: matchedLink?.name,
          dimmed: selectedNode !== null && !connectedEdgeIds.has(`sem:${r.id}`),
        },
      });
    }
  }

  // Build structural edges only for Links NOT covered by a semantic relation
  const structuralEdges: Edge[] = links
    .filter((l) => !coveredLinks.has(l.name) && visibleSet.has(l.from) && visibleSet.has(l.to))
    .map((l) => ({
      id: `structural:${l.name}`,
      source: l.from,
      target: l.to,
      type: "structural",
      data: {
        cardinality: l.cardinality,
        linkName: l.name,
        dimmed: selectedNode !== null && !connectedEdgeIds.has(`structural:${l.name}`),
      },
    }));

  const edges = [...semanticEdges, ...structuralEdges];
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
  schemas: EntityInfo[],
  links: RelationDefinition[],
  semanticRelations: SemanticRelation[],
  resolveLabel: (label: string | undefined, fallback: string) => string,
): ImpactEntry[] {
  const knownSchemaNames = new Set(schemas.map((s) => s.name));
  const labelMap = new Map(schemas.map((s) => [s.name, resolveLabel(s.label, s.name)]));
  const entries: ImpactEntry[] = [];

  // Track which link pairs are covered by semantic relations
  const coveredPairs = new Set<string>();

  // Semantic relations first (primary)
  for (const rel of semanticRelations) {
    if (rel.from.entity === selectedSchema && rel.to.entity && knownSchemaNames.has(rel.to.entity)) {
      coveredPairs.add(`${rel.from.entity}->${rel.to.entity}`);
      coveredPairs.add(`${rel.to.entity}->${rel.from.entity}`);
      const matchedLink = findMatchingLink(rel, links);
      const cardSuffix = matchedLink
        ? ` (${CARDINALITY_LABEL[matchedLink.cardinality] ?? matchedLink.cardinality})`
        : "";
      entries.push({
        schema: rel.to.entity,
        label: labelMap.get(rel.to.entity),
        relationLabel: `${rel.type.replace(/_/g, " ")}${cardSuffix}`,
        direction: "outgoing",
        edgeType: "semantic",
        relationType: rel.type,
      });
    } else if (rel.to.entity === selectedSchema && rel.from.entity && knownSchemaNames.has(rel.from.entity)) {
      coveredPairs.add(`${rel.from.entity}->${rel.to.entity}`);
      coveredPairs.add(`${rel.to.entity}->${rel.from.entity}`);
      const matchedLink = findMatchingLink(rel, links);
      const cardSuffix = matchedLink
        ? ` (${CARDINALITY_LABEL[matchedLink.cardinality] ?? matchedLink.cardinality})`
        : "";
      entries.push({
        schema: rel.from.entity,
        label: labelMap.get(rel.from.entity),
        relationLabel: `${rel.type.replace(/_/g, " ")}${cardSuffix}`,
        direction: "incoming",
        edgeType: "semantic",
        relationType: rel.type,
      });
    }
  }

  // Structural links not covered by semantic relations
  for (const link of links) {
    if (link.from === selectedSchema && !coveredPairs.has(`${link.from}->${link.to}`)) {
      entries.push({
        schema: link.to,
        label: labelMap.get(link.to),
        relationLabel: `${CARDINALITY_LABEL[link.cardinality] ?? link.cardinality} \u2192 ${link.name}`,
        direction: "outgoing",
        edgeType: "structural",
      });
    } else if (link.to === selectedSchema && !coveredPairs.has(`${link.to}->${link.from}`)) {
      entries.push({
        schema: link.from,
        label: labelMap.get(link.from),
        relationLabel: `${CARDINALITY_LABEL[link.cardinality] ?? link.cardinality} \u2190 ${link.name}`,
        direction: "incoming",
        edgeType: "structural",
      });
    }
  }

  return entries;
}

// ── Impact panel ─────────────────────────────────────────

interface ImpactPanelProps {
  selectedSchema: string;
  schemas: EntityInfo[];
  links: RelationDefinition[];
  semanticRelations: SemanticRelation[];
  onNavigate: (name: string) => void;
  onClose: () => void;
  resolveLabel: (label: string | undefined, fallback: string) => string;
}

function ImpactPanel({
  selectedSchema,
  schemas,
  links,
  semanticRelations,
  onNavigate,
  onClose,
  resolveLabel,
}: ImpactPanelProps) {
  const { t } = useTranslation();
  const schemaInfo = schemas.find((s) => s.name === selectedSchema);
  const schemaLabel = resolveLabel(schemaInfo?.label, selectedSchema);
  const entries = useMemo(
    () => computeImpact(selectedSchema, schemas, links, semanticRelations, resolveLabel),
    [selectedSchema, schemas, links, semanticRelations, resolveLabel],
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

// ── Legend ───────────────────────────────────────────────

interface GraphLegendProps {
  activeSemanticTypes: Set<string>;
  hasOrphanLinks: boolean;
}

function GraphLegend({ activeSemanticTypes, hasOrphanLinks }: GraphLegendProps) {
  const { t } = useTranslation();
  if (activeSemanticTypes.size === 0 && !hasOrphanLinks) return null;

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
        maxWidth: 220,
        boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
      }}
    >
      {activeSemanticTypes.size > 0 && (
        <>
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
          {[...activeSemanticTypes].map((type) => {
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
                    strokeWidth="2"
                    opacity="0.85"
                  />
                </svg>
                <span style={{ fontSize: 10, color: "#475569", whiteSpace: "nowrap" }}>
                  {type.replace(/_/g, " ")}
                </span>
              </div>
            );
          })}
        </>
      )}
      {hasOrphanLinks && (
        <>
          {activeSemanticTypes.size > 0 && (
            <div style={{ borderTop: "1px solid #e2e8f0", marginTop: 4, paddingTop: 4 }} />
          )}
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
            {t("relationGraph.legend.structural", "Structural")}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
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
                stroke="#94a3b8"
                strokeWidth="1"
                strokeDasharray="4,2"
                opacity="0.5"
              />
            </svg>
            <span style={{ fontSize: 10, color: "#94a3b8", whiteSpace: "nowrap" }}>
              {t("relationGraph.legend.linkOnly", "Link (no semantic)")}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

// ── GraphCanvas — inner component that owns ReactFlow state ─

interface GraphCanvasProps {
  schemas: EntityInfo[];
  links: RelationDefinition[];
  semanticRelations: SemanticRelation[];
  showInternal: boolean;
  showSemantic: boolean;
  selectedNode: string | null;
  onSelect: (name: string) => void;
  onNavigate: (name: string) => void;
  resolveLabel: (label: string | undefined, fallback: string) => string;
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
  resolveLabel,
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
      resolveLabel,
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
    resolveLabel,
    setRfNodes,
    setRfEdges,
  ]);

  // Compute which semantic relation types are actually visible for the legend
  const activeSemanticTypes = useMemo(() => {
    if (!showSemantic) return new Set<string>();
    const knownNames = new Set(schemas.map((s) => s.name));
    const types = new Set<string>();
    for (const rel of semanticRelations) {
      // Only count types that are actually rendered (both endpoints must be known schemas)
      if (
        rel.from.entity &&
        rel.to.entity &&
        knownNames.has(rel.from.entity) &&
        knownNames.has(rel.to.entity)
      ) {
        types.add(rel.type);
      }
    }
    return types;
  }, [showSemantic, semanticRelations, schemas]);

  // Check if there are orphan (structural-only) links displayed
  const hasOrphanLinks = useMemo(() => {
    return rfEdges.some((e) => e.type === "structural");
  }, [rfEdges]);

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
            <polygon points="0 0, 10 3.5, 0 7" fill="#94a3b8" fillOpacity={0.5} />
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
              <polygon points="0 0, 8 3, 0 6" fill={color} fillOpacity={0.85} />
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
      <GraphLegend activeSemanticTypes={activeSemanticTypes} hasOrphanLinks={hasOrphanLinks} />
    </div>
  );
}

// ── Page component ───────────────────────────────────────

export function RelationGraphPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { resolveLabel } = useEntityLabel();
  const [showInternal, setShowInternal] = useState(false);
  const [showSemantic, setShowSemantic] = useState(true);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);

  const schemasQuery = useQuery({ queryKey: ["schemas"], queryFn: fetchEntities });
  const linksQuery = useQuery({ queryKey: ["links"], queryFn: fetchLinks });
  // Always fetch semantic relations (not gated by showSemantic toggle)
  const semanticQuery = useQuery({
    queryKey: ["semantic-relations"],
    queryFn: fetchSemanticRelations,
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

  const hasLinks = links.length > 0 || semanticRelations.length > 0;

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
              resolveLabel={resolveLabel}
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
              resolveLabel={resolveLabel}
            />
          )}
        </div>
      )}
    </div>
  );
}
