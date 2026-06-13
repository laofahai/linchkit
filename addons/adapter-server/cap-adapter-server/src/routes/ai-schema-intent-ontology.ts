/**
 * Spec 52 "说→有" — permission-scoped Ontology snapshot for the schema-intent
 * resolver.
 *
 * Extracted from `ai-resolve-schema-intent.ts` so the route file stays under
 * the repo's 500-line ceiling. This module owns the projection from the full
 * `OntologyRegistry` into the structural `SchemaIntentOntology` the resolver
 * consumes — including the EXISTING-rules snapshot (`update_rule` target
 * list) and its permission gates.
 */

import type {
  ActionDefinition,
  Actor,
  FieldDefinition,
  OntologyRegistry,
  PermissionRegistry,
  RuleDefinition,
} from "@linchkit/core";
import type {
  SchemaIntentEntity,
  SchemaIntentOntology,
  SchemaIntentRule,
  SchemaIntentRuleEffect,
} from "@linchkit/core/ai";
import { checkActionPermission } from "@linchkit/core/server";

/**
 * Build the structural `SchemaIntentOntology` the resolver consumes from the
 * full `OntologyRegistry`, scoped to entities the calling actor can act on.
 *
 * An entity is exposed only when the actor can execute at least one of its
 * actions (matching the permission convention in `permission-middleware.ts`:
 * the action's `entity` is the capability name). When no `permissionRegistry`
 * is wired in (typical dev runs) we pass everything through — same permissive
 * default as `ai-resolve-intent.ts`.
 *
 * Exported for unit testing the permission gate in isolation (both
 * `listEntities` and `describeEntity` must enforce it).
 */
export function buildSchemaIntentOntology(opts: {
  base: OntologyRegistry;
  permissionRegistry?: PermissionRegistry;
  actor: Actor;
}): SchemaIntentOntology {
  const { base, permissionRegistry, actor } = opts;

  const allowedActions = (entityName: string): ActionDefinition[] => {
    const all = base.actionsFor(entityName);
    if (!permissionRegistry) return all;
    const allowed: ActionDefinition[] = [];
    for (const action of all) {
      const result = checkActionPermission(permissionRegistry, actor, action.entity, action.name);
      if (result.allowed) allowed.push(action);
    }
    return allowed;
  };

  const visibleEntities = (): string[] => {
    const out: string[] = [];
    for (const name of base.listEntities()) {
      // With no permission registry, every entity is visible. Otherwise an
      // entity is visible only if the actor can run at least one of its
      // actions — there is nothing to attach a rule trigger to otherwise.
      if (!permissionRegistry || allowedActions(name).length > 0) out.push(name);
    }
    return out;
  };

  // Project a registered RuleDefinition into the resolver's rule snapshot.
  // A CODE condition (a TypeScript function) is NEVER serialized — only its
  // kind + the rule's description are exposed, so the AI cannot pretend to
  // edit source it cannot see. Declarative conditions are structured data
  // and travel whole. `priority` + the declarative effect payload travel too
  // so an update round-trip never silently resets / fabricates them, and
  // `roundTrippable` marks whether the FULL rule can be rebuilt declaratively
  // (the resolver takes the honest diff-only path otherwise).
  const toSchemaIntentRule = (rule: RuleDefinition): SchemaIntentRule => {
    const isCode = typeof rule.condition === "function";
    // `rule.trigger` is guarded everywhere it is narrowed with `in`: a
    // malformed rule can carry an undefined/null trigger at runtime despite
    // the static type, and `"action" in undefined` throws.
    const triggerActions =
      rule.trigger && "action" in rule.trigger
        ? Array.isArray(rule.trigger.action)
          ? rule.trigger.action
          : [rule.trigger.action]
        : undefined;
    // Only the declarative payload fields the resolver's buildEffect consumes
    // (message / level / setFields) — never execute_action / trigger_flow
    // params, which are not declaratively rebuildable anyway.
    const effect: SchemaIntentRuleEffect = { type: rule.effect.type };
    if ("message" in rule.effect && rule.effect.message !== undefined) {
      effect.message = rule.effect.message;
    }
    if ("level" in rule.effect) effect.level = rule.effect.level;
    if ("setFields" in rule.effect) effect.setFields = rule.effect.setFields;
    // The declarative rebuild path (buildRuleDefinition) can only express:
    // a SINGLE-action trigger, a SIMPLE (non-composite/not) condition, and a
    // block/warn/require_approval/enrich effect. Anything else must take the
    // diff-only path or the rebuild would silently flatten/replace parts the
    // user never asked to change.
    const hasSingleActionTrigger = Boolean(
      rule.trigger && "action" in rule.trigger && typeof rule.trigger.action === "string",
    );
    const hasSimpleCondition =
      !isCode &&
      typeof rule.condition === "object" &&
      rule.condition !== null &&
      "field" in rule.condition;
    const hasDeclarativeEffect =
      rule.effect.type === "block" ||
      rule.effect.type === "warn" ||
      rule.effect.type === "require_approval" ||
      rule.effect.type === "enrich";
    const roundTrippable = hasSingleActionTrigger && hasSimpleCondition && hasDeclarativeEffect;
    return {
      name: rule.name,
      label: rule.label,
      description: rule.description,
      ...(triggerActions ? { triggerActions } : {}),
      effectType: rule.effect.type,
      effect,
      ...(rule.priority !== undefined ? { priority: rule.priority } : {}),
      conditionKind: isCode ? "code" : "declarative",
      ...(isCode ? {} : { condition: rule.condition as SchemaIntentRule["condition"] }),
      roundTrippable,
      // Pass through the rule's opt-in graduation target (#566) so the resolver
      // can assemble a `sourcePatch` for a code-condition threshold change. Only
      // present when the rule declared it (deterministic, reviewable).
      ...(rule.patchTarget ? { patchTarget: rule.patchTarget } : {}),
    };
  };

  // Permission gate for rules, mirroring `actionNames`: an action-triggered
  // rule is visible only when the actor can run at least one of its trigger
  // actions. Rules with non-action triggers (state/event/schedule) ride on
  // the entity-level gate, which already passed by the time this runs.
  const visibleRules = (entityName: string, rules: RuleDefinition[]): SchemaIntentRule[] => {
    if (!permissionRegistry) return rules.map(toSchemaIntentRule);
    const allowedNames = new Set(allowedActions(entityName).map((a) => a.name));
    return rules
      .filter((rule) => {
        // A malformed (trigger-less) rule rides the entity-level gate, same
        // as non-action triggers — `in` on undefined/null would throw.
        if (!rule.trigger || !("action" in rule.trigger)) return true;
        const actions = Array.isArray(rule.trigger.action)
          ? rule.trigger.action
          : [rule.trigger.action];
        return actions.some((name) => allowedNames.has(name));
      })
      .map(toSchemaIntentRule);
  };

  return {
    listEntities: () => visibleEntities(),
    describeEntity: (entityName: string): SchemaIntentEntity | undefined => {
      // Enforce the SAME permission gate the visible-entity list uses. Without
      // this, calling describeEntity() directly with an entity the actor cannot
      // act on would leak its full description (least-privilege violation) —
      // listEntities() filters, but describeEntity() must too.
      if (permissionRegistry && allowedActions(entityName).length === 0) {
        return undefined;
      }
      const descriptor = base.describe(entityName);
      if (!descriptor) return undefined;
      const fields: SchemaIntentEntity["fields"] = [];
      for (const [name, raw] of Object.entries(descriptor.fields)) {
        const field = raw as FieldDefinition;
        fields.push({
          name,
          type: field.type,
          required: field.required === true,
          label: field.label,
          description: field.description,
        });
      }
      return {
        name: descriptor.name,
        label: descriptor.label,
        description: descriptor.description,
        fields,
        actionNames: allowedActions(entityName).map((a) => a.name),
        // EXISTING rules (includes inherited) — the `update_rule` target list.
        rules: visibleRules(entityName, descriptor.rules),
      };
    },
  };
}
