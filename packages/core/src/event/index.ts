/**
 * Event module — public API
 */

export { createEventBus, EventBus, EventHandlerRegistry, matchesFilter } from "./event-bus";
export { createOutboxWorker, type OutboxWorker, type OutboxWorkerOptions } from "./outbox-worker";
export { createPersistentEventBus, PersistentEventBus } from "./persistent-event-bus";
