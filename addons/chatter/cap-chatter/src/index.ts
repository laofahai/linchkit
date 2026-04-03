/**
 * @linchkit/cap-chatter — public API
 */

export type { CapChatterOptions } from "./capability";
export { capChatter, createCapChatter } from "./capability";
export { createChatterAutoLog } from "./event-handler";
export { DrizzleChatterService, InMemoryChatterService } from "./service";
export { messagesTable } from "./tables";
export type {
  ChatterMessage,
  ChatterService,
  CreateMessageInput,
  MessageQueryOptions,
  MessageType,
  PaginatedMessages,
} from "./types";
