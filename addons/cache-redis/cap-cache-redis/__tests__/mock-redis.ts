/**
 * Test-only in-memory Redis client mock.
 *
 * Implements the subset of the ioredis API exercised by RedisCacheProvider
 * and RedisInvalidator. Records every command so tests can assert that the
 * provider issues the right Redis traffic (GET, SET ... PX, DEL,
 * SADD tags:*, SUBSCRIBE, PUBLISH).
 *
 * Pub/Sub is implemented via a shared "broker" object that every duplicate
 * client receives — calling `publish` on one duplicate fans the message out
 * to every subscriber on the same channel, matching real ioredis semantics.
 */

import type { RedisLike } from "../src/types";

type Listener = (channel: string, message: string) => void;

interface Broker {
  channels: Map<string, Set<MockRedis>>;
  publish(channel: string, message: string): number;
}

function makeBroker(): Broker {
  return {
    channels: new Map(),
    publish(channel, message) {
      const subs = this.channels.get(channel);
      if (!subs) return 0;
      for (const sub of subs) sub._deliver(channel, message);
      return subs.size;
    },
  };
}

export interface RecordedCommand {
  name: string;
  args: unknown[];
}

export class MockRedis implements RedisLike {
  public readonly commands: RecordedCommand[] = [];
  public readonly store = new Map<string, string>();
  public readonly sets = new Map<string, Set<string>>();
  public readonly expiries = new Map<string, number>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly broker: Broker;
  private readonly subscriptions = new Set<string>();
  private closed = false;

  constructor(broker?: Broker) {
    this.broker = broker ?? makeBroker();
  }

  private record(name: string, args: unknown[]): void {
    this.commands.push({ name, args });
  }

  private isExpired(key: string): boolean {
    const expiry = this.expiries.get(key);
    if (expiry === undefined) return false;
    if (Date.now() > expiry) {
      this.store.delete(key);
      this.expiries.delete(key);
      return true;
    }
    return false;
  }

  async get(key: string): Promise<string | null> {
    this.record("GET", [key]);
    if (this.isExpired(key)) return null;
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string, ...args: Array<string | number>): Promise<unknown> {
    this.record("SET", [key, value, ...args]);
    this.store.set(key, value);
    // Parse trailing ttl option: ... "PX", number | "EX", number
    for (let i = 0; i < args.length; i++) {
      const token = args[i];
      const next = args[i + 1];
      if (typeof token === "string" && typeof next === "number") {
        const upper = token.toUpperCase();
        if (upper === "PX") {
          this.expiries.set(key, Date.now() + next);
        } else if (upper === "EX") {
          this.expiries.set(key, Date.now() + next * 1000);
        }
      }
    }
    return "OK";
  }

  async del(...keys: string[]): Promise<number> {
    this.record("DEL", keys);
    let count = 0;
    for (const key of keys) {
      if (this.store.delete(key)) count++;
      this.expiries.delete(key);
      if (this.sets.delete(key)) count++;
    }
    return count;
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    this.record("SADD", [key, ...members]);
    let set = this.sets.get(key);
    if (!set) {
      set = new Set();
      this.sets.set(key, set);
    }
    let added = 0;
    for (const member of members) {
      if (!set.has(member)) {
        set.add(member);
        added++;
      }
    }
    return added;
  }

  async smembers(key: string): Promise<string[]> {
    this.record("SMEMBERS", [key]);
    return Array.from(this.sets.get(key) ?? []);
  }

  async publish(channel: string, message: string): Promise<number> {
    this.record("PUBLISH", [channel, message]);
    return this.broker.publish(channel, message);
  }

  async subscribe(channel: string, ..._args: unknown[]): Promise<unknown> {
    this.record("SUBSCRIBE", [channel]);
    this.subscriptions.add(channel);
    let subs = this.broker.channels.get(channel);
    if (!subs) {
      subs = new Set();
      this.broker.channels.set(channel, subs);
    }
    subs.add(this);
    return 1;
  }

  async unsubscribe(...channels: string[]): Promise<unknown> {
    this.record("UNSUBSCRIBE", channels);
    for (const channel of channels) {
      this.subscriptions.delete(channel);
      this.broker.channels.get(channel)?.delete(this);
    }
    return 0;
  }

  async quit(): Promise<unknown> {
    this.record("QUIT", []);
    this.closed = true;
    for (const channel of this.subscriptions) {
      this.broker.channels.get(channel)?.delete(this);
    }
    this.subscriptions.clear();
    return "OK";
  }

  on(event: string, listener: (...args: unknown[]) => void): this {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as Listener);
    return this;
  }

  duplicate(_overrides?: Record<string, unknown>): RedisLike {
    return new MockRedis(this.broker);
  }

  defineCommand(_name: string, _definition: { numberOfKeys: number; lua: string }): unknown {
    this.record("DEFINE_COMMAND", [_name]);
    return undefined;
  }

  /** Internal: fan-out delivery from the broker. */
  _deliver(channel: string, message: string): void {
    if (this.closed) return;
    const set = this.listeners.get("message");
    if (!set) return;
    for (const listener of set) listener(channel, message);
  }

  /** Test helper — return commands of a given name. */
  commandsByName(name: string): RecordedCommand[] {
    return this.commands.filter((cmd) => cmd.name === name);
  }
}

/** Build a pair of MockRedis instances sharing the same Pub/Sub broker. */
export function makeLinkedMockPair(): { a: MockRedis; b: MockRedis; broker: Broker } {
  const broker = makeBroker();
  return { a: new MockRedis(broker), b: new MockRedis(broker), broker };
}
