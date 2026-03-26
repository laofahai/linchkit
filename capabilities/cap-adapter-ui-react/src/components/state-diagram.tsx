/**
 * StateDiagram — Clean, professional state machine visualization.
 *
 * Uses Mermaid.js for rendering state diagrams. Produces clean,
 * readable diagrams with proper arrows, labels, and state markers.
 */

import mermaid from "mermaid";
import { useCallback, useEffect, useMemo, useRef } from "react";

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

// ── Mermaid initialization ───────────────────────────────

let mermaidInitialized = false;

function ensureMermaidInit() {
  if (mermaidInitialized) return;
  mermaid.initialize({
    startOnLoad: false,
    theme: "base",
    themeVariables: {
      primaryColor: "#f1f5f9",
      primaryTextColor: "#1e293b",
      primaryBorderColor: "#cbd5e1",
      lineColor: "#94a3b8",
      fontSize: "14px",
      fontFamily: "inherit",
    },
    stateDiagram: {
      defaultRenderer: "dagre-wrapper",
    },
  });
  mermaidInitialized = true;
}

// ── Helpers ──────────────────────────────────────────────

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
 * Sanitize a state name for Mermaid (remove special chars that break syntax).
 */
function sanitizeId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

// ── Build Mermaid definition ─────────────────────────────

function buildMermaidDef(
  detail: StateMachineDetail,
  t?: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const lines: string[] = ["stateDiagram-v2"];

  // Map original state names to sanitized IDs
  const idMap = new Map<string, string>();
  for (const state of detail.states) {
    idMap.set(state, sanitizeId(state));
  }

  // State aliases (display labels)
  for (const state of detail.states) {
    const id = idMap.get(state)!;
    const label = getStateLabel(state, detail.meta, t);
    lines.push(`  ${id}: ${label}`);
  }

  // Initial state transition
  const initialId = idMap.get(detail.initial);
  if (initialId) {
    lines.push(`  [*] --> ${initialId}`);
  }

  // Transitions
  for (const tr of detail.transitions) {
    const froms = Array.isArray(tr.from) ? tr.from : [tr.from];
    for (const from of froms) {
      const fromId = idMap.get(from) ?? sanitizeId(from);
      const toId = idMap.get(tr.to) ?? sanitizeId(tr.to);
      lines.push(`  ${fromId} --> ${toId}: ${tr.action}`);
    }
  }

  // Terminal states (no outgoing transitions) point to [*]
  const fromStates = new Set<string>();
  for (const tr of detail.transitions) {
    const froms = Array.isArray(tr.from) ? tr.from : [tr.from];
    for (const f of froms) fromStates.add(f);
  }
  for (const state of detail.states) {
    if (!fromStates.has(state)) {
      const id = idMap.get(state)!;
      lines.push(`  ${id} --> [*]`);
    }
  }

  return lines.join("\n");
}

// ── Counter for unique render IDs ────────────────────────

let renderCounter = 0;

// ── Main component ───────────────────────────────────────

export function StateDiagram({
  machine,
  t,
}: {
  machine: StateMachineDetail;
  t?: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  const definition = useMemo(
    () => buildMermaidDef(machine, t),
    [machine, t],
  );

  const renderDiagram = useCallback(async () => {
    if (!containerRef.current) return;

    ensureMermaidInit();

    const id = `mermaid-state-${++renderCounter}`;
    try {
      const { svg } = await mermaid.render(id, definition);
      if (containerRef.current) {
        containerRef.current.innerHTML = svg;
        // Make the SVG responsive
        const svgEl = containerRef.current.querySelector("svg");
        if (svgEl) {
          svgEl.style.maxWidth = "100%";
          svgEl.style.height = "auto";
        }
      }
    } catch (err) {
      console.error("Mermaid render error:", err);
      if (containerRef.current) {
        containerRef.current.innerHTML = `<pre style="color:#ef4444;padding:16px;font-size:13px;">State diagram render error. Definition:\n${definition}</pre>`;
      }
    }
  }, [definition]);

  useEffect(() => {
    renderDiagram();
  }, [renderDiagram]);

  return (
    <div
      style={{
        width: "100%",
        background: "#f8fafc",
        border: "1px solid #e2e8f0",
        borderRadius: 8,
        overflow: "hidden",
        position: "relative",
      }}
    >
      <div
        ref={containerRef}
        className="w-full overflow-x-auto p-4"
        style={{ minHeight: 120 }}
      />
    </div>
  );
}
