/**
 * Extension/Override Resolution Engine for Bridge Capabilities
 *
 * Collects schema extensions, schema overrides, action overrides, and rule overrides
 * from bridge (and other) capabilities, then applies them to the base definitions
 * before registries are finalized.
 *
 * Action overrides follow an onion model: sorted by priority (ascending = inner),
 * each layer can wrap the original handler with before/after hooks or fully replace it.
 */

import type { ActionContext, ActionDefinition, ActionOverride } from "../types/action";
import type { RuleDefinition, RuleOverride } from "../types/rule";
import type {
  FieldConstraints,
  FieldDefinition,
  EntityDefinition,
  EntityExtension,
  EntityOverride,
} from "../types/schema";

// ── Collected entry types ──────────────────────────────────

export interface EntityExtensionEntry {
  target: string;
  extension: EntityExtension;
  source: string;
  priority: number;
}

export interface EntityOverrideEntry {
  target: string;
  override: EntityOverride;
  source: string;
  priority: number;
}

export interface ActionOverrideEntry {
  target: string;
  override: ActionOverride;
  source: string;
  priority: number;
}

export interface RuleOverrideEntry {
  target: string;
  override: RuleOverride;
  source: string;
  priority: number;
}

// ── Conflict info ──────────────────────────────────────────

export interface ResolutionConflict {
  type: "schema_field_collision" | "action_full_replacement" | "rule_override";
  target: string;
  field?: string;
  sources: string[];
  message: string;
}

// ── ExtensionResolver ──────────────────────────────────────

export interface ExtensionResolver {
  // Collect extensions/overrides from capabilities
  addEntityExtension(
    target: string,
    extension: EntityExtension,
    source: string,
    priority: number,
  ): void;
  addEntityOverride(
    target: string,
    override: EntityOverride,
    source: string,
    priority: number,
  ): void;
  addActionOverride(
    target: string,
    override: ActionOverride,
    source: string,
    priority: number,
  ): void;
  addRuleOverride(target: string, override: RuleOverride, source: string, priority: number): void;

  // Apply all collected extensions/overrides to definitions
  resolveSchemas(schemas: EntityDefinition[]): EntityDefinition[];
  resolveActions(actions: ActionDefinition[]): ActionDefinition[];
  resolveRules(rules: RuleDefinition[]): RuleDefinition[];

  // Inspect collected conflicts (warnings, not errors)
  getConflicts(): ResolutionConflict[];
}

/**
 * Create an ExtensionResolver instance.
 *
 * Typical usage during startup:
 * 1. Iterate over all capabilities, call addXxx for each extension/override
 * 2. Call resolveSchemas/resolveActions/resolveRules before registering into registries
 */
export function createExtensionResolver(): ExtensionResolver {
  const schemaExtensions: EntityExtensionEntry[] = [];
  const schemaOverrides: EntityOverrideEntry[] = [];
  const actionOverrides: ActionOverrideEntry[] = [];
  const ruleOverrides: RuleOverrideEntry[] = [];
  const conflicts: ResolutionConflict[] = [];

  function addEntityExtension(
    target: string,
    extension: EntityExtension,
    source: string,
    priority: number,
  ): void {
    schemaExtensions.push({ target, extension, source, priority });
  }

  function addEntityOverride(
    target: string,
    override: EntityOverride,
    source: string,
    priority: number,
  ): void {
    schemaOverrides.push({ target, override, source, priority });
  }

  function addActionOverride(
    target: string,
    override: ActionOverride,
    source: string,
    priority: number,
  ): void {
    actionOverrides.push({ target, override, source, priority });
  }

  function addRuleOverride(
    target: string,
    override: RuleOverride,
    source: string,
    priority: number,
  ): void {
    ruleOverrides.push({ target, override, source, priority });
  }

  // ── Schema resolution ──────────────────────────────────

  function resolveSchemas(schemas: EntityDefinition[]): EntityDefinition[] {
    const schemaMap = new Map<string, EntityDefinition>();
    for (const s of schemas) {
      schemaMap.set(s.name, { ...s, fields: { ...s.fields } });
    }

    // Apply extensions: add new fields, sorted by priority (lower first)
    const sortedExtensions = [...schemaExtensions].sort((a, b) => a.priority - b.priority);
    for (const entry of sortedExtensions) {
      const schema = schemaMap.get(entry.target);
      if (!schema) continue;

      for (const [fieldName, fieldDef] of Object.entries(entry.extension.fields)) {
        if (schema.fields[fieldName]) {
          // Field already exists — record conflict but still apply (higher priority wins)
          const existingSources = sortedExtensions
            .filter((e) => e.target === entry.target && e.extension.fields[fieldName])
            .map((e) => e.source);
          if (existingSources.length > 1) {
            conflicts.push({
              type: "schema_field_collision",
              target: entry.target,
              field: fieldName,
              sources: existingSources,
              message: `Field "${fieldName}" on schema "${entry.target}" added by multiple sources: ${existingSources.join(", ")}`,
            });
          }
        }
        schema.fields[fieldName] = fieldDef;
      }
    }

    // Apply overrides: modify existing field constraints, sorted by priority (lower first, higher wins)
    const sortedOverrides = [...schemaOverrides].sort((a, b) => a.priority - b.priority);
    for (const entry of sortedOverrides) {
      const schema = schemaMap.get(entry.target);
      if (!schema) continue;

      for (const [fieldName, constraints] of Object.entries(entry.override.fields)) {
        const existingField = schema.fields[fieldName];
        if (!existingField) continue;

        // Deep merge constraints into the existing field definition
        schema.fields[fieldName] = deepMergeField(existingField, constraints);
      }
    }

    return Array.from(schemaMap.values());
  }

  // ── Action resolution ──────────────────────────────────

  function resolveActions(actions: ActionDefinition[]): ActionDefinition[] {
    const actionMap = new Map<string, ActionDefinition>();
    for (const a of actions) {
      actionMap.set(a.name, { ...a });
    }

    // Group overrides by target action
    const overridesByAction = new Map<string, ActionOverrideEntry[]>();
    for (const entry of actionOverrides) {
      const list = overridesByAction.get(entry.target) ?? [];
      list.push(entry);
      overridesByAction.set(entry.target, list);
    }

    for (const [actionName, overrides] of overridesByAction) {
      const action = actionMap.get(actionName);
      if (!action) continue;

      // Multiple full replacements of the same action are a fatal error (spec 01)
      const fullReplacements = overrides.filter((o) => o.override.handler != null);
      if (fullReplacements.length > 1) {
        const sources = fullReplacements.map((o) => o.source);
        throw new Error(
          `Action "${actionName}" has conflicting full handler replacements from multiple sources: ${sources.join(", ")}. Only one capability may fully replace an action.`,
        );
      }

      // Merge policy overrides (all of them, higher priority last so it wins)
      const sortedOverrides = [...overrides].sort((a, b) => a.priority - b.priority);
      for (const entry of sortedOverrides) {
        if (entry.override.policy) {
          action.policy = { ...action.policy, ...entry.override.policy };
        }
      }

      // Build the action handler chain (onion model)
      const originalHandler = action.handler;
      if (
        originalHandler ||
        sortedOverrides.some((o) => o.override.handler || o.override.before || o.override.after)
      ) {
        action.handler = buildActionChain(originalHandler, sortedOverrides);
      }

      actionMap.set(actionName, action);
    }

    return Array.from(actionMap.values());
  }

  // ── Rule resolution ────────────────────────────────────

  function resolveRules(rules: RuleDefinition[]): RuleDefinition[] {
    const ruleMap = new Map<string, RuleDefinition>();
    for (const r of rules) {
      ruleMap.set(r.name, { ...r });
    }

    // Group overrides by target rule
    const overridesByRule = new Map<string, RuleOverrideEntry[]>();
    for (const entry of ruleOverrides) {
      const list = overridesByRule.get(entry.target) ?? [];
      list.push(entry);
      overridesByRule.set(entry.target, list);
    }

    for (const [ruleName, overrides] of overridesByRule) {
      const rule = ruleMap.get(ruleName);
      if (!rule) continue;

      // Sort by priority — higher priority wins (applied last)
      const sorted = [...overrides].sort((a, b) => a.priority - b.priority);

      if (sorted.length > 1) {
        conflicts.push({
          type: "rule_override",
          target: ruleName,
          sources: sorted.map((o) => o.source),
          message: `Rule "${ruleName}" overridden by multiple sources: ${sorted.map((o) => o.source).join(", ")}. Highest priority wins.`,
        });
      }

      for (const entry of sorted) {
        if (entry.override.condition !== undefined) {
          rule.condition = entry.override.condition;
        }
        if (entry.override.effect !== undefined) {
          rule.effect = entry.override.effect;
        }
        if (entry.override.trigger !== undefined) {
          rule.trigger = entry.override.trigger;
        }
        if (entry.override.priority !== undefined) {
          rule.priority = entry.override.priority;
        }
      }

      ruleMap.set(ruleName, rule);
    }

    return Array.from(ruleMap.values());
  }

  function getConflicts(): ResolutionConflict[] {
    return [...conflicts];
  }

  return {
    addEntityExtension,
    addEntityOverride,
    addActionOverride,
    addRuleOverride,
    resolveSchemas,
    resolveActions,
    resolveRules,
    getConflicts,
  };
}

// ── Action chain builder (onion model) ─────────────────────

/**
 * Build an action handler chain using the onion model.
 *
 * Overrides are sorted by priority ascending (lower = inner, higher = outer).
 * For before hooks: outer before runs first, then inner before, then original.
 * For after hooks: inner after runs first, then outer after.
 *
 * Execution order for priorities [10, 20]:
 *   B.before (priority 20) → A.before (priority 10) → original → A.after (priority 10) → B.after (priority 20)
 *
 * Wait — the spec says: B.before (priority 20) → A.before (priority 10) → original → A.after → B.after
 * This means higher priority = outer layer. So we sort ascending by priority
 * and wrap from inside out: original → wrap with priority 10 → wrap with priority 20.
 */
export function buildActionChain(
  originalHandler: ((ctx: ActionContext) => Promise<unknown>) | undefined,
  overrides: Array<{ override: ActionOverride; priority: number }>,
): (ctx: ActionContext) => Promise<unknown> {
  // Sort ascending: lower priority = inner layer (closer to original)
  const sorted = [...overrides].sort((a, b) => a.priority - b.priority);

  // Start with the original handler (or a noop if no original)
  let current: (ctx: ActionContext) => Promise<unknown> =
    originalHandler ?? (async () => undefined);

  // Wrap from inside out
  for (const entry of sorted) {
    const { override } = entry;
    const inner = current;

    if (override.handler) {
      // Full replacement — the override's handler replaces the inner chain.
      // Provide callOriginal on the context so the replacement can optionally call through.
      const replacementHandler = override.handler;
      current = async (ctx: ActionContext) => {
        // Attach callOriginal to the context for the replacement handler to use
        const extendedCtx = Object.create(ctx) as ActionContext & {
          callOriginal: () => Promise<unknown>;
        };
        extendedCtx.callOriginal = () => inner(ctx);
        return replacementHandler(extendedCtx);
      };
    } else {
      // Before/after hooks wrapping the inner handler
      const beforeHook = override.before;
      const afterHook = override.after;
      current = async (ctx: ActionContext) => {
        if (beforeHook) await beforeHook(ctx);
        const result = await inner(ctx);
        if (afterHook) await afterHook(ctx);
        return result;
      };
    }
  }

  return current;
}

// ── Deep merge utility ─────────────────────────────────────

/**
 * Deep-merge partial field constraints into an existing FieldDefinition.
 * Returns a new FieldDefinition with the constraints applied.
 */
function deepMergeField(
  field: FieldDefinition,
  constraints: Partial<FieldConstraints>,
): FieldDefinition {
  const merged = { ...field } as Record<string, unknown>;
  for (const [key, value] of Object.entries(constraints)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged as unknown as FieldDefinition;
}
