/**
 * Tests for the search client's transport contract.
 *
 * We exercise `createSearchClient(transport)` directly (the bare factory
 * the hook wraps) — this avoids importing React at all, which is critical
 * because `mock.module("react", ...)` leaks across files in bun's shared
 * test process and breaks any other test that imports a real `React.createContext`
 * (config-loader.test.ts ran into exactly that). The hook itself is a one-line
 * `useMemo` wrapper; testing the factory covers the wire contract end-to-end.
 */

import { describe, expect, it } from "bun:test";
import {
  createSearchClient,
  type GraphQLResponse,
  type SearchHit,
  type SearchTransport,
} from "../src/hooks/useSearchClient";

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

describe("createSearchClient", () => {
  it("sends a GraphQL query with the expected variables via the transport", async () => {
    const stub = makeTransport({
      data: {
        search: [
          { entity: "purchase_request", recordId: "pr-1", score: 0.42 },
          { entity: "purchase_request", recordId: "pr-2", score: 0.31 },
        ],
      },
    });

    const client = createSearchClient(stub.transport);
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
    const client = createSearchClient(stub.transport);

    const hits = await client.search("   ");

    expect(stub.calls).toHaveLength(0);
    expect(hits).toEqual([]);
  });

  it("unwraps the response from { data: { search: [...] } }", async () => {
    const stub = makeTransport({
      data: { search: [{ entity: "user", recordId: "u-1", score: 1.5 }] },
    });

    const client = createSearchClient(stub.transport);
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

    const client = createSearchClient(stub.transport);
    const hits = await client.search("query");
    expect(hits[0]?.score).toBe(0);
    expect(hits[1]?.score).toBe(0);
  });

  it("throws when the GraphQL response carries errors", async () => {
    const stub = makeTransport({ errors: [{ message: "boom" }] });
    const client = createSearchClient(stub.transport);

    await expect(client.search("hello")).rejects.toThrow("boom");
  });

  it("forwards entity and limit options into variables", async () => {
    const stub = makeTransport({ data: { search: [] } });
    const client = createSearchClient(stub.transport);

    await client.search("scoped", { entity: "purchase_request", limit: 5 });

    expect(stub.calls[0]?.variables).toEqual({
      q: "scoped",
      entity: "purchase_request",
      limit: 5,
    });
  });

  it("clamps a negative limit up to 1 before sending", async () => {
    const stub = makeTransport({ data: { search: [] } });
    const client = createSearchClient(stub.transport);

    await client.search("neg", { limit: -10 });

    expect(stub.calls[0]?.variables.limit).toBe(1);
  });

  it("clamps a limit above 200 down to the server-side max", async () => {
    const stub = makeTransport({ data: { search: [] } });
    const client = createSearchClient(stub.transport);

    await client.search("big", { limit: 5_000 });

    expect(stub.calls[0]?.variables.limit).toBe(200);
  });

  it("defaults non-finite or missing limit to 20", async () => {
    const stub = makeTransport({ data: { search: [] } });
    const client = createSearchClient(stub.transport);

    await client.search("nan", { limit: Number.NaN });
    await client.search("undef");

    expect(stub.calls[0]?.variables.limit).toBe(20);
    expect(stub.calls[1]?.variables.limit).toBe(20);
  });
});
