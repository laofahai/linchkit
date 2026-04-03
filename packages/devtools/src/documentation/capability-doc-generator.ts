/**
 * Capability Documentation Generator
 *
 * Generates per-capability spec documents from CapabilityDefinition,
 * including schemas, actions, rules, state machines, views, dependencies,
 * and relations. Auto-generated — never drifts from the code.
 *
 * See spec: docs/specs/25_documentation.md §2.1
 */

import type { CapabilityDefinition } from "@linchkit/core";
import type { FieldDoc } from "./api-doc-generator";
import { fieldToDoc } from "./api-doc-generator";

// -- Capability doc types -------------------------------------------------

/** Documentation for a capability */
export interface CapabilitySpecDoc {
  /** Capability name */
  name: string;
  /** Human-readable label */
  label: string;
  /** Version string */
  version: string;
  /** Capability description */
  description?: string;
  /** Capability type (standard, adapter, bridge) */
  type: string;
  /** Capability category */
  category: string;
  /** Generated timestamp */
  generatedAt: string;
  /** Schema documentation */
  schemas: CapabilitySchemaDoc[];
  /** Action documentation */
  actions: CapabilityActionDoc[];
  /** Rule documentation */
  rules: CapabilityRuleDoc[];
  /** State machine documentation */
  stateMachines: CapabilityStateMachineDoc[];
  /** View documentation */
  views: CapabilityViewDoc[];
  /** Dependency names */
  dependencies: string[];
  /** Link/relation documentation */
  relations: CapabilityRelationDoc[];
}

/** Schema section within capability doc */
export interface CapabilitySchemaDoc {
  name: string;
  label?: string;
  description?: string;
  fields: FieldDoc[];
}

/** Action section within capability doc */
export interface CapabilityActionDoc {
  name: string;
  schema: string;
  label: string;
  description?: string;
  stateTransition?: { from: string | string[]; to: string };
}

/** Rule section within capability doc */
export interface CapabilityRuleDoc {
  name: string;
  label: string;
  description?: string;
}

/** State machine section within capability doc */
export interface CapabilityStateMachineDoc {
  name: string;
  schema: string;
  initial: string;
  states: string[];
  transitions: Array<{ from: string | string[]; to: string; action: string }>;
}

/** View section within capability doc */
export interface CapabilityViewDoc {
  name: string;
  schema: string;
  type: string;
  label?: string;
}

/** Relation section within capability doc */
export interface CapabilityRelationDoc {
  linkName: string;
  from: string;
  to: string;
  cardinality: string;
  label?: { from?: string; to?: string };
}

// -- Generator -------------------------------------------------

/**
 * Generate a structured capability spec document from a CapabilityDefinition.
 *
 * This extracts all metadata from the capability's schemas, actions, rules,
 * states, views, and links to produce a self-contained specification.
 */
export function generateCapabilityDoc(cap: CapabilityDefinition): CapabilitySpecDoc {
  // Extract schema docs
  const schemas: CapabilitySchemaDoc[] = (cap.entities ?? []).map((s) => ({
    name: s.name,
    label: s.label,
    description: s.description,
    fields: Object.entries(s.fields).map(([name, field]) => fieldToDoc(name, field)),
  }));

  // Extract action docs
  const actions: CapabilityActionDoc[] = (cap.actions ?? []).map((a) => ({
    name: a.name,
    schema: a.schema,
    label: a.label,
    description: a.description,
    stateTransition: a.stateTransition,
  }));

  // Extract rule docs
  const rules: CapabilityRuleDoc[] = (cap.rules ?? []).map((r) => ({
    name: r.name,
    label: r.label,
    description: r.description,
  }));

  // Extract state machine docs
  const stateMachines: CapabilityStateMachineDoc[] = (cap.states ?? []).map((s) => ({
    name: s.name,
    schema: s.schema,
    initial: s.initial,
    states: [...s.states],
    transitions: s.transitions.map((t) => ({
      from: t.from,
      to: t.to,
      action: t.action,
    })),
  }));

  // Extract view docs
  const views: CapabilityViewDoc[] = (cap.views ?? []).map((v) => ({
    name: v.name,
    schema: v.schema,
    type: v.type,
    label: v.label,
  }));

  // Extract relation docs
  const relations: CapabilityRelationDoc[] = (cap.relations ?? []).map((l) => ({
    linkName: l.name,
    from: l.from,
    to: l.to,
    cardinality: l.cardinality,
    label: l.label,
  }));

  return {
    name: cap.name,
    label: cap.label,
    version: cap.version,
    description: cap.description,
    type: cap.type,
    category: cap.category,
    generatedAt: new Date().toISOString(),
    schemas,
    actions,
    rules,
    stateMachines,
    views,
    dependencies: cap.dependencies ?? [],
    relations,
  };
}

// -- Markdown renderer -------------------------------------------------

/**
 * Render a CapabilitySpecDoc to Markdown format.
 *
 * Produces a self-contained capability spec document matching
 * the format described in spec 25 §2.1.
 */
export function renderCapabilityDoc(doc: CapabilitySpecDoc): string {
  const lines: string[] = [];

  // Header
  lines.push(`# ${doc.label} v${doc.version}`);
  lines.push("");
  if (doc.description) {
    lines.push(`> ${doc.description}`);
    lines.push("");
  }
  lines.push(`- **Type:** ${doc.type}`);
  lines.push(`- **Category:** ${doc.category}`);
  lines.push(`- **Generated:** ${doc.generatedAt}`);
  lines.push("");

  // Schemas
  if (doc.schemas.length > 0) {
    lines.push("## Schemas");
    lines.push("");
    for (const schema of doc.schemas) {
      const desc = schema.description ? `: ${schema.description}` : "";
      lines.push(`- **${schema.name}**${desc}`);
      for (const field of schema.fields) {
        const req = field.required ? ", required" : "";
        const target = field.target ? ` -> ${field.target}` : "";
        const machine = field.machine ? ` (${field.machine})` : "";
        lines.push(`  - ${field.name} (${field.type}${req})${target}${machine}: ${field.label}`);
      }
    }
    lines.push("");
  }

  // Actions
  if (doc.actions.length > 0) {
    lines.push("## Actions");
    lines.push("");
    for (const action of doc.actions) {
      let transition = "";
      if (action.stateTransition) {
        const from = Array.isArray(action.stateTransition.from)
          ? action.stateTransition.from.join(" | ")
          : action.stateTransition.from;
        transition = ` (${from} -> ${action.stateTransition.to})`;
      }
      const desc = action.description ? `: ${action.description}` : "";
      lines.push(`- **${action.name}**${transition}${desc}`);
    }
    lines.push("");
  }

  // Rules
  if (doc.rules.length > 0) {
    lines.push("## Rules");
    lines.push("");
    for (const rule of doc.rules) {
      const desc = rule.description ? `: ${rule.description}` : "";
      lines.push(`- **${rule.name}**${desc}`);
    }
    lines.push("");
  }

  // State Machines
  if (doc.stateMachines.length > 0) {
    lines.push("## State Machines");
    lines.push("");
    for (const sm of doc.stateMachines) {
      lines.push(`- **${sm.name}**: ${sm.states.join(" -> ")}`);
      lines.push("");
      lines.push("```mermaid");
      lines.push("stateDiagram-v2");
      lines.push(`  [*] --> ${sm.initial}`);
      for (const t of sm.transitions) {
        const froms = Array.isArray(t.from) ? t.from : [t.from];
        for (const f of froms) {
          lines.push(`  ${f} --> ${t.to}: ${t.action}`);
        }
      }
      lines.push("```");
      lines.push("");
    }
  }

  // Views
  if (doc.views.length > 0) {
    lines.push("## Views");
    lines.push("");
    for (const view of doc.views) {
      const label = view.label ? `: ${view.label}` : "";
      lines.push(`- **${view.name}** (${view.type})${label}`);
    }
    lines.push("");
  }

  // Dependencies
  if (doc.dependencies.length > 0) {
    lines.push("## Dependencies");
    lines.push("");
    for (const dep of doc.dependencies) {
      lines.push(`- ${dep}`);
    }
    lines.push("");
  }

  // Relations
  if (doc.relations.length > 0) {
    lines.push("## Relations");
    lines.push("");
    for (const rel of doc.relations) {
      const label = rel.label ? ` (${rel.label.from ?? rel.to} / ${rel.label.to ?? rel.from})` : "";
      lines.push(`- **${rel.linkName}**: ${rel.from} -> ${rel.to} (${rel.cardinality})${label}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
