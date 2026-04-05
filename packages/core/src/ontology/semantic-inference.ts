/**
 * Semantic Relation Inference Engine — spec 24 §2.2
 *
 * Scans all registered capability definitions at startup and automatically
 * infers semantic relations between capabilities and schemas.
 *
 * Inference sources (in order of spec 24 §2.2):
 * 1. capability.dependencies → depends_on
 * 2. Schema ref/has_many fields → references / contains
 * 3. capability.bridges → bridges / affects
 * 4. EventHandler cross-module listeners → triggers / affects
 * 5. Flow cross-module action steps → orchestrates
 * 6. Rule cross-module context queries → reads_from
 */

import type { CapabilityDefinition } from "../types/capability";
import type { RuleDefinition } from "../types/rule";
import type {
  RelationGraph,
  SemanticRelation,
  SemanticRelationEndpoint,
} from "../types/semantic-relation";

// ── Inference helpers ────────────────────────────────────

function makeId(
  fromCap: string | undefined,
  fromSchema: string | undefined,
  type: string,
  toCap: string | undefined,
  toSchema: string | undefined,
  suffix?: string,
): string {
  const from = [fromCap ?? "", fromSchema ?? ""].filter(Boolean).join(":");
  const to = [toCap ?? "", toSchema ?? ""].filter(Boolean).join(":");
  return suffix ? `${from}->${type}->${to}@${suffix}` : `${from}->${type}->${to}`;
}

/** Extract the schema name from a conventional event type string like "purchase_request.submit.succeeded" */
function entityFromEventType(eventType: string): string | undefined {
  const parts = eventType.split(".");
  return parts.length >= 2 ? parts[0] : undefined;
}

/** Extract entity name from a rule context query string (e.g. "entity:purchase_request" or raw entity name) */
function entityFromContextQuery(query: string): string | undefined {
  // Support "entity:name" notation (legacy "schema:name" also accepted) and bare names
  const match = query.match(/^entity:(\w+)$/) ?? query.match(/^schema:(\w+)$/) ?? query.match(/^(\w+)$/);
  return match?.[1];
}

// ── Main inferrer ────────────────────────────────────────

export interface InferenceInput {
  capabilities: CapabilityDefinition[];
  /** Optional pre-indexed action→schema map to avoid re-scanning */
  actionToSchema?: Map<string, string>;
}

/**
 * Infer all semantic relations from a set of capability definitions.
 * Returns a deduplicated list — duplicate ids are silently dropped.
 */
export function inferSemanticRelations(input: InferenceInput): SemanticRelation[] {
  const { capabilities } = input;
  const seen = new Set<string>();
  const relations: SemanticRelation[] = [];

  function add(rel: SemanticRelation): void {
    if (!seen.has(rel.id)) {
      seen.add(rel.id);
      relations.push(rel);
    }
  }

  // Build action→schema index from all capabilities
  const actionToSchema = input.actionToSchema ?? buildActionToEntity(capabilities);

  for (const cap of capabilities) {
    // ── 1. capability.dependencies → depends_on ──────────────
    for (const dep of cap.dependencies ?? []) {
      add({
        id: makeId(cap.name, undefined, "depends_on", dep, undefined),
        type: "depends_on",
        from: { capability: cap.name },
        to: { capability: dep },
        source: "capability_dependency",
        inferredFrom: `${cap.name}.dependencies`,
      });
    }

    // ── 2. Schema ref / has_many → references / contains ─────
    for (const schema of cap.entities ?? []) {
      for (const [fieldName, field] of Object.entries(schema.fields ?? {})) {
        if (field.type === "ref" && "target" in field && field.target) {
          add({
            id: makeId(cap.name, schema.name, "references", undefined, field.target, fieldName),
            type: "references",
            from: { capability: cap.name, entity: schema.name },
            to: { entity: field.target },
            source: "schema_ref",
            inferredFrom: `${schema.name}.${fieldName}`,
          });
        }
        if (field.type === "has_many" && "target" in field && field.target) {
          add({
            id: makeId(cap.name, schema.name, "contains", undefined, field.target, fieldName),
            type: "contains",
            from: { capability: cap.name, entity: schema.name },
            to: { entity: field.target },
            source: "schema_has_many",
            inferredFrom: `${schema.name}.${fieldName}`,
          });
        }
      }
    }

    // ── 3. Bridge.bridges → bridges + affects ────────────────
    if (cap.type === "bridge" && cap.bridges) {
      for (const bridged of cap.bridges) {
        add({
          id: makeId(cap.name, undefined, "bridges", bridged.capability, undefined),
          type: "bridges",
          from: { capability: cap.name },
          to: { capability: bridged.capability },
          source: "bridge_definition",
          inferredFrom: `${cap.name}.bridges`,
        });
      }
      // Also infer affects: each bridged cap affects the others
      for (let i = 0; i < cap.bridges.length; i++) {
        for (let j = 0; j < cap.bridges.length; j++) {
          if (i === j) continue;
          // biome-ignore lint/style/noNonNullAssertion: index is within bounds
          const fromCap = cap.bridges[i]!.capability;
          // biome-ignore lint/style/noNonNullAssertion: index is within bounds
          const toCap = cap.bridges[j]!.capability;
          add({
            id: makeId(fromCap, undefined, "affects", toCap, undefined, `via:${cap.name}`),
            type: "affects",
            from: { capability: fromCap },
            to: { capability: toCap },
            source: "bridge_definition",
            inferredFrom: cap.name,
            description: `Inferred via bridge capability ${cap.name}`,
          });
        }
      }
    }

    // ── 4. EventHandler cross-module listeners → triggers / affects ──
    for (const handler of cap.eventHandlers ?? []) {
      const listens = Array.isArray(handler.listen) ? handler.listen : [handler.listen];
      for (const eventType of listens) {
        const sourceSchema = entityFromEventType(eventType);
        if (!sourceSchema) continue;

        // Determine source capability for this schema (best effort)
        const sourceCap = findCapabilityForEntity(capabilities, sourceSchema);

        // If the handler lives in a different capability than where the event originates
        if (sourceCap && sourceCap !== cap.name) {
          add({
            id: makeId(sourceCap, sourceSchema, "triggers", cap.name, undefined, handler.name),
            type: "triggers",
            from: { capability: sourceCap, entity: sourceSchema },
            to: { capability: cap.name },
            source: "event_handler",
            inferredFrom: handler.name,
          });
          add({
            id: makeId(sourceCap, sourceSchema, "affects", cap.name, undefined, handler.name),
            type: "affects",
            from: { capability: sourceCap, entity: sourceSchema },
            to: { capability: cap.name },
            source: "event_handler",
            inferredFrom: handler.name,
          });
        }
      }
    }

    // ── 5. Flow cross-module action steps → orchestrates ─────
    for (const flow of cap.flows ?? []) {
      const touchedSchemas = new Set<string>();

      // Find this flow's "home" schema from its trigger
      const triggerSchema =
        flow.trigger.type === "event" ? entityFromEventType(flow.trigger.eventType) : undefined;

      for (const step of flow.steps ?? []) {
        if (step.type !== "action") continue;
        const targetEntity = actionToSchema.get(step.actionName);
        if (!targetEntity) continue;
        if (touchedSchemas.has(targetEntity)) continue;
        touchedSchemas.add(targetEntity);

        // Only record cross-module orchestration (different schema from trigger)
        if (triggerSchema && targetEntity !== triggerSchema) {
          const targetCap = findCapabilityForEntity(capabilities, targetEntity);
          add({
            id: makeId(cap.name, triggerSchema, "orchestrates", targetCap, targetEntity, flow.name),
            type: "orchestrates",
            from: { capability: cap.name, entity: triggerSchema },
            to: { capability: targetCap ?? undefined, entity: targetEntity },
            source: "flow_step",
            inferredFrom: `${flow.name}/${step.id}`,
          });
        }
      }
    }

    // ── 6. Rule cross-module context queries → reads_from ────
    for (const rule of cap.rules ?? []) {
      if (!rule.context) continue;

      // Determine which schema this rule belongs to
      const ruleSchema = extractRuleEntity(rule, actionToSchema);

      for (const [contextKey, query] of Object.entries(rule.context)) {
        const targetEntity = entityFromContextQuery(query.query);
        if (!targetEntity || targetEntity === ruleSchema) continue;

        const targetCap = findCapabilityForEntity(capabilities, targetEntity);
        const fromCap = ruleSchema ? findCapabilityForEntity(capabilities, ruleSchema) : cap.name;
        add({
          id: makeId(
            fromCap ?? cap.name,
            ruleSchema ?? undefined,
            "reads_from",
            targetCap,
            targetEntity,
            `${rule.name}:${contextKey}`,
          ),
          type: "reads_from",
          from: { capability: fromCap ?? cap.name, entity: ruleSchema ?? undefined },
          to: { capability: targetCap ?? undefined, entity: targetEntity },
          source: "rule_context",
          inferredFrom: `${rule.name}.context.${contextKey}`,
        });
      }
    }
  }

  return relations;
}

// ── RelationGraph factory ────────────────────────────────

/**
 * Build a RelationGraph from a list of capabilities.
 * Accepts optional manual relations to merge alongside inferred ones.
 */
export function buildRelationGraph(
  capabilities: CapabilityDefinition[],
  manualRelations: SemanticRelation[] = [],
): RelationGraph {
  const inferred = inferSemanticRelations({ capabilities });
  const allRelations = [...inferred, ...manualRelations];

  function matchEndpoint(rel: SemanticRelationEndpoint, target: SemanticRelationEndpoint): boolean {
    if (target.capability && target.entity) {
      return rel.capability === target.capability && rel.entity === target.entity;
    }
    if (target.capability) return rel.capability === target.capability;
    if (target.entity) return rel.entity === target.entity;
    return false;
  }

  return {
    relations: allRelations,

    outgoing(endpoint: SemanticRelationEndpoint): SemanticRelation[] {
      return allRelations.filter((r) => matchEndpoint(r.from, endpoint));
    },

    incoming(endpoint: SemanticRelationEndpoint): SemanticRelation[] {
      return allRelations.filter((r) => matchEndpoint(r.to, endpoint));
    },

    forCapability(capabilityName: string): SemanticRelation[] {
      return allRelations.filter(
        (r) => r.from.capability === capabilityName || r.to.capability === capabilityName,
      );
    },

    forEntity(entityName: string): SemanticRelation[] {
      return allRelations.filter((r) => r.from.entity === entityName || r.to.entity === entityName);
    },
  };
}

// ── Internal helpers ─────────────────────────────────────

function buildActionToEntity(capabilities: CapabilityDefinition[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const cap of capabilities) {
    for (const action of cap.actions ?? []) {
      map.set(action.name, action.entity);
    }
  }
  return map;
}

function findCapabilityForEntity(
  capabilities: CapabilityDefinition[],
  entityName: string,
): string | undefined {
  for (const cap of capabilities) {
    if ((cap.entities ?? []).some((s) => s.name === entityName)) {
      return cap.name;
    }
  }
  return undefined;
}

function extractRuleEntity(
  rule: RuleDefinition,
  actionToSchema: Map<string, string>,
): string | undefined {
  const trigger = rule.trigger;
  if ("action" in trigger) {
    const actionNames = Array.isArray(trigger.action) ? trigger.action : [trigger.action];
    for (const name of actionNames) {
      const schema = actionToSchema.get(name);
      if (schema) return schema;
    }
  }
  if ("stateChange" in trigger) return trigger.stateChange.entity;
  if ("fieldChange" in trigger) return trigger.fieldChange.entity;
  return undefined;
}
