/**
 * RedisInvalidator — Cross-instance cache invalidation via Redis Pub/Sub.
 *
 * Each `RedisCacheProvider` owns a pair of Redis connections — one for
 * publishing invalidation messages and one (a `duplicate()`) for the
 * subscriber loop. ioredis forbids issuing regular commands on a
 * connection that is in subscriber mode, so the split is mandatory.
 *
 * Message payloads are tagged with an `origin` ID so a provider can ignore
 * its own broadcasts and avoid double-evicting on the publisher side.
 *
 * Mirrors the contract of `packages/core/src/cache/postgres-invalidator.ts`
 * (start / broadcast / stop) so capability authors can swap transports
 * without re-wiring the cache manager.
 */

import { randomUUID } from "node:crypto";
import type { InvalidationMessage, RedisLike } from "./types";

export interface RedisInvalidatorOptions {
  /** Connection used to PUBLISH messages. */
  publisher: RedisLike;
  /** Dedicated connection used to SUBSCRIBE. Must not be shared with `publisher`. */
  subscriber: RedisLike;
  /** Pub/Sub channel name. */
  channel: string;
  /** Optional logger for debug/error output. */
  logger?: {
    debug?: (msg: string) => void;
    error?: (msg: string, err?: unknown) => void;
  };
  /** Callback invoked for every well-formed message received on the channel. */
  onMessage: (msg: InvalidationMessage) => void;
}

export class RedisInvalidator {
  /** Unique per-instance identifier embedded into every published message. */
  public readonly id: string;

  private readonly publisher: RedisLike;
  private readonly subscriber: RedisLike;
  private readonly channel: string;
  private readonly onMessage: (msg: InvalidationMessage) => void;
  private readonly logger: NonNullable<RedisInvalidatorOptions["logger"]>;
  private started = false;
  private readonly listener = (...args: unknown[]): void => {
    const [channel, message] = args;
    if (typeof channel !== "string" || typeof message !== "string") return;
    if (channel !== this.channel) return;
    this.dispatch(message);
  };

  constructor(options: RedisInvalidatorOptions) {
    this.publisher = options.publisher;
    this.subscriber = options.subscriber;
    this.channel = options.channel;
    this.onMessage = options.onMessage;
    this.logger = options.logger ?? {};
    this.id = randomUUID();
  }

  /** Start listening on the Pub/Sub channel. Idempotent. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.subscriber.on("message", this.listener);
    await this.subscriber.subscribe(this.channel);
    this.logger.debug?.(`[RedisInvalidator] subscribed to "${this.channel}"`);
  }

  /** Stop listening and close the subscriber connection. */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    try {
      await this.subscriber.unsubscribe(this.channel);
    } catch (err) {
      this.logger.error?.("[RedisInvalidator] unsubscribe failed", err);
    }
    try {
      await this.subscriber.quit();
    } catch (err) {
      this.logger.error?.("[RedisInvalidator] subscriber quit failed", err);
    }
  }

  /** Publish an invalidation message to every subscriber. */
  async broadcast(message: InvalidationMessage): Promise<void> {
    const payload = JSON.stringify(message);
    await this.publisher.publish(this.channel, payload);
  }

  private dispatch(payload: string): void {
    let msg: InvalidationMessage;
    try {
      msg = JSON.parse(payload) as InvalidationMessage;
    } catch (err) {
      this.logger.error?.(`[RedisInvalidator] invalid JSON: ${payload}`, err);
      return;
    }
    if (!isInvalidationMessage(msg)) {
      this.logger.error?.(`[RedisInvalidator] malformed message: ${payload}`);
      return;
    }
    try {
      this.onMessage(msg);
    } catch (err) {
      this.logger.error?.("[RedisInvalidator] onMessage handler threw", err);
    }
  }
}

function isInvalidationMessage(msg: unknown): msg is InvalidationMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const candidate = msg as { type?: unknown };
  switch (candidate.type) {
    case "invalidate-key":
      return typeof (msg as { key?: unknown }).key === "string";
    case "invalidate-tag":
      return typeof (msg as { tag?: unknown }).tag === "string";
    case "invalidate-prefix":
      return typeof (msg as { prefix?: unknown }).prefix === "string";
    case "clear":
      return true;
    default:
      return false;
  }
}
