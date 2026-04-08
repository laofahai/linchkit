/**
 * Formatting helpers for `linch describe` subcommands.
 *
 * Extracted from describe.ts to keep files under 500 lines.
 */

import type {
  ActionDefinition,
  ActionDescription,
  CapabilityDefinition,
  EntityDescription,
  FieldDescription,
  FlowDefinition,
  ProjectOverview,
  RelationDefinition,
  RuleDefinition,
  StateDefinition,
  ViewDefinition,
} from "@linchkit/core";

// ── Field formatting ─────────────────────────────────────

export function formatFieldDesc(f: FieldDescription): string {
  const parts: string[] = [];
  if (f.system) parts.push("system");
  if (f.required) parts.push("required");
  if (f.constraints) {
    for (const [k, v] of Object.entries(f.constraints)) {
      if (k === "enum") {
        parts.push(`enum: [${(v as string[]).join(", ")}]`);
      } else {
        parts.push(`${k}: ${v}`);
      }
    }
  }
  const suffix = parts.length > 0 ? `, ${parts.join(", ")}` : "";
  const label = f.label ? ` "${f.label}"` : "";
  return `    ${f.name} (${f.type}${suffix})${label}`;
}

// ── Overview ─────────────────────────────────────────────

export function printOverview(overview: ProjectOverview): void {
  console.log("");
  console.log("  LinchKit Project Overview");
  console.log("  =========================");
  console.log("");

  // Capabilities
  console.log(`  Capabilities (${overview.capabilities.length}):`);
  if (overview.capabilities.length > 0) {
    for (const cap of overview.capabilities) {
      console.log(`    - ${cap.name} (${cap.type}) v${cap.version}`);
    }
  } else {
    console.log("    (none)");
  }
  console.log("");

  // Entities
  console.log(`  Entities (${overview.entities.length}):`);
  if (overview.entities.length > 0) {
    for (const e of overview.entities) {
      const label = e.label ? ` "${e.label}"` : "";
      console.log(`    - ${e.name}${label} (${e.fieldCount} fields)`);
    }
  } else {
    console.log("    (none)");
  }
  console.log("");

  // Actions
  console.log(`  Actions (${overview.actions.length}):`);
  if (overview.actions.length > 0) {
    for (const a of overview.actions) {
      console.log(`    - ${a.name} -> ${a.entity} (${a.label})`);
    }
  } else {
    console.log("    (none)");
  }
  console.log("");

  // Rules
  if (overview.rules.length > 0) {
    console.log(`  Rules (${overview.rules.length}):`);
    for (const r of overview.rules) {
      console.log(`    - ${r.name} (${r.label})`);
    }
    console.log("");
  }

  // State machines
  if (overview.states.length > 0) {
    console.log(`  State Machines (${overview.states.length}):`);
    for (const s of overview.states) {
      console.log(`    - ${s.name} on ${s.entity} (${s.stateCount} states)`);
    }
    console.log("");
  }

  // Flows
  if (overview.flows.length > 0) {
    console.log(`  Flows (${overview.flows.length}):`);
    for (const f of overview.flows) {
      const label = f.label ? ` (${f.label})` : "";
      console.log(`    - ${f.name}${label}`);
    }
    console.log("");
  }

  // Relations
  if (overview.relations.length > 0) {
    console.log(`  Relations (${overview.relations.length}):`);
    for (const r of overview.relations) {
      console.log(`    - ${r.name}: ${r.from} -> ${r.to} (${r.type})`);
    }
    console.log("");
  }
}

// ── Entity description ───────────────────────────────────

export function printEntityDescription(desc: EntityDescription): void {
  console.log("");
  console.log(`  Entity: ${desc.name}`);
  if (desc.label) console.log(`  Label:  ${desc.label}`);
  if (desc.description) console.log(`  Desc:   ${desc.description}`);
  console.log("");

  console.log("  Fields:");
  for (const f of desc.fields) {
    console.log(`  ${formatFieldDesc(f)}`);
  }
  console.log("");

  if (desc.actions.length > 0) {
    console.log("  Actions:");
    for (const a of desc.actions) {
      console.log(`    - ${a.name} (${a.label})`);
    }
    console.log("");
  }

  if (desc.states) {
    console.log("  State Machine:");
    console.log(`    Name:    ${desc.states.name}`);
    console.log(`    States:  ${desc.states.states.join(", ")}`);
    console.log(`    Initial: ${desc.states.initial}`);
    if (desc.states.transitions.length > 0) {
      console.log("    Transitions:");
      for (const t of desc.states.transitions) {
        const from = Array.isArray(t.from) ? t.from.join("|") : t.from;
        console.log(`      ${from} -> ${t.to} (via ${t.action})`);
      }
    }
    console.log("");
  }

  if (desc.relations.length > 0) {
    console.log("  Relations:");
    for (const r of desc.relations) {
      const arrow = r.direction === "outgoing" ? "->" : "<-";
      console.log(`    ${arrow} ${r.target} (${r.cardinality}) via ${r.name}`);
    }
    console.log("");
  }

  if (desc.views.length > 0) {
    console.log("  Views:");
    for (const v of desc.views) {
      console.log(`    - ${v.name} (${v.type})`);
    }
    console.log("");
  }
}

// ── Action description ───────────────────────────────────

export function printActionDescription(desc: ActionDescription): void {
  console.log("");
  console.log(`  Action: ${desc.name}`);
  console.log(`  Entity: ${desc.entity}`);
  console.log(`  Label:  ${desc.label}`);
  if (desc.description) console.log(`  Desc:   ${desc.description}`);
  console.log("");

  if (desc.input.length > 0) {
    console.log("  Input:");
    for (const f of desc.input) {
      console.log(`  ${formatFieldDesc(f)}`);
    }
    console.log("");
  }

  if (desc.output.length > 0) {
    console.log("  Output:");
    for (const f of desc.output) {
      console.log(`  ${formatFieldDesc(f)}`);
    }
    console.log("");
  }

  if (desc.effects.length > 0) {
    console.log("  Effects:");
    for (const e of desc.effects) {
      console.log(`    - ${e}`);
    }
    console.log("");
  }
}

// ── Capability description ───────────────────────────────

export function printCapabilityDescription(cap: CapabilityDefinition): void {
  console.log("");
  console.log(`  Capability: ${cap.name}`);
  console.log(`  Label:      ${cap.label}`);
  if (cap.description) console.log(`  Desc:       ${cap.description}`);
  console.log(`  Type:       ${cap.type}`);
  console.log(`  Category:   ${cap.category}`);
  console.log(`  Version:    ${cap.version}`);
  if (cap.dependencies?.length) {
    console.log(`  Depends on: ${cap.dependencies.join(", ")}`);
  }
  console.log("");

  const capEntities = cap.entities ?? [];
  const capActions = (cap.actions ?? []) as ActionDefinition[];
  const capRules = (cap.rules ?? []) as RuleDefinition[];
  const capStates = (cap.states ?? []) as StateDefinition[];
  const capFlows = (cap.flows ?? []) as FlowDefinition[];
  const capRelations = (cap.relations ?? []) as RelationDefinition[];
  const capViews = (cap.views ?? []) as ViewDefinition[];

  if (capEntities.length > 0) {
    console.log(`  Entities (${capEntities.length}):`);
    for (const e of capEntities) {
      const fieldCount = Object.keys(e.fields).length;
      const label = e.label ? ` "${e.label}"` : "";
      console.log(`    - ${e.name}${label} (${fieldCount} fields)`);
    }
    console.log("");
  }

  if (capActions.length > 0) {
    console.log(`  Actions (${capActions.length}):`);
    for (const a of capActions) {
      console.log(`    - ${a.name} -> ${a.entity}`);
    }
    console.log("");
  }

  if (capRules.length > 0) {
    console.log(`  Rules (${capRules.length}):`);
    for (const r of capRules) {
      console.log(`    - ${r.name}`);
    }
    console.log("");
  }

  if (capStates.length > 0) {
    console.log(`  State Machines (${capStates.length}):`);
    for (const s of capStates) {
      console.log(`    - ${s.name} on ${s.entity} (${s.states.length} states)`);
    }
    console.log("");
  }

  if (capFlows.length > 0) {
    console.log(`  Flows (${capFlows.length}):`);
    for (const f of capFlows) {
      console.log(`    - ${f.name}`);
    }
    console.log("");
  }

  if (capRelations.length > 0) {
    console.log(`  Relations (${capRelations.length}):`);
    for (const r of capRelations) {
      console.log(`    - ${r.name}: ${r.from} -> ${r.to} (${r.cardinality})`);
    }
    console.log("");
  }

  if (capViews.length > 0) {
    console.log(`  Views (${capViews.length}):`);
    for (const v of capViews) {
      console.log(`    - ${v.name} (${v.type}) for ${v.entity}`);
    }
    console.log("");
  }
}

// ── Relations graph description ──────────────────────────

export interface RelationSummary {
  name: string;
  from: string;
  to: string;
  cardinality: string;
  fromName: string;
  toName: string;
}

export interface RelationsOverview {
  total: number;
  relations: RelationSummary[];
  bySourceEntity: Record<string, RelationSummary[]>;
}

export function buildRelationsOverview(relations: RelationDefinition[]): RelationsOverview {
  const summaries: RelationSummary[] = relations.map((r) => ({
    name: r.name,
    from: r.from,
    to: r.to,
    cardinality: r.cardinality,
    fromName: r.fromName,
    toName: r.toName,
  }));

  const bySourceEntity: Record<string, RelationSummary[]> = {};
  for (const s of summaries) {
    const group = bySourceEntity[s.from];
    if (group) {
      group.push(s);
    } else {
      bySourceEntity[s.from] = [s];
    }
  }

  return { total: relations.length, relations: summaries, bySourceEntity };
}

export function printRelationsOverview(overview: RelationsOverview): void {
  console.log("");
  console.log("  Relation Graph Overview");
  console.log("  =======================");
  console.log("");
  console.log(`  Total relations: ${overview.total}`);
  console.log("");

  if (overview.total === 0) {
    console.log("  (no relations defined)");
    console.log("");
    return;
  }

  const sourceEntities = Object.keys(overview.bySourceEntity).sort();
  for (const entity of sourceEntities) {
    const relations = overview.bySourceEntity[entity] ?? [];
    console.log(`  ${entity}:`);
    for (const r of relations) {
      console.log(
        `    - ${r.name}: ${r.from} -> ${r.to} (${r.cardinality}) [${r.fromName} / ${r.toName}]`,
      );
    }
    console.log("");
  }
}
