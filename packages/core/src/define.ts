/**
 * defineXxx functions — Declarative definition entry points
 *
 * These functions currently only provide type annotations with no runtime logic.
 * Registration, validation, and other behaviors will be added when engines are implemented.
 */

import type { ActionDefinition } from "./types/action";
import type { CapabilityDefinition } from "./types/capability";
import type { EventDefinition, EventHandlerDefinition } from "./types/event";
import type { RuleDefinition } from "./types/rule";
import type { FieldDefinition, SchemaDefinition, SchemaExtension, SchemaOverride } from "./types/schema";
import type { StateDefinition, StateExtension } from "./types/state";
import type { ViewDefinition, ViewExtension } from "./types/view";
import type { ActionOverride } from "./types/action";
import type { RuleOverride } from "./types/rule";

// ── Schema ──────────────────────────────────────────

export function defineSchema<TFields extends Record<string, FieldDefinition>>(
  definition: SchemaDefinition<TFields>,
): SchemaDefinition<TFields> {
  return definition;
}

export function extendSchema(target: string, extension: SchemaExtension): { target: string; extension: SchemaExtension } {
  return { target, extension };
}

export function overrideSchema(target: string, override: SchemaOverride): { target: string; override: SchemaOverride } {
  return { target, override };
}

// ── Action ──────────────────────────────────────────

export function defineAction(definition: ActionDefinition): ActionDefinition {
  return definition;
}

export function overrideAction(target: string, override: ActionOverride): { target: string; override: ActionOverride } {
  return { target, override };
}

// ── Rule ────────────────────────────────────────────

export function defineRule(definition: RuleDefinition): RuleDefinition {
  return definition;
}

export function overrideRule(target: string, override: RuleOverride): { target: string; override: RuleOverride } {
  return { target, override };
}

export function disableRule(name: string): { name: string; disabled: true } {
  return { name, disabled: true };
}

// ── State ───────────────────────────────────────────

export function defineState<TStates extends string>(
  definition: StateDefinition<TStates>,
): StateDefinition<TStates> {
  return definition;
}

export function extendState(target: string, extension: StateExtension): { target: string; extension: StateExtension } {
  return { target, extension };
}

// ── Event ───────────────────────────────────────────

export function defineEvent(definition: EventDefinition): EventDefinition {
  return definition;
}

export function defineEventHandler(definition: EventHandlerDefinition): EventHandlerDefinition {
  return definition;
}

// ── View ────────────────────────────────────────────

export function defineView(definition: ViewDefinition): ViewDefinition {
  return definition;
}

export function extendView(target: string, extension: ViewExtension): { target: string; extension: ViewExtension } {
  return { target, extension };
}

// ── Capability ──────────────────────────────────────

export function defineCapability(definition: CapabilityDefinition): CapabilityDefinition {
  return definition;
}
