/**
 * Automation registry types (browser-safe).
 *
 * WatcherEngine concrete impl moved to @linchkit/cap-ai-provider
 * (Spec 56 Phase 2 Step 2c); core retains the abstract `Watcher` interface
 * (see `../../life-system/watcher.ts`) and the WatcherRegistry.
 *
 * The runtime registry factory lives in ../server/automation.ts.
 */

export type { WatcherRegistry } from "../../automation";
