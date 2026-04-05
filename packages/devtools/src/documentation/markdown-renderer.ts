/**
 * Markdown Renderer
 *
 * Converts structured documentation objects (SystemDoc, SchemaDoc, ActionDoc)
 * into Markdown format with table of contents, field tables, and Mermaid diagrams.
 */

import type { ActionDoc, EntityDoc, FieldDoc, SystemDoc } from "./api-doc-generator";

/** Convert snake_case to PascalCase for Mermaid entity names */
function snakeToPascal(s: string): string {
  return s
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

// -- Render options -------------------------------------------------

export interface MarkdownRenderOptions {
  /** Include table of contents. Default: true */
  toc?: boolean;
  /** Include Mermaid relationship diagrams. Default: true */
  mermaid?: boolean;
  /** Include action documentation. Default: true */
  actions?: boolean;
  /** Include state machine documentation. Default: true */
  stateMachines?: boolean;
}

const DEFAULT_OPTIONS: Required<MarkdownRenderOptions> = {
  toc: true,
  mermaid: true,
  actions: true,
  stateMachines: true,
};

// -- Public API -------------------------------------------------

/**
 * Render a full SystemDoc to Markdown.
 */
export function renderSystemDoc(doc: SystemDoc, options?: MarkdownRenderOptions): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const lines: string[] = [];

  lines.push(`# ${doc.title}`);
  lines.push("");
  if (doc.description) {
    lines.push(doc.description);
    lines.push("");
  }
  lines.push(`> Generated at ${doc.generatedAt}`);
  lines.push("");

  // Table of contents
  if (opts.toc && doc.entities.length > 0) {
    lines.push("## Table of Contents");
    lines.push("");
    for (const entity of doc.entities) {
      const anchor = entity.name.replace(/[^a-z0-9-]/g, "-");
      lines.push(`- [${entity.label}](#${anchor})`);
    }
    lines.push("");
  }

  // Mermaid ER diagram
  if (opts.mermaid) {
    const mermaid = renderMermaidRelationships(doc.entities);
    if (mermaid) {
      lines.push("## Relationships");
      lines.push("");
      lines.push(mermaid);
      lines.push("");
    }
  }

  // Entity sections
  for (const entity of doc.entities) {
    lines.push(renderEntityDoc(entity, opts));
  }

  return lines.join("\n");
}

/**
 * Render a single EntityDoc to Markdown.
 */
export function renderEntityDoc(entity: EntityDoc, options?: MarkdownRenderOptions): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const lines: string[] = [];

  lines.push(`## ${entity.label}`);
  lines.push("");
  if (entity.description) {
    lines.push(`> ${entity.description}`);
    lines.push("");
  }

  // Field table
  lines.push("### Fields");
  lines.push("");
  lines.push(renderFieldTable(entity.fields));
  lines.push("");

  // Relations
  if (entity.relations.length > 0) {
    lines.push("### Relations");
    lines.push("");
    for (const rel of entity.relations) {
      const arrow = rel.direction === "outgoing" ? "-->" : "<--";
      lines.push(
        `- \`${entity.name}\` ${arrow} \`${rel.targetEntity}\` (${rel.cardinality}) via \`${rel.relationName}\``,
      );
    }
    lines.push("");
  }

  // State machine
  if (opts.stateMachines && entity.stateMachine) {
    lines.push("### State Machine");
    lines.push("");
    lines.push(`- **Name:** ${entity.stateMachine.name}`);
    lines.push(`- **Initial:** ${entity.stateMachine.initial}`);
    lines.push(`- **States:** ${entity.stateMachine.states.join(", ")}`);
    lines.push("");

    // Mermaid state diagram
    if (opts.mermaid) {
      lines.push("```mermaid");
      lines.push("stateDiagram-v2");
      lines.push(`  [*] --> ${entity.stateMachine.initial}`);
      for (const t of entity.stateMachine.transitions) {
        const froms = Array.isArray(t.from) ? t.from : [t.from];
        for (const f of froms) {
          lines.push(`  ${f} --> ${t.to}: ${t.action}`);
        }
      }
      lines.push("```");
      lines.push("");
    }
  }

  // Actions
  if (opts.actions && entity.actions.length > 0) {
    lines.push("### Actions");
    lines.push("");
    for (const action of entity.actions) {
      lines.push(renderActionDoc(action));
    }
  }

  return lines.join("\n");
}

/**
 * Render a single ActionDoc to Markdown.
 */
export function renderActionDoc(action: ActionDoc): string {
  const lines: string[] = [];

  lines.push(`#### ${action.label} (\`${action.name}\`)`);
  lines.push("");
  if (action.description) {
    lines.push(action.description);
    lines.push("");
  }

  // Metadata
  lines.push(`- **Mode:** ${action.policy.mode}`);
  lines.push(`- **Transaction:** ${action.policy.transaction ? "yes" : "no"}`);
  if (action.stateTransition) {
    const from = Array.isArray(action.stateTransition.from)
      ? action.stateTransition.from.join(" | ")
      : action.stateTransition.from;
    lines.push(`- **State transition:** ${from} -> ${action.stateTransition.to}`);
  }

  // Exposure
  const exposedChannels = Object.entries(action.exposure)
    .filter(([, v]) => v)
    .map(([k]) => k);
  if (exposedChannels.length > 0) {
    lines.push(`- **Exposed via:** ${exposedChannels.join(", ")}`);
  }

  // Permissions
  if (action.permissions) {
    if (action.permissions.groups?.length) {
      lines.push(`- **Required groups:** ${action.permissions.groups.join(", ")}`);
    }
    if (action.permissions.actorTypes?.length) {
      lines.push(`- **Actor types:** ${action.permissions.actorTypes.join(", ")}`);
    }
  }
  lines.push("");

  // Input table
  if (action.input.length > 0) {
    lines.push("**Input:**");
    lines.push("");
    lines.push(renderFieldTable(action.input));
    lines.push("");
  }

  // Output table
  if (action.output.length > 0) {
    lines.push("**Output:**");
    lines.push("");
    lines.push(renderFieldTable(action.output));
    lines.push("");
  }

  return lines.join("\n");
}

// -- Internal helpers -------------------------------------------------

/** Render a field list as a Markdown table */
function renderFieldTable(fields: FieldDoc[]): string {
  if (fields.length === 0) return "_No fields._";

  const lines: string[] = [];
  lines.push("| Name | Type | Required | Description |");
  lines.push("|------|------|----------|-------------|");

  for (const f of fields) {
    let typeStr = f.type;
    if (f.target) typeStr += ` -> ${f.target}`;
    if (f.options) typeStr += ` [${f.options.map((o) => o.value).join(", ")}]`;
    if (f.machine) typeStr += ` (${f.machine})`;

    const req = f.required ? "yes" : "no";
    const desc = f.description ?? f.label;
    lines.push(`| ${f.name} | ${typeStr} | ${req} | ${desc} |`);
  }

  return lines.join("\n");
}

/**
 * Render a Mermaid ER diagram showing relationships across all schemas.
 * Returns null if there are no relationships.
 */
function renderMermaidRelationships(entities: EntityDoc[]): string | null {
  // Collect unique relationship edges (deduplicate bidirectional)
  const edges = new Set<string>();
  const edgeLines: string[] = [];

  for (const entity of entities) {
    for (const rel of entity.relations) {
      if (rel.direction !== "outgoing") continue;

      const key = `${entity.name}--${rel.targetEntity}`;
      if (edges.has(key)) continue;
      edges.add(key);

      const cardMap: Record<string, string> = {
        one_to_one: "||--||",
        one_to_many: "||--o{",
        many_to_one: "}o--||",
        many_to_many: "}o--o{",
      };

      const card = cardMap[rel.cardinality] ?? "--";
      // Mermaid erDiagram requires alphanumeric entity names (no underscores)
      const fromEntity = snakeToPascal(entity.name);
      const toEntity = snakeToPascal(rel.targetEntity);
      edgeLines.push(`  ${fromEntity} ${card} ${toEntity} : "${rel.relationName}"`);
    }
  }

  if (edgeLines.length === 0) return null;

  return ["```mermaid", "erDiagram", ...edgeLines, "```"].join("\n");
}
