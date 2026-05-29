/**
 * @linchkit/core — Core runtime
 *
 * Browser-safe entry point: types, define functions, errors, config,
 * and pure-logic utilities (condition evaluator, Zod generator, translatable).
 *
 * For runtime engines, database, event bus, flow — use:
 *   import { ... } from "@linchkit/core/server"
 *
 * The barrel is composed from focused sub-barrels under ./exports/client/*.
 * Each sub-barrel groups one domain (engines, entity, life-system, etc.) and
 * stays well below the 500-line file size limit so this entry never has to
 * grow as new engines and capabilities land.
 */

export const VERSION = "0.0.1";

// Disambiguate names that exist in both ../types and other sub-barrels.
// Explicit re-exports take precedence over `export *` so the "real" symbol
// (the class / dedicated interface) wins, matching the pre-split behaviour.
// Keep all explicit overrides grouped here, NOT scattered through the file.
export type { ValidationResult } from "./capability";
export type { SlotName } from "./engine/command-layer";
export { ValidationError } from "./errors";
export * from "./exports/client/ai";
export * from "./exports/client/automation";
export * from "./exports/client/cache";
export * from "./exports/client/capability";
export * from "./exports/client/config";
export * from "./exports/client/define";
export * from "./exports/client/doctor";
export * from "./exports/client/engines";
export * from "./exports/client/entity";
export * from "./exports/client/errors";
export * from "./exports/client/event";
export * from "./exports/client/flow";
export * from "./exports/client/i18n";
export * from "./exports/client/life-system";
export * from "./exports/client/migration";
export * from "./exports/client/observability";
export * from "./exports/client/ontology";
export * from "./exports/client/runtime";
export * from "./exports/client/saga";
export * from "./exports/client/security";
export * from "./exports/client/types";
export * from "./exports/client/utils";
export * from "./exports/client/view";
export type { SignalBus } from "./life-system";
