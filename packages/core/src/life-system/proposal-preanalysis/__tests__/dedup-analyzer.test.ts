import { describe, expect, test } from "bun:test";
import type { ProposalDefinition } from "../../../types/proposal";
import { createDedupAnalyzer } from "../dedup-analyzer";
import type { PendingProposalStore } from "../types";
import { makeProposal } from "./fixtures";

function makeStore(proposals: ProposalDefinition[]): PendingProposalStore {
  return {
    async listPending() {
      return proposals;
    },
  };
}

describe("createDedupAnalyzer", () => {
  test("returns no similar proposals when the store is empty", async () => {
    const analyzer = createDedupAnalyzer({ store: makeStore([]) });
    const candidate = makeProposal({ id: "prop_candidate" });

    const result = await analyzer.analyze(candidate);

    expect(result.similar).toHaveLength(0);
    expect(result.exactMatch).toBeNull();
    expect(result.payloadHash).toBeTruthy();
    expect(result.payloadHash).toHaveLength(8);
  });

  test("detects an exact duplicate with identical change set", async () => {
    const existing = makeProposal({ id: "prop_existing" });
    const analyzer = createDedupAnalyzer({ store: makeStore([existing]) });
    const candidate = makeProposal({ id: "prop_candidate" });

    const result = await analyzer.analyze(candidate);

    expect(result.similar).toHaveLength(1);
    expect(result.similar[0]?.id).toBe("prop_existing");
    expect(result.exactMatch?.id).toBe("prop_existing");
  });

  test("ignores the candidate itself when it appears in the store", async () => {
    const candidate = makeProposal({ id: "prop_self" });
    const analyzer = createDedupAnalyzer({ store: makeStore([candidate]) });

    const result = await analyzer.analyze(candidate);

    expect(result.similar).toHaveLength(0);
    expect(result.exactMatch).toBeNull();
  });

  test("ignores proposals in non-pending statuses", async () => {
    const approved = makeProposal({ id: "prop_approved", status: "approved" });
    const analyzer = createDedupAnalyzer({ store: makeStore([approved]) });
    const candidate = makeProposal({ id: "prop_candidate" });

    const result = await analyzer.analyze(candidate);

    expect(result.similar).toHaveLength(0);
    expect(result.exactMatch).toBeNull();
  });

  test("flags a near-match (shared change, different cardinality) as similar but not exact", async () => {
    const existing = makeProposal({
      id: "prop_existing",
      changes: [
        {
          target: "entity",
          operation: "update",
          name: "purchase_request",
          diff: "add priority field",
        },
        // Extra unrelated change — same target/op/hash as candidate's single change overlaps,
        // but the overall change set differs so this must NOT be an exact match.
        {
          target: "rule",
          operation: "create",
          name: "budget_reminder",
          diff: "warn when over budget",
        },
      ],
    });
    const candidate = makeProposal({ id: "prop_candidate" });
    const analyzer = createDedupAnalyzer({ store: makeStore([existing]) });

    const result = await analyzer.analyze(candidate);

    expect(result.similar).toHaveLength(1);
    expect(result.similar[0]?.id).toBe("prop_existing");
    expect(result.exactMatch).toBeNull();
  });

  test("treats different diff text as distinct payloads", async () => {
    const existing = makeProposal({
      id: "prop_existing",
      changes: [
        {
          target: "entity",
          operation: "update",
          name: "purchase_request",
          diff: "add category field", // different payload
        },
      ],
    });
    const candidate = makeProposal({ id: "prop_candidate" });
    const analyzer = createDedupAnalyzer({ store: makeStore([existing]) });

    const result = await analyzer.analyze(candidate);

    expect(result.similar).toHaveLength(0);
    expect(result.exactMatch).toBeNull();
  });

  test("produces stable payload hashes regardless of object key order", async () => {
    const a = makeProposal({
      id: "a",
      changes: [
        {
          target: "entity",
          operation: "update",
          name: "x",
          definition: { name: "x", fields: { a: { type: "string" }, b: { type: "int" } } } as never,
        },
      ],
    });
    const b = makeProposal({
      id: "b",
      changes: [
        {
          target: "entity",
          operation: "update",
          name: "x",
          definition: { fields: { b: { type: "int" }, a: { type: "string" } }, name: "x" } as never,
        },
      ],
    });
    const analyzer = createDedupAnalyzer({ store: makeStore([]) });

    const resA = await analyzer.analyze(a);
    const resB = await analyzer.analyze(b);

    expect(resA.payloadHash).toBe(resB.payloadHash);
  });

  test("respects a custom pendingStatuses override", async () => {
    const committed = makeProposal({ id: "prop_committed", status: "committed" });
    const analyzer = createDedupAnalyzer({
      store: makeStore([committed]),
      pendingStatuses: new Set(["committed"]),
    });
    const candidate = makeProposal({ id: "prop_candidate" });

    const result = await analyzer.analyze(candidate);

    expect(result.similar).toHaveLength(1);
    expect(result.exactMatch?.id).toBe("prop_committed");
  });
});
