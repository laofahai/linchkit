/**
 * @linchkit/cap-chatter — public API
 */

export { capChatter, createCapChatter } from "./capability";
export type { CapChatterOptions } from "./capability";

export { InMemoryChatterService, DrizzleChatterService } from "./service";

export { createChatterAutoLog } from "./event-handler";

export type {
  ChatterMessage,
  ChatterService,
  CreateMessageInput,
  MessageQueryOptions,
  MessageType,
  PaginatedMessages,
} from "./types";

export { messagesTable } from "./tables";
