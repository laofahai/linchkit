/**
 * Ontology Registry — Unified semantic facade over all registries
 *
 * Read-only aggregator that combines EntityRegistry, ActionRegistry,
 * RelationRegistry, and raw definition arrays to provide unified introspection
 * for AI agents, MCP tools, and documentation generation.
 *
 * See spec: docs/specs/43_ontology_layer.md
 */

import type { ActionDefinition } from "../types/action";
import type {
  EntityDefinition,
  EntityPresentation,
  FieldDefinition,
  InterfaceDefinition,
} from "../types/entity";
import type { EventDefinition, EventHandlerDefinition } from "../types/event";
import type { FlowDefinition } from "../types/flow";
import type {
  DependencyEdge,
  DependencyGraph,
  ImpactLayers,
  MetaModelRef,
  MetaSemantics,
} from "../types/meta-semantics";
import type { RelationCardinality, RelationDefinition } from "../types/relation";
import type { RuleDefinition } from "../types/rule";
import type { StateDefinition } from "../types/state";
import type { ViewDefinition } from "../types/view";
import {
  extractDependencyEdges,
  inferActionSemantics,
  inferEntitySemantics,
  inferFlowSemantics,
  inferGenericSemantics,
  inferRuleSemantics,
} from "./meta-semantics-inference";

// ── Relation descriptor ───────────────────────────────────

/** Directional relationship between two schemas */
export interface RelationDescriptor {
  /** Name of the link definition */
  relationName: string;
  /** Direction relative to the querying entity */
  direction: "outgoing" | "incoming";
  /** Entity on the other end of the relation */
  targetEntity: string;
  /** Cardinality of the relation */
  cardinality: RelationCardinality;
  /** Human-readable label for this direction */
  label?: string;
}

// ── Schema descriptor ───────────────────────────────────

/** Complete picture of a schema — all metadata in one place */
export interface EntityDescriptor {
  /** Schema name */
  name: string;
  /** Human-readable label */
  label?: string;
  /** Schema description */
  description?: string;
  /** Field definitions */
  fields: Record<string, FieldDefinition>;
  /** Presentation metadata */
  presentation?: EntityPresentation;
  /** Relations from RelationRegistry */
  relations: RelationDescriptor[];
  /** Actions operating on this schema (includes inherited from parent) */
  actions: ActionDefinition[];
  /** Rules affecting this schema (includes inherited from parent) */
  rules: RuleDefinition[];
  /** State machine (if defined, or inherited from parent) */
  states?: StateDefinition;
  /** Views for this schema (includes inherited from parent) */
  views: ViewDefinition[];
  /** Flows triggered by this schema's actions/events */
  flows: FlowDefinition[];
  /** Event handlers listening to this schema's events */
  handlers: EventHandlerDefinition[];
  /** Interfaces this schema implements */
  interfaces: InterfaceDefinition[];
  /** Parent schema name (null if no parent) */
  parent?: string | null;
  /** Direct child schema names */
  children?: string[];
  /** Whether this is an abstract schema (cannot be instantiated) */
  abstract?: boolean;
}

// ── Registry dependencies ──────────────────────────────────

/** Minimal interface for EntityRegistry (avoids importing the class) */
interface EntityRegistryLike {
  getAll(): EntityDefinition[];
  get(name: string): EntityDefinition | undefined;
  has(name: string): boolean;
  /** Get the full inheritance chain (root to self) for inheritance-aware lookups */
  getInheritanceChain?(name: string): string[];
  /** Get all descendant schema names recursively */
  getAllDescendants?(name: string): string[];
}

/** Minimal interface for ActionRegistry */
interface ActionRegistryLike {
  getAll(): ActionDefinition[];
}

/** Minimal interface for RelationRegistry */
interface RelationRegistryLike {
  relationsFor(entityName: string): Array<{
    relation: {
      name: string;
      from: string;
      to: string;
      cardinality: RelationCardinality;
      label?: { from?: string; to?: string };
    };
    direction: "outgoing" | "incoming";
    relatedEntity: string;
    label: string;
  }>;
}

/** Minimal interface for FlowRegistry */
interface FlowRegistryLike {
  getAll(): FlowDefinition[];
}

/** Minimal interface for EventHandlerRegistry */
interface EventHandlerRegistryLike {
  getAll(): EventHandlerDefinition[];
}

/** Minimal interface for InterfaceRegistry */
interface InterfaceRegistryLike {
  interfacesOf(entityName: string): InterfaceDefinition[];
  implementors(interfaceName: string): string[];
  list(): InterfaceDefinition[];
}

// ── Dependencies for createOntologyRegistry ──────────────

export interface OntologyRegistryDeps {
  schemas: EntityRegistryLike;
  actions: ActionRegistryLike;
  rules: RuleDefinition[];
  states: StateDefinition[];
  events?: EventDefinition[];
  handlers?: EventHandlerRegistryLike;
  views: ViewDefinition[];
  flows?: FlowRegistryLike;
  links?: RelationRegistryLike;
  interfaces?: InterfaceRegistryLike;
  /** Raw relation definitions for dependency DAG (Spec 67) */
  relationDefs?: RelationDefinition[];
}

// ── OntologyRegistry interface ──────────────────────────

export interface OntologyRegistry {
  /** Get complete descriptor for an entity */
  describe(entityName: string): EntityDescriptor | undefined;

  /** List all entity names in the ontology */
  listEntities(): string[];

  /** Search entities by keyword (matches name, label, description, field names) */
  searchEntities(query: string): EntityDescriptor[];

  /** Get all actions operating on an entity */
  actionsFor(entityName: string): ActionDefinition[];

  /** Get all rules affecting an entity */
  rulesFor(entityName: string): RuleDefinition[];

  /** Get the state machine for an entity (if any) */
  stateFor(entityName: string): StateDefinition | undefined;

  /** Get all views for an entity */
  viewsFor(entityName: string): ViewDefinition[];

  /** Get all flows related to an entity */
  flowsFor(entityName: string): FlowDefinition[];

  /** Get all event handlers related to an entity */
  handlersFor(entityName: string): EventHandlerDefinition[];

  /** Get all relations for an entity */
  relatedEntities(entityName: string): RelationDescriptor[];

  /** Get all entity names that implement a given interface */
  entitiesImplementing(interfaceName: string): string[];

  /** Export full ontology as JSON */
  toJSON(): Record<string, EntityDescriptor>;

  /** Export ontology as Markdown summary */
  toMarkdown(): string;

  // ── Spec 67: Semantic search API ────────────────────

  /** Find all meta-model elements with a matching intent tag */
  searchByIntent(intent: string): MetaModelRef[];

  /** Find all meta-model elements in a given business domain */
  searchByDomain(domain: string): MetaModelRef[];

  /** Get the resolved (inferred + explicit) semantics for a meta-model element */
  getSemanticsFor(ref: MetaModelRef): MetaSemantics | undefined;

  // ── Spec 67: Dependency DAG API ─────────────────────

  /** Return a dependency subgraph rooted at the given element */
  dependencyGraph(ref: MetaModelRef): DependencyGraph;

  /**
   * Impact analysis: who depends on this element?
   * Returns BFS layers — layers[0] = root, layers[1] = direct dependents, etc.
   */
  impactAnalysis(ref: MetaModelRef): ImpactLayers;
}

// ── Factory ────────────────────────────────────────────

/**
 * Create an OntologyRegistry that aggregates existing registries.
 *
 * Build once after all capabilities have registered their definitions.
 * Results are cached per schema name (immutable after construction).
 */
export function createOntologyRegistry(deps: OntologyRegistryDeps): OntologyRegistry {
  const cache = new Map<string, EntityDescriptor>();

  // Pre-index actions by entity
  const actionsByEntity = new Map<string, ActionDefinition[]>();
  for (const action of deps.actions.getAll()) {
    const list = actionsByEntity.get(action.entity) ?? [];
    list.push(action);
    actionsByEntity.set(action.entity, list);
  }

  // Pre-index rules by entity (via trigger, using action registry for resolution)
  const allActions = deps.actions.getAll();
  const rulesByEntity = new Map<string, RuleDefinition[]>();
  for (const rule of deps.rules) {
    const entityNames = extractEntityFromTrigger(rule, actionsByEntity, allActions);
    for (const sn of entityNames) {
      const list = rulesByEntity.get(sn) ?? [];
      list.push(rule);
      rulesByEntity.set(sn, list);
    }
  }

  // Pre-index states by entity
  const statesByEntity = new Map<string, StateDefinition>();
  for (const state of deps.states) {
    statesByEntity.set(state.entity, state);
  }

  // Pre-index views by entity
  const viewsByEntity = new Map<string, ViewDefinition[]>();
  for (const view of deps.views) {
    const list = viewsByEntity.get(view.entity) ?? [];
    list.push(view);
    viewsByEntity.set(view.entity, list);
  }

  // Pre-index flows by related entity (inferred from action steps)
  const flowsByEntity = new Map<string, FlowDefinition[]>();
  if (deps.flows) {
    for (const flow of deps.flows.getAll()) {
      const relatedEntities = extractEntitiesFromFlow(flow, actionsByEntity);
      for (const sn of relatedEntities) {
        const list = flowsByEntity.get(sn) ?? [];
        list.push(flow);
        flowsByEntity.set(sn, list);
      }
    }
  }

  // Pre-index handlers by entity (inferred from event names like "entity.action.succeeded")
  const handlersByEntity = new Map<string, EventHandlerDefinition[]>();
  if (deps.handlers) {
    for (const handler of deps.handlers.getAll()) {
      const handlerEntityNames = extractEntitiesFromHandler(handler, deps.schemas);
      for (const sn of handlerEntityNames) {
        const list = handlersByEntity.get(sn) ?? [];
        list.push(handler);
        handlersByEntity.set(sn, list);
      }
    }
  }

  // ── Spec 67: Dependency DAG + Semantics index ────────────────────────

  const allFlows = deps.flows ? deps.flows.getAll() : [];
  const allHandlers = deps.handlers ? deps.handlers.getAll() : [];
  const allEvents = deps.events ?? [];
  const allRelationDefs = deps.relationDefs ?? [];

  const dagEdges = extractDependencyEdges({
    entities: deps.schemas.getAll(),
    actions: allActions,
    rules: deps.rules,
    states: deps.states,
    events: allEvents,
    handlers: allHandlers,
    flows: allFlows,
    views: deps.views,
    relations: allRelationDefs,
  });

  // Pre-build adjacency maps for O(V+E) BFS
  const dagFromAdj = new Map<string, DependencyEdge[]>();
  const dagToAdj = new Map<string, DependencyEdge[]>();
  for (const edge of dagEdges) {
    const fk = `${edge.from.type}:${edge.from.name}`;
    const tk = `${edge.to.type}:${edge.to.name}`;
    const fromList = dagFromAdj.get(fk) ?? [];
    fromList.push(edge);
    dagFromAdj.set(fk, fromList);
    const toList = dagToAdj.get(tk) ?? [];
    toList.push(edge);
    dagToAdj.set(tk, toList);
  }

  // Pre-index elements by name for O(1) lookups in resolveSemanticsFor
  const actionsByNameMap = new Map(allActions.map((a) => [a.name, a]));
  const rulesByNameMap = new Map(deps.rules.map((r) => [r.name, r]));
  const flowsByNameMap = new Map(allFlows.map((f) => [f.name, f]));
  const statesByNameMap = new Map(deps.states.map((s) => [s.name, s]));
  const eventsByNameMap = new Map(allEvents.map((e) => [e.name, e]));
  const handlersByNameMap = new Map(allHandlers.map((h) => [h.name, h]));
  const viewsByNameMap = new Map(deps.views.map((v) => [v.name, v]));
  const relsByNameMap = new Map(allRelationDefs.map((r) => [r.name, r]));

  // Pre-cache allRefs — built once, not rebuilt on every call
  const cachedAllRefs: MetaModelRef[] = [
    ...deps.schemas.getAll().map((e) => ({ type: "entity" as const, name: e.name })),
    ...allActions.map((a) => ({ type: "action" as const, name: a.name })),
    ...deps.rules.map((r) => ({ type: "rule" as const, name: r.name })),
    ...deps.states.map((s) => ({ type: "state" as const, name: s.name })),
    ...allEvents.map((e) => ({ type: "event" as const, name: e.name })),
    ...allHandlers.map((h) => ({ type: "event_handler" as const, name: h.name })),
    ...deps.views.map((v) => ({ type: "view" as const, name: v.name })),
    ...allFlows.map((f) => ({ type: "flow" as const, name: f.name })),
    ...allRelationDefs.map((r) => ({ type: "relation" as const, name: r.name })),
  ];

  /** Resolve semantics for any meta-model element (infer + merge explicit) */
  function resolveSemanticsFor(ref: MetaModelRef): MetaSemantics | undefined {
    switch (ref.type) {
      case "entity": {
        const entity = deps.schemas.get(ref.name);
        if (!entity) return undefined;
        const entityActions = actionsByEntity.get(ref.name) ?? [];
        const entityState = statesByEntity.get(ref.name);
        return inferEntitySemantics(entity, entityActions, entityState);
      }
      case "action": {
        const action = actionsByNameMap.get(ref.name);
        if (!action) return undefined;
        return inferActionSemantics(action);
      }
      case "rule": {
        const rule = rulesByNameMap.get(ref.name);
        if (!rule) return undefined;
        return inferRuleSemantics(rule);
      }
      case "flow": {
        const flow = flowsByNameMap.get(ref.name);
        if (!flow) return undefined;
        return inferFlowSemantics(flow);
      }
      case "state": {
        return inferGenericSemantics(statesByNameMap.get(ref.name));
      }
      case "event": {
        return inferGenericSemantics(eventsByNameMap.get(ref.name));
      }
      case "event_handler": {
        return inferGenericSemantics(handlersByNameMap.get(ref.name));
      }
      case "view": {
        return inferGenericSemantics(viewsByNameMap.get(ref.name));
      }
      case "relation": {
        return inferGenericSemantics(relsByNameMap.get(ref.name));
      }
      default:
        return undefined;
    }
  }

  /** Collect all MetaModelRefs in the registry */
  function allRefs(): MetaModelRef[] {
    return cachedAllRefs;
  }

  /** Collect items from the inheritance chain (ancestors only, excluding self) */
  function collectFromAncestors<T>(entityName: string, getter: (name: string) => T[]): T[] {
    if (!deps.schemas.getInheritanceChain) return [];
    const chain = deps.schemas.getInheritanceChain(entityName);
    // chain = [root, ..., parent, self]; exclude self (last element)
    const result: T[] = [];
    for (let i = 0; i < chain.length - 1; i++) {
      // biome-ignore lint/style/noNonNullAssertion: index is within bounds
      result.push(...getter(chain[i]!));
    }
    return result;
  }

  /** Get the inherited state machine (walk ancestors, closest parent wins) */
  function inheritedState(entityName: string): StateDefinition | undefined {
    if (!deps.schemas.getInheritanceChain) return undefined;
    const chain = deps.schemas.getInheritanceChain(entityName);
    // Walk from parent to root (chain order is root→self, so reverse excluding self)
    for (let i = chain.length - 2; i >= 0; i--) {
      // biome-ignore lint/style/noNonNullAssertion: index is within bounds
      const state = statesByEntity.get(chain[i]!);
      if (state) return state;
    }
    return undefined;
  }

  function buildDescriptor(entityName: string): EntityDescriptor | undefined {
    const entity = deps.schemas.get(entityName);
    if (!entity) return undefined;

    const relations: RelationDescriptor[] = [];
    if (deps.links) {
      for (const info of deps.links.relationsFor(entityName)) {
        relations.push({
          relationName: info.relation.name,
          direction: info.direction,
          targetEntity: info.relatedEntity,
          cardinality: info.relation.cardinality,
          label: info.label,
        });
      }
    }

    // Resolve interfaces for this entity
    const interfaces: InterfaceDefinition[] = deps.interfaces
      ? deps.interfaces.interfacesOf(entityName)
      : [];

    // Merge inherited actions (parent actions + own actions)
    const inheritedActions = collectFromAncestors(entityName, (n) => actionsByEntity.get(n) ?? []);
    const ownActions = actionsByEntity.get(entityName) ?? [];
    // Deduplicate: child action overrides parent action of same name
    const ownActionNames = new Set(ownActions.map((a) => a.name));
    const mergedActions = [
      ...inheritedActions.filter((a) => !ownActionNames.has(a.name)),
      ...ownActions,
    ];

    // Merge inherited rules (parent rules + own rules)
    const inheritedRules = collectFromAncestors(entityName, (n) => rulesByEntity.get(n) ?? []);
    const ownRules = rulesByEntity.get(entityName) ?? [];
    const ownRuleNames = new Set(ownRules.map((r) => r.name));
    const mergedRules = [...inheritedRules.filter((r) => !ownRuleNames.has(r.name)), ...ownRules];

    // State machine: own takes priority, then inherited
    const ownState = statesByEntity.get(entityName);
    const mergedState = ownState ?? inheritedState(entityName);

    // Merge inherited views (parent views + own views)
    const inheritedViews = collectFromAncestors(entityName, (n) => viewsByEntity.get(n) ?? []);
    const ownViews = viewsByEntity.get(entityName) ?? [];
    const ownViewNames = new Set(ownViews.map((v) => v.name));
    const mergedViews = [...inheritedViews.filter((v) => !ownViewNames.has(v.name)), ...ownViews];

    // Resolve children
    const children: string[] = deps.schemas.getAllDescendants
      ? deps.schemas.getAllDescendants(entityName).filter((n) => {
          // Only direct children
          const child = deps.schemas.get(n);
          return child?.extends === entityName;
        })
      : [];

    return {
      name: entity.name,
      label: entity.label,
      description: entity.description,
      fields: entity.fields,
      presentation: entity.presentation,
      relations,
      actions: mergedActions,
      rules: mergedRules,
      states: mergedState,
      views: mergedViews,
      flows: flowsByEntity.get(entityName) ?? [],
      handlers: handlersByEntity.get(entityName) ?? [],
      interfaces,
      parent: entity.extends ?? null,
      children,
      abstract: entity.abstract,
    };
  }

  function getOrBuild(entityName: string): EntityDescriptor | undefined {
    if (cache.has(entityName)) return cache.get(entityName);
    const desc = buildDescriptor(entityName);
    if (desc) cache.set(entityName, desc);
    return desc;
  }

  return {
    describe(entityName: string): EntityDescriptor | undefined {
      return getOrBuild(entityName);
    },

    listEntities(): string[] {
      return deps.schemas.getAll().map((s) => s.name);
    },

    searchEntities(query: string): EntityDescriptor[] {
      const q = query.toLowerCase();
      const results: EntityDescriptor[] = [];

      for (const entity of deps.schemas.getAll()) {
        const desc = getOrBuild(entity.name);
        if (!desc) continue;

        // Match against name, label, description, and field names
        const haystack = [
          desc.name,
          desc.label ?? "",
          desc.description ?? "",
          ...Object.keys(desc.fields),
        ]
          .join(" ")
          .toLowerCase();

        if (haystack.includes(q)) {
          results.push(desc);
        }
      }

      return results;
    },

    actionsFor(entityName: string): ActionDefinition[] {
      const desc = getOrBuild(entityName);
      return desc?.actions ?? [];
    },

    rulesFor(entityName: string): RuleDefinition[] {
      const desc = getOrBuild(entityName);
      return desc?.rules ?? [];
    },

    stateFor(entityName: string): StateDefinition | undefined {
      const desc = getOrBuild(entityName);
      return desc?.states;
    },

    viewsFor(entityName: string): ViewDefinition[] {
      const desc = getOrBuild(entityName);
      return desc?.views ?? [];
    },

    flowsFor(entityName: string): FlowDefinition[] {
      return flowsByEntity.get(entityName) ?? [];
    },

    handlersFor(entityName: string): EventHandlerDefinition[] {
      return handlersByEntity.get(entityName) ?? [];
    },

    relatedEntities(entityName: string): RelationDescriptor[] {
      const desc = getOrBuild(entityName);
      return desc?.relations ?? [];
    },

    entitiesImplementing(interfaceName: string): string[] {
      return deps.interfaces ? deps.interfaces.implementors(interfaceName) : [];
    },

    toJSON(): Record<string, EntityDescriptor> {
      const result: Record<string, EntityDescriptor> = {};
      for (const entity of deps.schemas.getAll()) {
        const desc = getOrBuild(entity.name);
        if (desc) result[entity.name] = desc;
      }
      return result;
    },

    toMarkdown(): string {
      const lines: string[] = ["# Ontology", ""];
      for (const entity of deps.schemas.getAll()) {
        const desc = getOrBuild(entity.name);
        if (!desc) continue;

        lines.push(`## ${desc.label ?? desc.name}`);
        if (desc.description) lines.push(`> ${desc.description}`);
        lines.push("");

        // Fields
        lines.push("### Fields");
        for (const [name, field] of Object.entries(desc.fields)) {
          const label = field.label ? ` (${field.label})` : "";
          const req = field.required ? " *required*" : "";
          lines.push(`- **${name}**${label}: \`${field.type}\`${req}`);
        }
        lines.push("");

        // Relations
        if (desc.relations.length > 0) {
          lines.push("### Relations");
          for (const rel of desc.relations) {
            lines.push(
              `- ${rel.direction === "outgoing" ? "→" : "←"} **${rel.targetEntity}** (${rel.cardinality}) via \`${rel.relationName}\``,
            );
          }
          lines.push("");
        }

        // Actions
        if (desc.actions.length > 0) {
          lines.push("### Actions");
          for (const action of desc.actions) {
            lines.push(`- **${action.name}**: ${action.label}`);
          }
          lines.push("");
        }

        // Rules
        if (desc.rules.length > 0) {
          lines.push("### Rules");
          for (const rule of desc.rules) {
            lines.push(`- **${rule.name}**: ${rule.label}`);
          }
          lines.push("");
        }

        // State machine
        if (desc.states) {
          lines.push("### State Machine");
          lines.push(`- States: ${desc.states.states.join(", ")}`);
          lines.push(`- Initial: ${desc.states.initial}`);
          lines.push("");
        }

        // Views
        if (desc.views.length > 0) {
          lines.push("### Views");
          for (const view of desc.views) {
            lines.push(`- **${view.name}** (${view.type})`);
          }
          lines.push("");
        }
      }

      return lines.join("\n");
    },

    // ── Spec 67: Semantic search API ──────────────────

    searchByIntent(intent: string): MetaModelRef[] {
      const q = intent.toLowerCase();
      return allRefs().filter((ref) => {
        const sem = resolveSemanticsFor(ref);
        return sem?.intent?.some((i) => i.toLowerCase().includes(q)) ?? false;
      });
    },

    searchByDomain(domain: string): MetaModelRef[] {
      const q = domain.toLowerCase();
      return allRefs().filter((ref) => {
        const sem = resolveSemanticsFor(ref);
        return sem?.domain?.some((d) => d.toLowerCase().includes(q)) ?? false;
      });
    },

    getSemanticsFor(ref: MetaModelRef): MetaSemantics | undefined {
      return resolveSemanticsFor(ref);
    },

    // ── Spec 67: Dependency DAG API ───────────────────

    dependencyGraph(ref: MetaModelRef): DependencyGraph {
      const rk = (r: MetaModelRef) => `${r.type}:${r.name}`;
      const visited = new Set<string>([rk(ref)]);
      const queue: MetaModelRef[] = [ref];
      const nodes: MetaModelRef[] = [ref];
      const edges: DependencyEdge[] = [];
      while (queue.length > 0) {
        const current = queue.shift();
        if (!current) break;
        for (const edge of dagFromAdj.get(rk(current)) ?? []) {
          edges.push(edge);
          const toKey = rk(edge.to);
          if (!visited.has(toKey)) {
            visited.add(toKey);
            queue.push(edge.to);
            nodes.push(edge.to);
          }
        }
      }
      return { root: ref, nodes, edges };
    },

    impactAnalysis(ref: MetaModelRef): ImpactLayers {
      const rk = (r: MetaModelRef) => `${r.type}:${r.name}`;
      const visited = new Set<string>([rk(ref)]);
      const layers: MetaModelRef[][] = [[ref]];
      let frontier = [ref];
      while (frontier.length > 0) {
        const nextLayer: MetaModelRef[] = [];
        for (const node of frontier) {
          for (const edge of dagToAdj.get(rk(node)) ?? []) {
            const fromKey = rk(edge.from);
            if (!visited.has(fromKey)) {
              visited.add(fromKey);
              nextLayer.push(edge.from);
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
    },
  };
}

// ── Helpers ────────────────────────────────────────────

/** Extract entity names from a rule trigger, using action registry to resolve action→entity */
function extractEntityFromTrigger(
  rule: RuleDefinition,
  _actionsByEntity: Map<string, ActionDefinition[]>,
  allActions: ActionDefinition[],
): string[] {
  const trigger = rule.trigger;

  // ActionTrigger: resolve action names to their schema via the action registry
  if ("action" in trigger) {
    const actionNames = Array.isArray(trigger.action) ? trigger.action : [trigger.action];
    const entities = new Set<string>();
    for (const name of actionNames) {
      const action = allActions.find((a) => a.name === name);
      if (action) {
        entities.add(action.entity);
      }
    }
    return [...entities];
  }

  if ("stateChange" in trigger) {
    return [trigger.stateChange.entity];
  }

  if ("fieldChange" in trigger) {
    return [trigger.fieldChange.entity];
  }

  return [];
}

/** Extract entity names from a flow's action steps */
function extractEntitiesFromFlow(
  flow: FlowDefinition,
  actionsByEntity: Map<string, ActionDefinition[]>,
): Set<string> {
  const entities = new Set<string>();

  // Build reverse index: action name → entity
  const actionToEntity = new Map<string, string>();
  for (const [entityName, actions] of actionsByEntity) {
    for (const action of actions) {
      actionToEntity.set(action.name, entityName);
    }
  }

  for (const step of flow.steps) {
    if (step.type === "action") {
      const entityName = actionToEntity.get(step.actionName);
      if (entityName) entities.add(entityName);
    }
  }

  // Also check trigger events
  if (flow.trigger.type === "event") {
    // Convention: event names like "purchase_request.submit.succeeded"
    const parts = flow.trigger.eventType.split(".");
    const entityName = parts[0];
    if (parts.length >= 2 && entityName) {
      entities.add(entityName);
    }
  }

  return entities;
}

/** Extract entity names from an event handler's listen field */
function extractEntitiesFromHandler(
  handler: EventHandlerDefinition,
  entityRegistry: EntityRegistryLike,
): string[] {
  const listen = Array.isArray(handler.listen) ? handler.listen : [handler.listen];
  const entityNames = new Set<string>();

  for (const eventType of listen) {
    // Convention: event names like "purchase_request.submit.succeeded"
    const parts = eventType.split(".");
    const entityName = parts[0];
    if (parts.length >= 2 && entityName && entityRegistry.has(entityName)) {
      entityNames.add(entityName);
    }
  }

  return [...entityNames];
}
