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
  type BatchReplayResult,
  createEventReplayService,
  type EventDetail,
  type EventListOptions,
  type EventReplayService,
  type EventReplayServiceOptions,
  type EventSummary,
  type HandlerExecution,
  type HandlerHistoryQuery,
  type ReplayError,
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
