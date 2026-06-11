/**
 * Structural MetaSemantics inference — Spec 67 §3.1
 *
 * Deterministic inference of MetaSemantics from defineXxx() declarations.
 * No AI required. Explicit semantics always win (§3.4 priority ordering).
 */

import type { ActionDefinition } from "../types/action";
import type { EntityDefinition } from "../types/entity";
import type { EventDefinition, EventHandlerDefinition } from "../types/event";
import type { FlowDefinition } from "../types/flow";
import type {
  ActionSemantics,
  DependencyEdge,
  EntitySemantics,
  FlowSemantics,
  MetaModelRef,
  MetaSemantics,
  RuleSemantics,
} from "../types/meta-semantics";
import type { RelationDefinition } from "../types/relation";
import type { RuleDefinition } from "../types/rule";
import type { StateDefinition } from "../types/state";
import type { ViewDefinition } from "../types/view";

// ── Entity inference ──────────────────────────────────────────────────────────

/**
 * Infer EntitySemantics.category from structural cues:
 * - Has state machine → 'transaction'
 * - Name ends with _log/_history/_audit → 'log'
 * - Name ends with _config/_setting → 'config'
 * - No actions → 'reference'
 * - Otherwise → 'master_data' (default)
 */
export function inferEntitySemantics(
  entity: EntityDefinition,
  actions: ActionDefinition[],
  state: StateDefinition | undefined,
): EntitySemantics {
  const explicit = entity.semantics ?? {};
  const inferred: EntitySemantics = {};

  if (!explicit.category) {
    if (state) {
      inferred.category = "transaction";
    } else if (/_(log|logs|history|histories|audit|audits|event|events)$/.test(entity.name)) {
      inferred.category = "log";
    } else if (/_(config|configs|setting|settings|preference|preferences)$/.test(entity.name)) {
      inferred.category = "config";
    } else if (actions.length === 0) {
      inferred.category = "reference";
    } else {
      inferred.category = "master_data";
    }
  }

  return { ...inferred, ...explicit };
}

// ── Action inference ──────────────────────────────────────────────────────────

/**
 * Infer ActionSemantics:
 * - sideEffects present → sideEffectLevel: 'cross_entity'
 * - stateTransition or setFields → sideEffectLevel: 'local'
 * - policy.failurePolicy === 'compensate' → reversible: true
 */
export function inferActionSemantics(action: ActionDefinition): ActionSemantics {
  const explicit = action.semantics ?? {};
  const inferred: ActionSemantics = {};

  if (!explicit.sideEffectLevel) {
    if (action.sideEffects && action.sideEffects.length > 0) {
      inferred.sideEffectLevel = "cross_entity";
    } else if (action.stateTransition || action.setFields) {
      inferred.sideEffectLevel = "local";
    } else {
      inferred.sideEffectLevel = "local";
    }
  }

  if (explicit.reversible === undefined) {
    inferred.reversible = action.policy.failurePolicy === "compensate";
  }

  return { ...inferred, ...explicit };
}

/** Infer RuleSemantics — no structural cues at type level (Phase 1) */
export function inferRuleSemantics(rule: RuleDefinition): RuleSemantics {
  return rule.semantics ?? {};
}

/** Infer FlowSemantics from label */
export function inferFlowSemantics(flow: FlowDefinition): FlowSemantics {
  const explicit = flow.semantics ?? {};
  const inferred: FlowSemantics = {};
  if (!explicit.businessProcess && flow.label) {
    inferred.businessProcess = flow.label;
  }
  return { ...inferred, ...explicit };
}

export function inferGenericSemantics(
  def: { semantics?: MetaSemantics } | undefined,
): MetaSemantics {
  return def?.semantics ?? {};
}

// ── Dependency DAG extraction — Spec 67 §4.1 ─────────────────────────────────

export interface DagExtractionInput {
  entities: EntityDefinition[];
  actions: ActionDefinition[];
  rules: RuleDefinition[];
  states: StateDefinition[];
  events: EventDefinition[];
  handlers: EventHandlerDefinition[];
  flows: FlowDefinition[];
  views: ViewDefinition[];
  relations: RelationDefinition[];
}

/** Extract all dependency edges from registered definitions */
export function extractDependencyEdges(input: DagExtractionInput): DependencyEdge[] {
  const edges: DependencyEdge[] = [];

  // Build action name → entity reverse index
  const actionToEntity = new Map<string, string>();
  for (const action of input.actions) {
    actionToEntity.set(action.name, action.entity);
  }

  // Action → references → Entity
  for (const action of input.actions) {
    edges.push({
      from: { type: "action", name: action.name },
      to: { type: "entity", name: action.entity },
      type: "references",
    });
  }

  // Rule → field_read → Entity (from trigger); Rule → triggers → Action (from effect)
  for (const rule of input.rules) {
    for (const entityName of extractEntitiesFromRuleTrigger(rule, actionToEntity)) {
      edges.push({
        from: { type: "rule", name: rule.name },
        to: { type: "entity", name: entityName },
        type: "field_read",
      });
    }
    for (const actionName of extractActionsFromEffect(rule)) {
      edges.push({
        from: { type: "rule", name: rule.name },
        to: { type: "action", name: actionName },
        type: "triggers",
      });
    }
  }

  // State.transitions → guards → Rule
  // State.transitions → state_transition → Action (State depends on the action it
  // uses as a transition; deleting the action breaks the state machine).
  const stateNames = new Set(input.states.map((s) => s.name));
  for (const state of input.states) {
    // Dedupe per state: a state may reuse the same action across transitions.
    const seenTransitionActions = new Set<string>();
    for (const transition of state.transitions) {
      if (transition.guard) {
        edges.push({
          from: { type: "state", name: state.name },
          to: { type: "rule", name: transition.guard },
          type: "guards",
        });
      }
      if (
        transition.action &&
        actionToEntity.has(transition.action) &&
        !seenTransitionActions.has(transition.action)
      ) {
        seenTransitionActions.add(transition.action);
        edges.push({
          from: { type: "state", name: state.name },
          to: { type: "action", name: transition.action },
          type: "state_transition",
        });
      }
    }
  }

  // Entity → state_machine → State (Entity depends on its StateDefinition;
  // deleting the state machine breaks the entity). Derive from BOTH the
  // authoritative `StateDefinition.entity` attachment AND a `type: "state"`
  // field's `machine` reference, deduped — a state machine may be attached via
  // either, and the registered field's `machine` can be absent or differ from
  // the state name while the StateDefinition still declares its entity.
  const entityNames = new Set(input.entities.map((e) => e.name));
  const seenStateMachineEdges = new Set<string>();
  const pushStateMachineEdge = (entityName: string, stateName: string): void => {
    const key = `${entityName} ${stateName}`;
    if (seenStateMachineEdges.has(key)) return;
    seenStateMachineEdges.add(key);
    edges.push({
      from: { type: "entity", name: entityName },
      to: { type: "state", name: stateName },
      type: "state_machine",
    });
  };
  // Authoritative: each registered StateDefinition declares the entity it is on.
  for (const state of input.states) {
    if (state.entity && entityNames.has(state.entity)) {
      pushStateMachineEdge(state.entity, state.name);
    }
  }
  // Fallback: an entity field of `type: "state"` naming a registered machine.
  for (const entity of input.entities) {
    for (const field of Object.values(entity.fields ?? {})) {
      if (
        field.type === "state" &&
        typeof field.machine === "string" &&
        stateNames.has(field.machine)
      ) {
        pushStateMachineEdge(entity.name, field.machine);
      }
    }
  }

  // EventHandler → handles → Event (custom events only)
  const eventNames = new Set(input.events.map((e) => e.name));
  for (const handler of input.handlers) {
    const listened = Array.isArray(handler.listen) ? handler.listen : [handler.listen];
    for (const eventType of listened) {
      if (eventNames.has(eventType)) {
        edges.push({
          from: { type: "event_handler", name: handler.name },
          to: { type: "event", name: eventType },
          type: "handles",
        });
      }
    }
  }

  // Flow → contains → Action
  for (const flow of input.flows) {
    for (const step of flow.steps) {
      if (step.type === "action" && actionToEntity.has(step.actionName)) {
        edges.push({
          from: { type: "flow", name: flow.name },
          to: { type: "action", name: step.actionName },
          type: "contains",
        });
      }
    }
  }

  // View → references → Entity
  for (const view of input.views) {
    edges.push({
      from: { type: "view", name: view.name },
      to: { type: "entity", name: view.entity },
      type: "references",
    });
  }

  // Relation → references → Entity (both ends)
  for (const relation of input.relations) {
    edges.push(
      {
        from: { type: "relation", name: relation.name },
        to: { type: "entity", name: relation.from },
        type: "references",
      },
      {
        from: { type: "relation", name: relation.name },
        to: { type: "entity", name: relation.to },
        type: "references",
      },
    );
  }

  return edges;
}

// ── DAG traversal helpers ─────────────────────────────────────────────────────

function refKey(ref: MetaModelRef): string {
  return `${ref.type}:${ref.name}`;
}

/** BFS forward through edges from root */
export function bfsForward(
  root: MetaModelRef,
  allEdges: DependencyEdge[],
): { nodes: MetaModelRef[]; edges: DependencyEdge[] } {
  const visited = new Set<string>([refKey(root)]);
  const queue: MetaModelRef[] = [root];
  const resultNodes: MetaModelRef[] = [root];
  const resultEdges: DependencyEdge[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    const currentKey = refKey(current);

    for (const edge of allEdges) {
      if (refKey(edge.from) === currentKey) {
        resultEdges.push(edge);
        const toKey = refKey(edge.to);
        if (!visited.has(toKey)) {
          visited.add(toKey);
          queue.push(edge.to);
          resultNodes.push(edge.to);
        }
      }
    }
  }

  return { nodes: resultNodes, edges: resultEdges };
}

/** BFS reverse (impact analysis): who depends on root? Returns layered result */
export function bfsReverse(root: MetaModelRef, allEdges: DependencyEdge[]): MetaModelRef[][] {
  const visited = new Set<string>([refKey(root)]);
  const layers: MetaModelRef[][] = [[root]];
  let frontier = [root];

  while (frontier.length > 0) {
    const nextLayer: MetaModelRef[] = [];
    for (const node of frontier) {
      const nodeKey = refKey(node);
      // Reverse: find edges where edge.to === node
      for (const edge of allEdges) {
        if (refKey(edge.to) === nodeKey) {
          const fromKey = refKey(edge.from);
          if (!visited.has(fromKey)) {
            visited.add(fromKey);
            nextLayer.push(edge.from);
          }
        }
      }
    }
    if (nextLayer.length > 0) {
      layers.push(nextLayer);
      frontier = nextLayer;
    } else {
      break;
    }
  }

  return layers;
}

// ── Private helpers ───────────────────────────────────────────────────────────

function extractEntitiesFromRuleTrigger(
  rule: RuleDefinition,
  actionToEntity: Map<string, string>,
): string[] {
  const trigger = rule.trigger as unknown;
  if (!trigger || typeof trigger !== "object") return [];
  const t = trigger as { action?: unknown; stateChange?: unknown; fieldChange?: unknown };
  const entities = new Set<string>();

  const processAction = (name: string): void => {
    const entity = actionToEntity.get(name);
    if (entity) entities.add(entity);
  };

  if (typeof t.action === "string") {
    processAction(t.action);
  } else if (Array.isArray(t.action)) {
    for (const a of t.action) {
      if (typeof a === "string") processAction(a);
    }
  }
  const sc = t.stateChange as { entity?: unknown } | undefined;
  if (sc && typeof sc.entity === "string") entities.add(sc.entity);
  const fc = t.fieldChange as { entity?: unknown } | undefined;
  if (fc && typeof fc.entity === "string") entities.add(fc.entity);

  return [...entities];
}

function extractActionsFromEffect(rule: RuleDefinition): string[] {
  const eff = rule.effect as unknown;
  if (!eff || typeof eff !== "object") return [];
  const e = eff as { action?: unknown };
  if (typeof e.action === "string") return [e.action];
  return [];
}
