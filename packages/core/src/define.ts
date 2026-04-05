/**
 * defineXxx functions — Declarative definition entry points
 *
 * These functions currently only provide type annotations with no runtime logic.
 * Registration, validation, and other behaviors will be added when engines are implemented.
 */

import type { ActionDefinition, ActionOverride } from "./types/action";
import type { AutomationDefinition } from "./types/automation";
import type { CapabilityDefinition } from "./types/capability";
import type { LinchKitConfig } from "./types/config";
import type {
  EntityDefinition,
  EntityExtension,
  EntityOverride,
  FieldDefinition,
  InterfaceDefinition,
} from "./types/entity";
import type { EventDefinition, EventHandlerDefinition } from "./types/event";
import type {
  DataAccessDefinition,
  PermissionGroupDefinition,
  PermissionGroupExtension,
} from "./types/permission";
import type { RelationDefinition } from "./types/relation";
import type { RuleDefinition, RuleOverride } from "./types/rule";
import type { StateDefinition, StateExtension } from "./types/state";
import type { ViewDefinition, ViewExtension } from "./types/view";
import type { WatcherDefinition } from "./types/watcher";

// ── Entity Interface ─────────────────────────────────

export function defineInterface(definition: InterfaceDefinition): InterfaceDefinition {
  return definition;
}

// ── Entity ──────────────────────────────────────────

export function defineEntity<TFields extends Record<string, FieldDefinition>>(
  definition: EntityDefinition<TFields>,
): EntityDefinition<TFields> {
  return definition;
}

export function extendEntity(
  target: string,
  extension: EntityExtension,
): { target: string; extension: EntityExtension } {
  return { target, extension };
}

export function overrideEntity(
  target: string,
  override: EntityOverride,
): { target: string; override: EntityOverride } {
  return { target, override };
}

// ── Action ──────────────────────────────────────────

export function defineAction(definition: ActionDefinition): ActionDefinition {
  return definition;
}

export function overrideAction(
  target: string,
  override: ActionOverride,
): { target: string; override: ActionOverride } {
  return { target, override };
}

// ── Rule ────────────────────────────────────────────

export function defineRule(definition: RuleDefinition): RuleDefinition {
  return definition;
}

export function overrideRule(
  target: string,
  override: RuleOverride,
): { target: string; override: RuleOverride } {
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

export function extendState(
  target: string,
  extension: StateExtension,
): { target: string; extension: StateExtension } {
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

export function extendView(
  target: string,
  extension: ViewExtension,
): { target: string; extension: ViewExtension } {
  return { target, extension };
}

// ── Permission ──────────────────────────────────────

export function definePermissionGroup(
  definition: PermissionGroupDefinition,
): PermissionGroupDefinition {
  return definition;
}

export function defineDataAccess(definition: DataAccessDefinition): DataAccessDefinition {
  return definition;
}

export function extendPermissionGroup(
  target: string,
  extension: PermissionGroupExtension,
): { target: string; extension: PermissionGroupExtension } {
  return { target, extension };
}

// ── Link ───────────────────────────────────────────

export function defineRelation(definition: RelationDefinition): RelationDefinition {
  return definition;
}

// ── Config ──────────────────────────────────────────

export function defineConfig(config: LinchKitConfig): LinchKitConfig {
  return config;
}

// ── Capability ──────────────────────────────────────

export function defineCapability(definition: CapabilityDefinition): CapabilityDefinition {
  return definition;
}

// ── Automation ───────────────────────────────────────

export function defineAutomation(
  definition: Omit<AutomationDefinition, "enabled"> & { enabled?: boolean },
): AutomationDefinition {
  return { enabled: true, ...definition };
}

// ── Watcher (data-condition triggered automation, spec 45) ──

export function defineWatcher(
  definition: Omit<WatcherDefinition, "enabled"> & { enabled?: boolean },
): WatcherDefinition {
  return { enabled: true, tenantScoped: true, ...definition };
}
