/**
 * Validation Engine
 *
 * Validates proposal changes before they can be approved and committed.
 * Phase 1 (Static checks) is implemented for M1:
 *   - Entity validity (required fields, valid types, ref targets exist)
 *   - Action validity (schema exists, state transitions valid)
 *   - Rule validity (trigger references exist, condition structure valid)
 *   - State Machine validity (initial state exists, all states reachable, no dead ends)
 *   - Naming convention checks (no duplicates, valid format)
 */

import type { EntityRegistry } from "../entity/entity-registry";
import type { OntologyRegistry } from "../ontology/ontology-registry";
import type { ActionDefinition } from "../types/action";
import type { EntityDefinition, FieldType } from "../types/entity";
import type {
  ChangeDefinition,
  PhaseResult,
  ProposalChange,
  ProposalDefinition,
  ProposalValidationResult,
  ValidationError,
  ValidationWarning,
} from "../types/proposal";
import type { RuleDefinition } from "../types/rule";
import type { StateDefinition } from "../types/state";
import { validatePhase2 } from "./validation-phase2";
import { validatePhase3 } from "./validation-phase3";
import { validatePhase4 } from "./validation-phase4";
import { validatePhase5 } from "./validation-phase5";

// ── Valid field types ────────────────────────────────────
// Relationships are now declared via defineRelation(), not field types

const VALID_FIELD_TYPES = new Set<FieldType>([
  "string",
  "text",
  "number",
  "boolean",
  "date",
  "datetime",
  "enum",
  "json",
  "state",
  "computed",
]);

// ── Name format regex ────────────────────────────────────

const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

// ── Validation context ───────────────────────────────────

export interface ValidationContext {
  /** Existing schema registry (to check ref targets, etc.) */
  entityRegistry?: EntityRegistry;
  /** Existing action names (for duplicate/reference checks) */
  existingActions?: string[];
  /** Existing state machine names */
  existingStates?: string[];
  /** Existing event names */
  existingEvents?: string[];
  /**
   * Read-only semantic view of the CURRENT (pre-change) meta-model. Used by
   * Phase 3 (compatibility) to detect breaking references. When absent, Phase 3
   * degrades to "skipped" (no findings) — existing callers stay unchanged.
   */
  ontology?: OntologyRegistry;
  /**
   * Escalate Phase 3 breaking-reference findings from WARN to BLOCK. Default
   * (false / undefined) → Phase 3 is warn-only and does NOT affect `passed`.
   * Mirrors the `strictValidation` env-feature pattern.
   */
  strictCompatibility?: boolean;
  /**
   * Escalate Phase 2 (build/syntax) findings on AI-materialized `generatedSource`
   * from WARN to BLOCK. Default (false / undefined) → Phase 2 is warn-only and
   * does NOT affect `passed`. When no change carries generated source, Phase 2 is
   * skipped regardless. Mirrors the `strictCompatibility` pattern.
   */
  strictGeneratedBuild?: boolean;
  /**
   * Escalate Phase 4 (generated-source contract) findings from WARN to BLOCK.
   * Default (false / undefined) → Phase 4 is warn-only and does NOT affect
   * `passed`. The checks are heuristic (execution-free static checks that the AI
   * generated the declared `define*()` target/name), so warn-only is the safe
   * default. When no change carries generated source, Phase 4 is skipped.
   */
  strictGeneratedContract?: boolean;
  /**
   * Escalate Phase 5 (execution dry-run) findings from WARN to BLOCK. Default
   * (false/undefined) → Phase 5 is warn-only. Unlike `strictGeneratedContract`
   * this is NOT auto-derived from `isProduction` (Spec 70 §7) — it depends on
   * configured sandbox infra. An `infra_error` dry-run status NEVER blocks, even
   * when this is true.
   */
  strictExecutionDryRun?: boolean;
}

// ── Phase 1: Static checks ──────────────────────────────

/**
 * Run Phase 1 (static) validation on a proposal's changes.
 * Returns a PhaseResult with errors and warnings.
 */
export function validatePhase1(options: {
  changes: ProposalChange[];
  context?: ValidationContext;
}): PhaseResult {
  const { changes, context } = options;
  const start = Date.now();
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  // Collect all names from the proposal for cross-reference checks
  const proposedSchemas = new Set<string>();
  const proposedActions = new Set<string>();
  const proposedStates = new Set<string>();
  const proposedEvents = new Set<string>();

  for (const change of changes) {
    if (change.operation === "delete") continue;
    switch (change.target) {
      case "entity":
        proposedSchemas.add(change.name);
        break;
      case "action":
        proposedActions.add(change.name);
        break;
      case "state":
        proposedStates.add(change.name);
        break;
      case "event":
        proposedEvents.add(change.name);
        break;
    }
  }

  // Helper to check if a schema exists (in registry or proposed)
  const schemaExists = (name: string): boolean => {
    if (proposedSchemas.has(name)) return true;
    if (context?.entityRegistry?.has(name)) return true;
    return false;
  };

  // Helper to check if an action exists
  const actionExists = (name: string): boolean => {
    if (proposedActions.has(name)) return true;
    if (context?.existingActions?.includes(name)) return true;
    return false;
  };

  // Helper to check if an event exists
  const eventExists = (name: string): boolean => {
    if (proposedEvents.has(name)) return true;
    if (context?.existingEvents?.includes(name)) return true;
    return false;
  };

  // Check for duplicate name+target combinations
  const seen = new Map<string, number>();
  for (const change of changes) {
    if (change.operation === "delete") continue;
    const key = `${change.target}:${change.name}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  for (const [key, count] of seen) {
    if (count > 1) {
      const [target, name] = key.split(":");
      errors.push({
        code: "DUPLICATE_CHANGE",
        message: `Duplicate change: ${target} '${name}' appears multiple times`,
        target: name,
      });
    }
  }

  for (const change of changes) {
    // Validate naming convention
    if (!NAME_PATTERN.test(change.name)) {
      errors.push({
        code: "INVALID_NAME",
        message: `Name "${change.name}" must be lowercase alphanumeric with underscores, starting with a letter`,
        target: change.name,
      });
    }

    if (change.operation === "delete") continue;
    // A `target:"revert"` change (Spec 55 §7.7 rollback loop) intentionally
    // carries no `definition` — it only names the proposal to roll back via its
    // `diff`/evidence sidecar; the rollback is executed by a separate
    // human-approved deploy step. Skip the MISSING_DEFINITION requirement (and
    // the target-specific definition validation below) just as we skip deletes,
    // so a governance-safe draft rollback Proposal can reach the approval gate.
    if (change.target === "revert") continue;
    // A change carrying a `sourcePatch` (#566 "say→change an existing
    // code-condition rule's threshold") intentionally has NO `definition`: it
    // rewrites a single named constant in existing source, so the sourcePatch IS
    // the specification (value-validated at assembly via `isSafeValueLiteral`,
    // and the patcher re-validates at graduation). Skip the MISSING_DEFINITION
    // requirement — like revert/delete — so the governed draft can reach the
    // approval gate and graduate. Without this, every NL rule-threshold update
    // fails Phase 1 and is unapprovable. Still validate the patch's OWN shape
    // here so a malformed sourcePatch is caught early at Phase 1 rather than
    // failing opaquely during graduation.
    // Scope the carve-out to exactly the production case it exists for — a
    // `rule` `update` (the NL threshold change). `sourcePatch` is an optional
    // field on the BASE ProposalChange, so a crafted `entity`/`action` change
    // carrying a sourcePatch must NOT get the definition-less pass; it falls
    // through to MISSING_DEFINITION like any other definition-less change.
    if (change.sourcePatch && change.target === "rule" && change.operation === "update") {
      const { filePath, constantName, newValueLiteral } = change.sourcePatch;
      if (!filePath || !constantName || !newValueLiteral) {
        errors.push({
          code: "INVALID_SOURCE_PATCH",
          message: `Change for "${change.name}" has an invalid or incomplete sourcePatch specification`,
          target: change.name,
        });
      }
      // A definition-LESS sourcePatch change is self-specifying: skip the
      // MISSING_DEFINITION requirement AND the target-specific definition
      // validation below. But if a `definition` is ALSO present (permitted by
      // the ProposalChange type, though not produced today), fall through so
      // validateRule()/validateEntity()/… still runs and catches the
      // inconsistency rather than silently accepting a malformed definition.
      if (!change.definition) continue;
    }
    if (!change.definition) {
      errors.push({
        code: "MISSING_DEFINITION",
        message: `Change for "${change.name}" (${change.operation}) is missing a definition`,
        target: change.name,
      });
      continue;
    }

    switch (change.target) {
      case "entity":
        validateEntity(change.definition as EntityDefinition, change.name, errors, warnings, {
          schemaExists,
        });
        break;
      case "action":
        validateAction(change.definition as ActionDefinition, change.name, errors, warnings, {
          schemaExists,
          actionExists,
          resolveStateMachine: (entityName: string) =>
            resolveStateMachine(entityName, changes, context),
        });
        break;
      case "rule":
        validateRule(change.definition as RuleDefinition, change.name, errors, warnings, {
          actionExists,
          eventExists,
        });
        break;
      case "state":
        validateStateDef(change.definition as StateDefinition, change.name, errors, warnings, {
          schemaExists,
        });
        break;
      case "event":
        // Events are lightweight — just check name and category
        validateEventDef(change.definition, change.name, errors);
        break;
      case "view":
        // View validation is basic — check schema reference
        validateViewDef(change.definition, change.name, errors, { schemaExists });
        break;
    }
  }

  const passed = errors.length === 0;
  return {
    phase: 1,
    status: passed ? "passed" : "failed",
    errors,
    warnings,
    duration: Date.now() - start,
  };
}

// ── State machine resolution helper ──────────────────────

/**
 * Resolve the state machine for a given schema by looking at proposal changes
 * and/or the schema registry context.
 * Returns the set of valid states, or undefined if no state machine is found.
 */
function resolveStateMachine(
  entityName: string,
  changes: ProposalChange[],
  _context?: ValidationContext,
): Set<string> | undefined {
  // Look through proposal changes for a state definition referencing this schema
  for (const change of changes) {
    if (change.target === "state" && change.operation !== "delete" && change.definition) {
      const stateDef = change.definition as StateDefinition;
      if (stateDef.entity === entityName && stateDef.states) {
        return new Set(stateDef.states);
      }
    }
  }

  // Look through schema registry for state definitions (if available)
  // The registry doesn't store state machines directly, so we only check proposal changes for now.
  return undefined;
}

// ── Schema validation ────────────────────────────────────

function validateEntity(
  def: EntityDefinition,
  name: string,
  errors: ValidationError[],
  _warnings: ValidationWarning[],
  _helpers: { schemaExists: (name: string) => boolean },
): void {
  if (!def.fields || Object.keys(def.fields).length === 0) {
    errors.push({
      code: "ENTITY_NO_FIELDS",
      message: `Entity "${name}" must have at least one field`,
      target: name,
    });
    return;
  }

  for (const [fieldName, field] of Object.entries(def.fields)) {
    // Check field type is valid
    if (!VALID_FIELD_TYPES.has(field.type)) {
      errors.push({
        code: "INVALID_FIELD_TYPE",
        message: `Field "${fieldName}" on schema "${name}" has invalid type "${field.type}"`,
        target: name,
        field: fieldName,
      });
    }

    // Check enum fields have options
    if (field.type === "enum") {
      const enumField = field as { options?: unknown[] };
      if (!enumField.options || enumField.options.length === 0) {
        errors.push({
          code: "ENUM_NO_OPTIONS",
          message: `Enum field "${fieldName}" on schema "${name}" must have at least one option`,
          target: name,
          field: fieldName,
        });
      }
    }

    // Check state fields have machine reference
    if (field.type === "state") {
      const stateField = field as { machine?: string };
      if (!stateField.machine) {
        errors.push({
          code: "STATE_NO_MACHINE",
          message: `State field "${fieldName}" on schema "${name}" must reference a state machine`,
          target: name,
          field: fieldName,
        });
      }
    }

    // Required field without a default will fail at record creation time — this is an error
    const isVirtual = field.type === "computed";
    if (field.required && field.default === undefined && !isVirtual) {
      errors.push({
        code: "REQUIRED_NO_DEFAULT",
        message: `Field "${fieldName}" on schema "${name}" is required but has no default value`,
        target: name,
        field: fieldName,
      });
    }
  }
}

// ── Action validation ────────────────────────────────────

function validateAction(
  def: ActionDefinition,
  name: string,
  errors: ValidationError[],
  warnings: ValidationWarning[],
  helpers: {
    schemaExists: (name: string) => boolean;
    actionExists: (name: string) => boolean;
    resolveStateMachine: (entityName: string) => Set<string> | undefined;
  },
): void {
  // Check entity reference
  if (!def.entity) {
    errors.push({
      code: "ACTION_NO_ENTITY",
      message: `Action "${name}" must reference an entity`,
      target: name,
    });
  } else if (!helpers.schemaExists(def.entity)) {
    warnings.push({
      code: "ACTION_UNKNOWN_ENTITY",
      message: `Action "${name}" references unknown entity "${def.entity}"`,
      target: name,
    });
  }

  // Check state transition validity
  if (def.stateTransition) {
    const { from, to } = def.stateTransition;
    if (!from) {
      errors.push({
        code: "TRANSITION_NO_FROM",
        message: `Action "${name}" state transition is missing "from" state(s)`,
        target: name,
      });
    }
    if (!to) {
      errors.push({
        code: "TRANSITION_NO_TO",
        message: `Action "${name}" state transition is missing "to" state`,
        target: name,
      });
    }

    // Validate from/to states against the state machine for the action's entity
    if (def.entity && from && to) {
      const validStates = helpers.resolveStateMachine(def.entity);
      if (validStates) {
        const fromStates = Array.isArray(from) ? from : [from];
        for (const s of fromStates) {
          if (!validStates.has(s)) {
            errors.push({
              code: "TRANSITION_INVALID_STATE",
              message: `State '${s}' not found in state machine for entity '${def.entity}'`,
              target: name,
            });
          }
        }
        if (!validStates.has(to)) {
          errors.push({
            code: "TRANSITION_INVALID_STATE",
            message: `State '${to}' not found in state machine for entity '${def.entity}'`,
            target: name,
          });
        }
      }
    }
  }

  // Check policy is present
  if (!def.policy) {
    errors.push({
      code: "ACTION_NO_POLICY",
      message: `Action "${name}" must have an execution policy`,
      target: name,
    });
  }

  // Check label is present
  if (!def.label) {
    warnings.push({
      code: "ACTION_NO_LABEL",
      message: `Action "${name}" is missing a label`,
      target: name,
    });
  }

  // Warn if no handler
  if (!def.handler) {
    warnings.push({
      code: "ACTION_NO_HANDLER",
      message: `Action "${name}" has no handler defined`,
      target: name,
    });
  }
}

// ── Rule validation ──────────────────────────────────────

function validateRule(
  def: RuleDefinition,
  name: string,
  errors: ValidationError[],
  warnings: ValidationWarning[],
  helpers: {
    actionExists: (name: string) => boolean;
    eventExists: (name: string) => boolean;
  },
): void {
  // Check trigger references
  if (!def.trigger) {
    errors.push({
      code: "RULE_NO_TRIGGER",
      message: `Rule "${name}" must have a trigger`,
      target: name,
    });
  } else {
    // Check action trigger references
    if ("action" in def.trigger) {
      const actions = Array.isArray(def.trigger.action) ? def.trigger.action : [def.trigger.action];
      for (const actionName of actions) {
        if (!helpers.actionExists(actionName)) {
          warnings.push({
            code: "RULE_UNKNOWN_ACTION",
            message: `Rule "${name}" trigger references unknown action "${actionName}"`,
            target: name,
          });
        }
      }
    }

    // Check event trigger references
    if ("event" in def.trigger) {
      const eventName = (def.trigger as { event: string }).event;
      if (!helpers.eventExists(eventName)) {
        warnings.push({
          code: "RULE_UNKNOWN_EVENT",
          message: `Rule "${name}" trigger references unknown event "${eventName}"`,
          target: name,
        });
      }
    }
  }

  // Check condition exists
  if (!def.condition) {
    errors.push({
      code: "RULE_NO_CONDITION",
      message: `Rule "${name}" must have a condition`,
      target: name,
    });
  }

  // Check effect exists
  if (!def.effect) {
    errors.push({
      code: "RULE_NO_EFFECT",
      message: `Rule "${name}" must have an effect`,
      target: name,
    });
  }
}

// ── State definition validation ──────────────────────────

function validateStateDef(
  def: StateDefinition,
  name: string,
  errors: ValidationError[],
  warnings: ValidationWarning[],
  helpers: { schemaExists: (name: string) => boolean },
): void {
  if (!def.states || def.states.length === 0) {
    errors.push({
      code: "STATE_NO_STATES",
      message: `State definition "${name}" must have at least one state`,
      target: name,
    });
    return;
  }

  // Check initial state
  if (!def.initial) {
    errors.push({
      code: "STATE_NO_INITIAL",
      message: `State definition "${name}" must have an initial state`,
      target: name,
    });
  } else if (!def.states.includes(def.initial)) {
    errors.push({
      code: "STATE_INVALID_INITIAL",
      message: `Initial state "${def.initial}" is not in the states list of "${name}"`,
      target: name,
    });
  }

  // Check entity reference
  if (!def.entity) {
    errors.push({
      code: "STATE_NO_ENTITY",
      message: `State definition "${name}" must reference an entity`,
      target: name,
    });
  } else if (!helpers.schemaExists(def.entity)) {
    warnings.push({
      code: "STATE_UNKNOWN_ENTITY",
      message: `State definition "${name}" references unknown entity "${def.entity}"`,
      target: name,
    });
  }

  // Check transitions reference valid states
  const stateSet = new Set(def.states);
  for (const t of def.transitions ?? []) {
    const sources = Array.isArray(t.from) ? t.from : [t.from];
    for (const src of sources) {
      if (!stateSet.has(src)) {
        errors.push({
          code: "STATE_INVALID_TRANSITION_FROM",
          message: `Transition "${t.action}" in "${name}" references unknown source state "${src}"`,
          target: name,
        });
      }
    }
    if (!stateSet.has(t.to)) {
      errors.push({
        code: "STATE_INVALID_TRANSITION_TO",
        message: `Transition "${t.action}" in "${name}" references unknown target state "${t.to}"`,
        target: name,
      });
    }
  }

  // Check for unreachable states (states that are not initial and have no incoming transitions)
  if (def.transitions && def.transitions.length > 0) {
    const reachable = new Set<string>([def.initial]);
    // BFS from initial state
    const queue = [def.initial];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      for (const t of def.transitions) {
        const sources = Array.isArray(t.from) ? t.from : [t.from];
        if (sources.includes(current) && !reachable.has(t.to)) {
          reachable.add(t.to);
          queue.push(t.to);
        }
      }
    }
    for (const state of def.states) {
      if (!reachable.has(state)) {
        warnings.push({
          code: "STATE_UNREACHABLE",
          message: `State "${state}" in "${name}" is unreachable from the initial state`,
          target: name,
        });
      }
    }

    // Check for dead-end states: reachable states with incoming transitions but no outgoing transitions.
    // These are potential dead ends (states you can enter but never leave).
    const hasOutgoing = new Set<string>();
    const hasIncoming = new Set<string>();
    for (const t of def.transitions) {
      const sources = Array.isArray(t.from) ? t.from : [t.from];
      for (const src of sources) {
        hasOutgoing.add(src);
      }
      hasIncoming.add(t.to);
    }
    for (const state of def.states) {
      if (hasIncoming.has(state) && !hasOutgoing.has(state) && reachable.has(state)) {
        warnings.push({
          code: "STATE_DEAD_END",
          message: `State "${state}" in "${name}" has incoming transitions but no outgoing transitions (potential dead-end)`,
          target: name,
        });
      }
    }
  }
}

// ── Event definition validation ──────────────────────────

function validateEventDef(def: ChangeDefinition, name: string, errors: ValidationError[]): void {
  const eventDef = def as { name?: string; category?: string };
  if (!eventDef.name) {
    errors.push({
      code: "EVENT_NO_NAME",
      message: `Event definition "${name}" must have a name`,
      target: name,
    });
  }
}

// ── View definition validation ───────────────────────────

function validateViewDef(
  def: ChangeDefinition,
  name: string,
  errors: ValidationError[],
  helpers: { schemaExists: (name: string) => boolean },
): void {
  const viewDef = def as { entity?: string; type?: string; fields?: unknown[] };
  if (!viewDef.entity) {
    errors.push({
      code: "VIEW_NO_ENTITY",
      message: `View "${name}" must reference an entity`,
      target: name,
    });
  } else if (!helpers.schemaExists(viewDef.entity)) {
    errors.push({
      code: "VIEW_UNKNOWN_ENTITY",
      message: `View "${name}" references unknown entity "${viewDef.entity}"`,
      target: name,
    });
  }
}

// ── Full proposal validation ─────────────────────────────

/**
 * Validate a full proposal. Currently only runs Phase 1 (static checks).
 * Phase 2-4 will be added in later milestones.
 */
export function validateProposal(options: {
  proposal: ProposalDefinition;
  context?: ValidationContext;
}): ProposalValidationResult {
  const { proposal, context } = options;

  // Phase 1: Static checks
  const phase1 = validatePhase1({ changes: proposal.changes, context });

  // Phase 2: Build (syntax) check of any AI-materialized `generatedSource` on the
  // changes (G5). Warn-only by default; gated to BLOCK via strictGeneratedBuild.
  // When no change carries generated source, validatePhase2 returns "skipped" —
  // existing all-declarative callers are unaffected.
  const phase2 = validatePhase2({
    changes: proposal.changes,
    strictGeneratedBuild: context?.strictGeneratedBuild,
  });

  // Phase 3: Compatibility (breaking-reference) check (Spec 09 §4.5).
  // Warn-only by default; gated to BLOCK via context.strictCompatibility. When
  // the context carries no ontology, validatePhase3 returns "skipped" — same
  // behavior as before this phase existed, so existing callers are unaffected.
  const phase3 = validatePhase3({
    changes: proposal.changes,
    ontology: context?.ontology,
    strictCompatibility: context?.strictCompatibility,
  });

  // Phase 4: Generated-source CONTRACT check (G5) — static, EXECUTION-FREE
  // verification that any AI-materialized `generatedSource` actually defines the
  // declared target/name (right define*() call, references its name, imports
  // core). Warn-only by default; gated to BLOCK via strictGeneratedContract. No
  // generated source → "skipped". A true execution-based dry-run is intentionally
  // out of scope (it would require a sandbox to run untrusted AI code).
  const phase4 = validatePhase4({
    changes: proposal.changes,
    strictGeneratedContract: context?.strictGeneratedContract,
  });

  // Phase 5: Execution dry-run SIGNAL (Spec 70 P2) — reads the DURABLE
  // `dryRunStatus` a sandbox runner stamps on a change (the actual sandboxed
  // execution runs LATER in a capability, P3, never here). A failing dry-run
  // (threw/timeout/oom/forbidden_side_effect/malformed_output) becomes a content
  // finding; `infra_error` is always a non-blocking warning. Warn-only by
  // default; gated to BLOCK via strictExecutionDryRun (opt-in, NOT derived from
  // isProduction). No change carries a `dryRunStatus` → "skipped". Stays SYNC —
  // it executes nothing.
  const phase5 = validatePhase5({
    changes: proposal.changes,
    strictExecutionDryRun: context?.strictExecutionDryRun,
  });

  const phases = [phase1, phase2, phase3, phase4, phase5];
  const passed = phases.filter((p) => p.status !== "skipped").every((p) => p.status === "passed");

  // Generate impact summary
  const affectedTypes = new Set(proposal.changes.map((c) => c.target));
  const operations = new Set(proposal.changes.map((c) => c.operation));
  const impactSummary = `${proposal.changes.length} change(s) affecting ${[...affectedTypes].join(", ")}. Operations: ${[...operations].join(", ")}.`;

  return {
    passed,
    phases,
    impactSummary,
  };
}
