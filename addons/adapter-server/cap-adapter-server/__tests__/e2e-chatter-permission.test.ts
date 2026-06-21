/**
 * E2E Test: cap-chatter's `chatterAddMessage` write is enforced by the real
 * CommandLayer permission slot.
 *
 * `chatterAddMessage` is a capability-contributed GraphQL mutation that is NOT
 * backed by a meta-model Action — it writes a plain Drizzle row via
 * `ChatterService.createMessage`. It is raw-merged into the schema's Mutation
 * type (`...extraMutationFields`), so it does NOT route through
 * `dispatchAction → commandLayer.execute` and would otherwise SKIP the permission
 * slot — violating "All API endpoints go through CommandLayer".
 *
 * The fix injects a host-built `authorizeChatterWrite` hook onto the GraphQL
 * context. cap-chatter calls it before writing; the host implementation runs a
 * CommandLayer non-action dispatch (`skipActionSlots: true`) carrying
 * `meta.recordWrite = { entity }`, which the real cap-permission middleware
 * resolves to an entity-level WRITE check on the target record's entity.
 *
 * This test wires the REAL `cap-permission` + the REAL `cap-chatter` through
 * `createDevApp(...)` — real GraphQL schema, real CommandLayer pipeline,
 * InMemoryStore (DB-free) — driven in-process via `app.handle(new Request(...))`.
 * No mock of the permission decision.
 *
 * Proves:
 *   (a) an actor WITHOUT write access to the target entity is DENIED, and NO
 *       chatter message is persisted (read-back via `chatterMessages` is empty);
 *   (b) an actor WITH write access is ALLOWED and the message persists;
 *   (c) the gate is WRITE-specific: a read-only actor (data.read:"all",
 *       data.write:"none") is still denied — proving the slot evaluates WRITE
 *       access, not mere existence/read.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { createCapChatter } from "@linchkit/cap-chatter";
import { createCapPermission } from "@linchkit/cap-permission";
import type {
  Actor,
  CapabilityDefinition,
  EntityDefinition,
  PermissionGroupDefinition,
} from "@linchkit/core";
import { defineCapability } from "@linchkit/core";
import { PermissionRegistry } from "@linchkit/core/server";
import { createDevApp } from "../src/dev-app";

// ── Target entity ──────────────────────────────────────────
//
// `ticket` is the entity chatter comments are posted AGAINST. The chatter write
// is gated on WRITE access to THIS entity (you may comment on a record iff you
// may write that record's entity).

const ticketEntity: EntityDefinition = {
  name: "ticket",
  label: "Ticket",
  description: "Synthetic entity chatter comments are posted against",
  fields: {
    title: { type: "string", required: true, label: "Title" },
  },
};

const capTicketTest: CapabilityDefinition = defineCapability({
  name: "cap-ticket-test",
  label: "Ticket Test",
  description: "Synthetic capability contributing the ticket entity",
  type: "standard",
  category: "business",
  version: "0.1.0",
  entities: [ticketEntity],
});

// ── Permission groups ──────────────────────────────────────
//
// The permission middleware resolves the WRITE meta-target's capability to the
// entity name (`ticket`), so grants are keyed `permissions.ticket.ticket`.

/** Full write access — may comment on tickets. */
const ticketWriterGroup: PermissionGroupDefinition = {
  name: "ticket_writer",
  label: "Ticket Writer",
  permissions: {
    ticket: {
      ticket: {
        actions: {},
        data: { read: "all", write: "all" },
      },
    },
  },
};

/** Read-only — explicitly NO write access → comment must be denied. */
const ticketReaderGroup: PermissionGroupDefinition = {
  name: "ticket_reader",
  label: "Ticket Reader",
  permissions: {
    ticket: {
      ticket: {
        actions: {},
        data: { read: "all", write: "none" },
      },
    },
  },
};

/**
 * Row-level conditional WRITE — may write ONLY own-created tickets. This non-action
 * gate carries the target `recordId` but does not load the record, so it cannot
 * prove the condition holds for THIS row. The gate must therefore fail closed:
 * a conditional grant must NOT be treated as a blanket allow (else a writer scoped
 * to their own rows could comment on ANY ticket — a row-level bypass).
 */
const ticketConditionalWriterGroup: PermissionGroupDefinition = {
  name: "ticket_conditional_writer",
  label: "Ticket Conditional Writer",
  permissions: {
    ticket: {
      ticket: {
        actions: {},
        data: {
          read: "all",
          write: { condition: { field: "created_by", operator: "eq", value: "$actor.id" } },
        },
      },
    },
  },
};

function buildRegistry(): PermissionRegistry {
  const registry = new PermissionRegistry();
  registry.register(ticketWriterGroup);
  registry.register(ticketReaderGroup);
  registry.register(ticketConditionalWriterGroup);
  return registry;
}

// ── Actor wiring ───────────────────────────────────────────

const TOKENS: Record<string, Actor> = {
  "Bearer writer": { type: "human", id: "writer-1", groups: ["ticket_writer"] },
  "Bearer reader": { type: "human", id: "reader-1", groups: ["ticket_reader"] },
  // Conditional write grant ("own rows only") → must NOT pass the entity-level gate.
  "Bearer conditional": {
    type: "human",
    id: "conditional-1",
    groups: ["ticket_conditional_writer"],
  },
  // Group not in the registry → engine default-deny.
  "Bearer stranger": { type: "human", id: "stranger-1", groups: ["unregistered_group"] },
};

function resolveRequestActor(request: Request): Actor | undefined {
  const auth = request.headers.get("authorization");
  if (!auth) return undefined; // → ANONYMOUS_ACTOR (no groups)
  return TOKENS[auth];
}

// ── App + helpers ──────────────────────────────────────────

const GQL_URL = "http://local.test/graphql";

let app: ReturnType<typeof createDevApp>["app"];

beforeAll(() => {
  // Fresh chatter instance (its own InMemoryChatterService) so the write
  // resolver and the read query share one store, isolated to this test file.
  const capChatter = createCapChatter();
  const capPermission = createCapPermission({ registry: buildRegistry() });
  // The REAL cap-permission middleware occupies the `permission` slot, so the
  // dev allow-all stub is NOT injected — denials below are genuine.
  app = createDevApp([capTicketTest, capChatter, capPermission], {
    cors: false,
    resolveRequestActor,
  }).app;
});

interface GqlResult {
  data?: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

async function gql(query: string, auth?: string): Promise<GqlResult> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth) headers.authorization = auth;
  const res = await app.handle(
    new Request(GQL_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ query }),
    }),
  );
  return (await res.json()) as GqlResult;
}

/** Read back how many chatter messages exist on a ticket record. */
async function messageCount(recordId: string): Promise<number> {
  const read = await gql(
    `query { chatterMessages(entityName: "ticket", recordId: "${recordId}") { totalCount } }`,
    "Bearer writer",
  );
  const conn = read.data?.chatterMessages as { totalCount: number } | undefined;
  return conn?.totalCount ?? 0;
}

const ADD = (recordId: string, body: string) =>
  `mutation { chatterAddMessage(entityName: "ticket", recordId: "${recordId}", messageType: comment, body: "${body}") { id body author { id } } }`;

// ── Tests ──────────────────────────────────────────────────

describe("E2E chatter write through the real permission slot (in-process HTTP)", () => {
  it("(a) ALLOWS a writer to comment — message persists", async () => {
    const result = await gql(ADD("rec-allow", "looks good"), "Bearer writer");

    expect(result.errors).toBeUndefined();
    const msg = result.data?.chatterAddMessage as {
      id: string;
      body: string;
      author: { id: string };
    };
    expect(msg.id).toBeDefined();
    expect(msg.body).toBe("looks good");
    // Author derived server-side from the resolved actor.
    expect(msg.author.id).toBe("writer-1");

    expect(await messageCount("rec-allow")).toBe(1);
  });

  it("(b) DENIES a read-only actor — WRITE-specific gate, nothing persisted", async () => {
    const result = await gql(ADD("rec-deny-reader", "blocked"), "Bearer reader");

    // The denial originates from the real permission slot: the resolver's
    // authorize hook ran a CommandLayer non-action dispatch, cap-permission threw
    // AuthorizationError (no WRITE access), the hook re-threw, and the resolver
    // aborted. graphql-yoga masks the message, but the operation is unambiguously
    // denied and the field resolves to null.
    expect(result.errors).toBeDefined();
    expect(result.errors?.length).toBeGreaterThan(0);
    expect(result.data?.chatterAddMessage ?? null).toBeNull();

    // Side effect must NOT have happened.
    expect(await messageCount("rec-deny-reader")).toBe(0);
  });

  it("DENIES a conditional (row-level) writer — gate fails closed on conditions, nothing persisted", async () => {
    // The actor HAS write access, but only conditionally ("own rows"). The
    // entity-level gate cannot evaluate that condition against this record, so it
    // must deny rather than treat the condition as a blanket allow. Otherwise this
    // actor could comment on any ticket, not just their own.
    const result = await gql(ADD("rec-deny-conditional", "blocked"), "Bearer conditional");

    expect(result.errors).toBeDefined();
    expect(result.data?.chatterAddMessage ?? null).toBeNull();
    expect(await messageCount("rec-deny-conditional")).toBe(0);
  });

  it("DENIES a stranger whose groups are not registered — default-deny, nothing persisted", async () => {
    const result = await gql(ADD("rec-deny-stranger", "blocked"), "Bearer stranger");

    expect(result.errors).toBeDefined();
    expect(result.data?.chatterAddMessage ?? null).toBeNull();
    expect(await messageCount("rec-deny-stranger")).toBe(0);
  });

  it("DENIES an anonymous (no-token) actor — no groups, nothing persisted", async () => {
    const result = await gql(ADD("rec-deny-anon", "blocked"));

    expect(result.errors).toBeDefined();
    expect(result.data?.chatterAddMessage ?? null).toBeNull();
    expect(await messageCount("rec-deny-anon")).toBe(0);
  });
});
