/**
 * Tests for the useSearchClient hook's transport contract.
 *
 * Bun's default test runner has no React renderer, so we exercise the
 * client by calling the hook implementation directly via a tiny shim —
 * the hook is a pure useMemo wrapper, so the returned callable is the
 * same shape with or without React's lifecycle. This keeps the test
 * deterministic and avoids adding @testing-library/react as a new
 * runtime dependency (see CLAUDE.md — new deps need approval).
 *
 * The default transport is `@linchkit/cap-adapter-ui/lib/api`'s
 * `graphql()` helper (it injects Authorization + X-Tenant-Id). Tests
 * override that by passing `transport`, so the auth surface is the
 * adapter-ui's responsibility, not this hook's.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import type { GraphQLResponse, SearchHit, SearchTransport } from "../src/hooks/useSearchClient";

// Mock React's useMemo to immediately invoke the factory — we only need
// the returned callable for testing the network contract.
mock.module("react", () => ({
  useMemo: <T>(factory: () => T): T => factory(),
}));

const { useSearchClient } = await import("../src/hooks/useSearchClient");

interface TransportCall {
  query: string;
  variables: Record<string, unknown>;
}

function makeTransport(response: GraphQLResponse<{ search: SearchHit[] }>): {
  transport: SearchTransport;
  calls: TransportCall[];
} {
  const calls: TransportCall[] = [];
  const transport: SearchTransport = async (query, variables) => {
    calls.push({ query, variables });
    return response;
  };
  return { transport, calls };
}

afterEach(() => {
  mock.restore();
});

describe("useSearchClient", () => {
  it("sends a GraphQL query with the expected variables via the transport", async () => {
    const stub = makeTransport({
      data: {
        search: [
          { entity: "purchase_request", recordId: "pr-1", score: 0.42 },
          { entity: "purchase_request", recordId: "pr-2", score: 0.31 },
        ],
      },
    });

    const client = useSearchClient({ transport: stub.transport });
    const hits = await client.search("widgets");

    expect(stub.calls).toHaveLength(1);
    const call = stub.calls[0];
    expect(call?.query).toContain("query Search");
    expect(call?.query).toContain("search(q: $q, entity: $entity, limit: $limit)");
    expect(call?.variables).toEqual({ q: "widgets", entity: undefined, limit: 20 });

    expect(hits).toEqual([
      { entity: "purchase_request", recordId: "pr-1", score: 0.42 },
      { entity: "purchase_request", recordId: "pr-2", score: 0.31 },
    ]);
  });

  it("trims and short-circuits on whitespace-only queries (no transport call)", async () => {
    const stub = makeTransport({ data: { search: [] } });
    const client = useSearchClient({ transport: stub.transport });

    const hits = await client.search("   ");

    expect(stub.calls).toHaveLength(0);
    expect(hits).toEqual([]);
  });

  it("unwraps the response from { data: { search: [...] } }", async () => {
    const stub = makeTransport({
      data: { search: [{ entity: "user", recordId: "u-1", score: 1.5 }] },
    });

    const client = useSearchClient({ transport: stub.transport });
    const hits = await client.search("alice");
    expect(hits).toEqual([{ entity: "user", recordId: "u-1", score: 1.5 }]);
  });

  it("normalizes non-numeric scores to 0", async () => {
    const stub = makeTransport({
      data: {
        search: [
          { entity: "x", recordId: "1", score: Number.NaN },
          { entity: "x", recordId: "2", score: "bad" as unknown as number },
        ],
      },
    });

    const client = useSearchClient({ transport: stub.transport });
    const hits = await client.search("query");
    expect(hits[0]?.score).toBe(0);
    expect(hits[1]?.score).toBe(0);
  });

  it("throws when the GraphQL response carries errors", async () => {
    const stub = makeTransport({ errors: [{ message: "boom" }] });
    const client = useSearchClient({ transport: stub.transport });

    await expect(client.search("hello")).rejects.toThrow("boom");
  });

  it("forwards entity and limit options into variables", async () => {
    const stub = makeTransport({ data: { search: [] } });
    const client = useSearchClient({ transport: stub.transport });

    await client.search("scoped", { entity: "purchase_request", limit: 5 });

    expect(stub.calls[0]?.variables).toEqual({
      q: "scoped",
      entity: "purchase_request",
      limit: 5,
    });
  });
});
