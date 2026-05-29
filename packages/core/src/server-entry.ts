/**
 * @linchkit/core/server — Server-only modules
 *
 * Runtime engines, database, Drizzle ORM, event bus, flow, observability, AI.
 * NOT safe for browser — requires Node/Bun runtime.
 *
 * Usage: import { createActionExecutor, EntityRegistry } from "@linchkit/core/server"
 *
 * The barrel is composed from focused sub-barrels under ./exports/server/*.
 * Each sub-barrel groups one domain (engines, persistence, AI, etc.) and stays
 * well below the 500-line file size limit so this entry never has to grow as
 * new engines and capabilities land.
 */

export * from "./exports/server/addon-discovery";
export * from "./exports/server/ai";
export * from "./exports/server/automation";
export * from "./exports/server/cache";
export * from "./exports/server/deployment";
export * from "./exports/server/doctor";
export * from "./exports/server/engines";
export * from "./exports/server/entity";
export * from "./exports/server/event";
export * from "./exports/server/flow";
export * from "./exports/server/life-system";
export * from "./exports/server/observability";
export * from "./exports/server/ontology";
export * from "./exports/server/persistence";
export * from "./exports/server/security";
