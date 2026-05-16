/**
 * Project Documentation Markdown Renderer
 *
 * Renders a structured `ProjectDoc` (produced by `generateProjectDoc`) to
 * deterministic Markdown. Section order, list ordering, and trailing
 * whitespace are stable so the output is byte-identical across runs given
 * the same input — this is essential for `linch docs` diffs and CI.
 *
 * Top-level sections are emitted in a fixed order:
 * Entities -> Rules -> State Machines -> Views -> Flows -> Relations ->
 * Events -> Event Handlers.
 */

import type { EntityDoc, FieldDoc } from "./api-doc-generator";
import type {
  ProjectDoc,
  ProjectEventDoc,
  ProjectEventHandlerDoc,
  ProjectFlowDoc,
  ProjectRelationDoc,
  ProjectRuleDoc,
  ProjectStateMachineDoc,
  ProjectViewDoc,
} from "./project-doc-generator";

/**
 * Render a ProjectDoc to deterministic Markdown.
 *
 * Top-level sections are emitted in a stable order:
 * Entities → Actions (per entity) → Rules → State Machines →
 * Views → Flows → Relations.
 */
export function renderProjectDoc(doc: ProjectDoc): string {
  const lines: string[] = [];

  lines.push(`# ${doc.title}`);
  lines.push("");
  if (doc.description) {
    lines.push(doc.description);
    lines.push("");
  }
  lines.push(`> Generated at ${doc.generatedAt}`);
  lines.push("");
  lines.push("> This file is auto-generated from `defineXxx()` calls. Do not edit by hand.");
  lines.push("");

  // Summary
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Entities: ${doc.entities.length}`);
  lines.push(`- Actions: ${doc.entities.reduce((sum, e) => sum + e.actions.length, 0)}`);
  lines.push(`- Rules: ${doc.rules.length}`);
  lines.push(`- State Machines: ${doc.stateMachines.length}`);
  lines.push(`- Views: ${doc.views.length}`);
  lines.push(`- Flows: ${doc.flows.length}`);
  lines.push(`- Relations: ${doc.relations.length}`);
  lines.push(`- Events: ${doc.events.length}`);
  lines.push(`- Event Handlers: ${doc.eventHandlers.length}`);
  lines.push("");

  if (doc.entities.length > 0) {
    lines.push(...renderEntitiesSection(doc.entities));
  }

  if (doc.rules.length > 0) {
    lines.push(...renderRulesSection(doc.rules));
  }

  if (doc.stateMachines.length > 0) {
    lines.push(...renderStateMachinesSection(doc.stateMachines));
  }

  if (doc.views.length > 0) {
    lines.push(...renderViewsSection(doc.views));
  }

  if (doc.flows.length > 0) {
    lines.push(...renderFlowsSection(doc.flows));
  }

  if (doc.relations.length > 0) {
    lines.push(...renderRelationsSection(doc.relations));
  }

  if (doc.events.length > 0) {
    lines.push(...renderEventsSection(doc.events));
  }

  if (doc.eventHandlers.length > 0) {
    lines.push(...renderEventHandlersSection(doc.eventHandlers));
  }

  // Always end with a single trailing newline for byte-stable diffs.
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

function renderEntitiesSection(entities: EntityDoc[]): string[] {
  const lines: string[] = [];
  lines.push("## Entities");
  lines.push("");
  for (const entity of entities) {
    lines.push(`### ${entity.name}`);
    lines.push("");
    if (entity.description) {
      lines.push(`> ${entity.description}`);
      lines.push("");
    } else if (entity.label && entity.label !== entity.name) {
      lines.push(`Label: ${entity.label}`);
      lines.push("");
    }

    lines.push("**Fields:**");
    lines.push("");
    lines.push(...renderFieldTable(entity.fields));
    lines.push("");

    if (entity.actions.length > 0) {
      lines.push("**Actions:**");
      lines.push("");
      for (const action of entity.actions) {
        const desc = action.description ? `: ${action.description}` : "";
        let transition = "";
        if (action.stateTransition) {
          const from = Array.isArray(action.stateTransition.from)
            ? action.stateTransition.from.join(" | ")
            : action.stateTransition.from;
          transition = ` _(state: ${from} -> ${action.stateTransition.to})_`;
        }
        lines.push(`- \`${action.name}\` — ${action.label}${transition}${desc}`);
      }
      lines.push("");
    }

    if (entity.relations.length > 0) {
      lines.push("**Relations:**");
      lines.push("");
      for (const rel of entity.relations) {
        const arrow = rel.direction === "outgoing" ? "->" : "<-";
        lines.push(
          `- \`${entity.name}\` ${arrow} \`${rel.targetEntity}\` (${rel.cardinality}) via \`${rel.relationName}\``,
        );
      }
      lines.push("");
    }

    if (entity.stateMachine) {
      lines.push("**State machine:**");
      lines.push("");
      lines.push(`- Name: \`${entity.stateMachine.name}\``);
      lines.push(`- Initial: \`${entity.stateMachine.initial}\``);
      lines.push(`- States: ${entity.stateMachine.states.map((s) => `\`${s}\``).join(", ")}`);
      lines.push("");
    }
  }
  return lines;
}

function renderRulesSection(rules: ProjectRuleDoc[]): string[] {
  const lines: string[] = [];
  lines.push("## Rules");
  lines.push("");
  for (const rule of rules) {
    lines.push(`### ${rule.name}`);
    lines.push("");
    if (rule.description) {
      lines.push(`> ${rule.description}`);
      lines.push("");
    }
    if (rule.label && rule.label !== rule.name) {
      lines.push(`- Label: ${rule.label}`);
    }
    lines.push(`- Trigger: ${rule.triggerSummary}`);
    lines.push(`- Effect: ${rule.effectSummary}`);
    lines.push("");
  }
  return lines;
}

function renderStateMachinesSection(machines: ProjectStateMachineDoc[]): string[] {
  const lines: string[] = [];
  lines.push("## State Machines");
  lines.push("");
  for (const sm of machines) {
    lines.push(`### ${sm.name}`);
    lines.push("");
    lines.push(`- Entity: \`${sm.entity}\``);
    lines.push(`- Initial: \`${sm.initial}\``);
    lines.push(`- States: ${sm.states.map((s) => `\`${s}\``).join(", ")}`);
    if (sm.transitions.length > 0) {
      lines.push("");
      lines.push("**Transitions:**");
      lines.push("");
      for (const t of sm.transitions) {
        const from = Array.isArray(t.from) ? t.from.join(" | ") : t.from;
        lines.push(`- \`${from}\` -> \`${t.to}\` via \`${t.action}\``);
      }
    }
    lines.push("");
  }
  return lines;
}

function renderViewsSection(views: ProjectViewDoc[]): string[] {
  const lines: string[] = [];
  lines.push("## Views");
  lines.push("");
  for (const view of views) {
    const label = view.label ? ` — ${view.label}` : "";
    lines.push(`- \`${view.name}\` (entity: \`${view.entity}\`, type: \`${view.type}\`)${label}`);
    if (view.description) {
      lines.push(`  - ${view.description}`);
    }
  }
  lines.push("");
  return lines;
}

function renderFlowsSection(flows: ProjectFlowDoc[]): string[] {
  const lines: string[] = [];
  lines.push("## Flows");
  lines.push("");
  for (const flow of flows) {
    lines.push(`### ${flow.name}`);
    lines.push("");
    if (flow.description) {
      lines.push(`> ${flow.description}`);
      lines.push("");
    }
    if (flow.label && flow.label !== flow.name) {
      lines.push(`- Label: ${flow.label}`);
    }
    lines.push(`- Trigger: ${flow.triggerSummary}`);
    lines.push(
      `- Steps (${flow.stepCount}): ${flow.stepNames.map((s) => `\`${s}\``).join(" -> ")}`,
    );
    if (flow.onError) {
      lines.push(`- On error: ${flow.onError}`);
    }
    lines.push("");
  }
  return lines;
}

function renderRelationsSection(relations: ProjectRelationDoc[]): string[] {
  const lines: string[] = [];
  lines.push("## Relations");
  lines.push("");
  for (const rel of relations) {
    lines.push(
      `- \`${rel.name}\`: \`${rel.from}\` ↔ \`${rel.to}\` (${rel.cardinality}, fromName=\`${rel.fromName}\`, toName=\`${rel.toName}\`)`,
    );
    if (rel.description) {
      lines.push(`  - ${rel.description}`);
    }
    if (rel.cascade && rel.cascade !== "none") {
      lines.push(`  - Cascade: ${rel.cascade}`);
    }
    if (rel.required) {
      lines.push("  - Required: yes");
    }
  }
  lines.push("");
  return lines;
}

function renderEventsSection(events: ProjectEventDoc[]): string[] {
  const lines: string[] = [];
  lines.push("## Events");
  lines.push("");
  for (const event of events) {
    lines.push(`### ${event.name}`);
    lines.push("");
    if (event.description) {
      lines.push(`> ${event.description}`);
      lines.push("");
    }
    if (event.label && event.label !== event.name) {
      lines.push(`- Label: ${event.label}`);
    }
    if (event.payloadKeys.length > 0) {
      lines.push(`- Payload keys: ${event.payloadKeys.map((k) => `\`${k}\``).join(", ")}`);
    }
    lines.push("");
  }
  return lines;
}

function renderEventHandlersSection(handlers: ProjectEventHandlerDoc[]): string[] {
  const lines: string[] = [];
  lines.push("## Event Handlers");
  lines.push("");
  for (const h of handlers) {
    lines.push(`### ${h.name}`);
    lines.push("");
    if (h.description) {
      lines.push(`> ${h.description}`);
      lines.push("");
    }
    if (h.label && h.label !== h.name) {
      lines.push(`- Label: ${h.label}`);
    }
    lines.push(`- Listens: ${h.listen.map((l) => `\`${l}\``).join(", ")}`);
    lines.push(`- Async: ${h.async ? "yes" : "no"}`);
    if (h.priority !== undefined) {
      lines.push(`- Priority: ${h.priority}`);
    }
    lines.push("");
  }
  return lines;
}

/**
 * Escape characters that would break a Markdown table row: pipes (which
 * GFM treats as column separators) and embedded newlines (which would split
 * the row across lines).
 */
function escapeMarkdownTableCell(value: string | undefined): string {
  if (!value) return "";
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function renderFieldTable(fields: FieldDoc[]): string[] {
  if (fields.length === 0) return ["_No fields._"];

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
    lines.push(
      `| ${escapeMarkdownTableCell(f.name)} | ${escapeMarkdownTableCell(typeStr)} | ${req} | ${escapeMarkdownTableCell(desc)} |`,
    );
  }

  return lines;
}
