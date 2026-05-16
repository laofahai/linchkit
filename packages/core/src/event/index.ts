/**
 * Event module — public API
 */

export {
  createEventBus,
  EventBus,
  type EventBusOptions,
  EventHandlerRegistry,
  matchesFilter,
} from "./event-bus";
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
