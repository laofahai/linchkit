/**
 * Automation registry runtime (server).
 *
 * WatcherEngine concrete impl moved to @linchkit/cap-ai-provider
 * (Spec 56 Phase 2 Step 2c). The abstract `Watcher` lifecycle interface
 * lives in `../../life-system/watcher.ts`; the registry stays in core because
 * the action pipeline consumes WatcherDefinition records directly.
 */

export { createWatcherRegistry, type WatcherRegistry } from "../../automation";
