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
export { createEventBus, EventBus, EventHandlerRegistry, matchesFilter } from "./event-bus";
export {
  createOutboxWorker,
  type OutboxMetrics,
  type OutboxWorker,
  type OutboxWorkerOptions,
} from "./outbox-worker";
export { createPersistentEventBus, PersistentEventBus } from "./persistent-event-bus";
