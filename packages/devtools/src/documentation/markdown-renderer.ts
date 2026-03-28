/**
 * Markdown Renderer
 *
 * Converts structured documentation objects (SystemDoc, SchemaDoc, ActionDoc)
 * into Markdown format with table of contents, field tables, and Mermaid diagrams.
 */

import type { ActionDoc, FieldDoc, SchemaDoc, SystemDoc } from "./api-doc-generator";

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
  if (opts.toc && doc.schemas.length > 0) {
    lines.push("## Table of Contents");
    lines.push("");
    for (const schema of doc.schemas) {
      const anchor = schema.name.replace(/[^a-z0-9-]/g, "-");
      lines.push(`- [${schema.label}](#${anchor})`);
    }
    lines.push("");
  }

  // Mermaid ER diagram
  if (opts.mermaid) {
    const mermaid = renderMermaidRelationships(doc.schemas);
    if (mermaid) {
      lines.push("## Relationships");
      lines.push("");
      lines.push(mermaid);
      lines.push("");
    }
  }

  // Schema sections
  for (const schema of doc.schemas) {
    lines.push(renderSchemaDoc(schema, opts));
  }

  return lines.join("\n");
}

/**
 * Render a single SchemaDoc to Markdown.
 */
export function renderSchemaDoc(schema: SchemaDoc, options?: MarkdownRenderOptions): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const lines: string[] = [];

  lines.push(`## ${schema.label}`);
  lines.push("");
  if (schema.description) {
    lines.push(`> ${schema.description}`);
    lines.push("");
  }

  // Field table
  lines.push("### Fields");
  lines.push("");
  lines.push(renderFieldTable(schema.fields));
  lines.push("");

  // Relations
  if (schema.relations.length > 0) {
    lines.push("### Relations");
    lines.push("");
    for (const rel of schema.relations) {
      const arrow = rel.direction === "outgoing" ? "-->" : "<--";
      lines.push(
        `- \`${schema.name}\` ${arrow} \`${rel.targetSchema}\` (${rel.cardinality}) via \`${rel.linkName}\``,
      );
    }
    lines.push("");
  }

  // State machine
  if (opts.stateMachines && schema.stateMachine) {
    lines.push("### State Machine");
    lines.push("");
    lines.push(`- **Name:** ${schema.stateMachine.name}`);
    lines.push(`- **Initial:** ${schema.stateMachine.initial}`);
    lines.push(`- **States:** ${schema.stateMachine.states.join(", ")}`);
    lines.push("");

    // Mermaid state diagram
    if (opts.mermaid) {
      lines.push("```mermaid");
      lines.push("stateDiagram-v2");
      lines.push(`  [*] --> ${schema.stateMachine.initial}`);
      for (const t of schema.stateMachine.transitions) {
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
  if (opts.actions && schema.actions.length > 0) {
    lines.push("### Actions");
    lines.push("");
    for (const action of schema.actions) {
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
function renderMermaidRelationships(schemas: SchemaDoc[]): string | null {
  // Collect unique relationship edges (deduplicate bidirectional)
  const edges = new Set<string>();
  const edgeLines: string[] = [];

  for (const schema of schemas) {
    for (const rel of schema.relations) {
      if (rel.direction !== "outgoing") continue;

      const key = `${schema.name}--${rel.targetSchema}`;
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
      const fromEntity = snakeToPascal(schema.name);
      const toEntity = snakeToPascal(rel.targetSchema);
      edgeLines.push(`  ${fromEntity} ${card} ${toEntity} : "${rel.linkName}"`);
    }
  }

  if (edgeLines.length === 0) return null;

  return ["```mermaid", "erDiagram", ...edgeLines, "```"].join("\n");
}
