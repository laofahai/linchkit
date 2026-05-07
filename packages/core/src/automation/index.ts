// WatcherEngine concrete impl moved to @linchkit/cap-ai-provider
// (Spec 56 Phase 2 Step 2c). Core retains the abstract `Watcher` interface
// (see `../life-system/watcher.ts`) plus the WatcherRegistry — definition
// storage stays in core because it is consumed by the action pipeline.
export {
  createWatcherRegistry,
  type WatcherRegistry,
} from "./watcher-registry";
