/**
 * Event module — public API
 */

export {
  createDlqService,
  type DlqEntry,
  type DlqListOptions,
  type DlqService,
  type DlqStats,
} from "./dlq-service";
export {
  createEventBus,
  EventBus,
  type EventBusOptions,
  EventHandlerRegistry,
  matchesFilter,
} from "./event-bus";
export {
  createEventReplayService,
  type EventReplayService,
  type ReplayedEventResult,
  type ReplayedHandlerInfo,
  type ReplayMeta,
  type ReplayOptions,
  type ReplayResult,
} from "./event-replay-service";
export {
  createOutboxWorker,
  type OutboxMetrics,
  type OutboxWorker,
  type OutboxWorkerOptions,
} from "./outbox-worker";
export {
  createPersistentEventBus,
  PersistentEventBus,
  type PersistentEventBusOptions,
} from "./persistent-event-bus";
