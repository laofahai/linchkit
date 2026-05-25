/**
 * Tests for GeneratorPriorityAggregator (Spec 55 §7.7 Phase 3).
 *
 * Verifies weight adjustment, acceptance ratio computation,
 * (authorId, changeType) grouping, clamping, and query interfaces.
 */

import { describe, expect, it } from "bun:test";
import {
  createGeneratorPriorityAggregator,
  GeneratorPriorityAggregator,
  type GeneratorWeightRecord,
  type OutcomeObservation,
} from "../src/engine/generator-priority-aggregator";

// ── Fixtures ──────────────────────────────────────────────────

function obs(
  authorId: string,
  changeType: string,
  outcome: OutcomeObservation["outcome"],
): OutcomeObservation {
  return { authorId, changeType, outcome };
}

// ── Factory ───────────────────────────────────────────────────

describe("createGeneratorPriorityAggregator", () => {
  it("returns a GeneratorPriorityAggregator instance", () => {
    const agg = createGeneratorPriorityAggregator();
    expect(agg).toBeInstanceOf(GeneratorPriorityAggregator);
  });

  it("accepts optional config", () => {
    const agg = createGeneratorPriorityAggregator({ config: { initialWeight: 2.0 } });
    expect(agg.getWeight("unknown-gen", "minor")).toBe(2.0);
  });
});

// ── Default weight for unknown generator ──────────────────────

describe("getWeight — no observations", () => {
  it("returns initialWeight (1.0) for an unseen generator", () => {
    const agg = new GeneratorPriorityAggregator();
    expect(agg.getWeight("gen-x", "minor")).toBe(1.0);
  });

  it("returns initialWeight when no changeType provided for unseen generator", () => {
    const agg = new GeneratorPriorityAggregator();
    expect(agg.getWeight("gen-x")).toBe(1.0);
  });
});

// ── observe — accepted ────────────────────────────────────────

describe("observe — accepted", () => {
  it("increases weight by boostOnAccept (0.2)", () => {
    const agg = new GeneratorPriorityAggregator();
    agg.observe(obs("gen-a", "minor", "accepted"));
    expect(agg.getWeight("gen-a", "minor")).toBeCloseTo(1.2);
  });

  it("compounds boosts for multiple accepts", () => {
    const agg = new GeneratorPriorityAggregator();
    agg.observe(obs("gen-a", "minor", "accepted"));
    agg.observe(obs("gen-a", "minor", "accepted"));
    agg.observe(obs("gen-a", "minor", "accepted"));
    expect(agg.getWeight("gen-a", "minor")).toBeCloseTo(1.6);
  });

  it("acceptedCount increments correctly", () => {
    const agg = new GeneratorPriorityAggregator();
    agg.observe(obs("gen-a", "minor", "accepted"));
    agg.observe(obs("gen-a", "minor", "accepted"));
    const rec = agg.getAll()[0];
    expect(rec?.acceptedCount).toBe(2);
  });
});

// ── observe — rejected ────────────────────────────────────────

describe("observe — rejected", () => {
  it("decreases weight by decayOnReject (0.3)", () => {
    const agg = new GeneratorPriorityAggregator();
    agg.observe(obs("gen-a", "minor", "rejected"));
    expect(agg.getWeight("gen-a", "minor")).toBeCloseTo(0.7);
  });

  it("compounds decays for multiple rejects", () => {
    const agg = new GeneratorPriorityAggregator();
    agg.observe(obs("gen-a", "minor", "rejected"));
    agg.observe(obs("gen-a", "minor", "rejected"));
    expect(agg.getWeight("gen-a", "minor")).toBeCloseTo(0.4);
  });

  it("rejectedCount increments correctly", () => {
    const agg = new GeneratorPriorityAggregator();
    agg.observe(obs("gen-a", "minor", "rejected"));
    const rec = agg.getAll()[0];
    expect(rec?.rejectedCount).toBe(1);
  });
});

// ── observe — merged / withdrawn ─────────────────────────────

describe("observe — merged / withdrawn", () => {
  it("merged does not affect weight", () => {
    const agg = new GeneratorPriorityAggregator();
    agg.observe(obs("gen-a", "minor", "merged"));
    expect(agg.getWeight("gen-a", "minor")).toBe(1.0);
  });

  it("withdrawn does not affect weight", () => {
    const agg = new GeneratorPriorityAggregator();
    agg.observe(obs("gen-a", "minor", "withdrawn"));
    expect(agg.getWeight("gen-a", "minor")).toBe(1.0);
  });

  it("mergedCount and withdrawnCount are tracked", () => {
    const agg = new GeneratorPriorityAggregator();
    agg.observe(obs("gen-a", "minor", "merged"));
    agg.observe(obs("gen-a", "minor", "withdrawn"));
    const rec = agg.getAll()[0];
    expect(rec?.mergedCount).toBe(1);
    expect(rec?.withdrawnCount).toBe(1);
  });
});

// ── weight clamping ───────────────────────────────────────────

describe("weight clamping", () => {
  it("weight never exceeds maxWeight (3.0 default)", () => {
    const agg = new GeneratorPriorityAggregator();
    for (let i = 0; i < 20; i++) {
      agg.observe(obs("gen-a", "minor", "accepted"));
    }
    expect(agg.getWeight("gen-a", "minor")).toBe(3.0);
  });

  it("weight never drops below minWeight (0.1 default)", () => {
    const agg = new GeneratorPriorityAggregator();
    for (let i = 0; i < 20; i++) {
      agg.observe(obs("gen-a", "minor", "rejected"));
    }
    expect(agg.getWeight("gen-a", "minor")).toBe(0.1);
  });

  it("respects custom minWeight", () => {
    const agg = new GeneratorPriorityAggregator({ config: { minWeight: 0.5 } });
    for (let i = 0; i < 20; i++) {
      agg.observe(obs("gen-a", "minor", "rejected"));
    }
    expect(agg.getWeight("gen-a", "minor")).toBe(0.5);
  });

  it("respects custom maxWeight", () => {
    const agg = new GeneratorPriorityAggregator({ config: { maxWeight: 1.5 } });
    for (let i = 0; i < 20; i++) {
      agg.observe(obs("gen-a", "minor", "accepted"));
    }
    expect(agg.getWeight("gen-a", "minor")).toBe(1.5);
  });
});

// ── acceptanceRatio ───────────────────────────────────────────

describe("acceptanceRatio", () => {
  it("is 0.5 with no decisions", () => {
    const agg = new GeneratorPriorityAggregator();
    agg.observe(obs("gen-a", "minor", "merged"));
    const rec = agg.getAll()[0];
    expect(rec?.acceptanceRatio).toBe(0.5);
  });

  it("is 1.0 after only accepts", () => {
    const agg = new GeneratorPriorityAggregator();
    agg.observe(obs("gen-a", "minor", "accepted"));
    agg.observe(obs("gen-a", "minor", "accepted"));
    const rec = agg.getAll()[0];
    expect(rec?.acceptanceRatio).toBe(1.0);
  });

  it("is 0.0 after only rejects", () => {
    const agg = new GeneratorPriorityAggregator();
    agg.observe(obs("gen-a", "minor", "rejected"));
    agg.observe(obs("gen-a", "minor", "rejected"));
    const rec = agg.getAll()[0];
    expect(rec?.acceptanceRatio).toBe(0.0);
  });

  it("is 0.5 after equal accepts and rejects", () => {
    const agg = new GeneratorPriorityAggregator();
    agg.observe(obs("gen-a", "minor", "accepted"));
    agg.observe(obs("gen-a", "minor", "rejected"));
    const rec = agg.getAll()[0];
    expect(rec?.acceptanceRatio).toBe(0.5);
  });

  it("is 0.75 after 3 accepts and 1 reject", () => {
    const agg = new GeneratorPriorityAggregator();
    agg.observe(obs("gen-a", "minor", "accepted"));
    agg.observe(obs("gen-a", "minor", "accepted"));
    agg.observe(obs("gen-a", "minor", "accepted"));
    agg.observe(obs("gen-a", "minor", "rejected"));
    const rec = agg.getAll()[0];
    expect(rec?.acceptanceRatio).toBeCloseTo(0.75);
  });
});

// ── (authorId, changeType) grouping ──────────────────────────

describe("(authorId, changeType) grouping", () => {
  it("tracks (gen-a, minor) and (gen-a, major) independently", () => {
    const agg = new GeneratorPriorityAggregator();
    agg.observe(obs("gen-a", "minor", "accepted"));
    agg.observe(obs("gen-a", "minor", "accepted"));
    agg.observe(obs("gen-a", "major", "rejected"));

    expect(agg.getWeight("gen-a", "minor")).toBeCloseTo(1.4);
    expect(agg.getWeight("gen-a", "major")).toBeCloseTo(0.7);
  });

  it("tracks different generators independently", () => {
    const agg = new GeneratorPriorityAggregator();
    agg.observe(obs("gen-a", "minor", "accepted"));
    agg.observe(obs("gen-b", "minor", "rejected"));

    expect(agg.getWeight("gen-a", "minor")).toBeCloseTo(1.2);
    expect(agg.getWeight("gen-b", "minor")).toBeCloseTo(0.7);
  });

  it("getAll() returns one record per (authorId, changeType) pair", () => {
    const agg = new GeneratorPriorityAggregator();
    agg.observe(obs("gen-a", "minor", "accepted"));
    agg.observe(obs("gen-a", "major", "rejected"));
    agg.observe(obs("gen-b", "minor", "accepted"));

    expect(agg.getAll()).toHaveLength(3);
  });
});

// ── getWeight without changeType ──────────────────────────────

describe("getWeight — cross-changeType average", () => {
  it("returns average weight across all changeTyes for the given authorId", () => {
    const agg = new GeneratorPriorityAggregator();
    agg.observe(obs("gen-a", "minor", "accepted")); // weight → 1.2
    agg.observe(obs("gen-a", "major", "rejected")); // weight → 0.7
    // average = (1.2 + 0.7) / 2 = 0.95
    expect(agg.getWeight("gen-a")).toBeCloseTo(0.95);
  });

  it("returns initialWeight when no observations for that authorId", () => {
    const agg = new GeneratorPriorityAggregator();
    agg.observe(obs("gen-b", "minor", "accepted"));
    expect(agg.getWeight("gen-a")).toBe(1.0);
  });
});

// ── getAll ordering ───────────────────────────────────────────

describe("getAll — ordering", () => {
  it("returns records sorted by weight descending", () => {
    const agg = new GeneratorPriorityAggregator();
    agg.observe(obs("gen-a", "minor", "rejected")); // 0.7
    agg.observe(obs("gen-b", "minor", "accepted")); // 1.2
    agg.observe(obs("gen-c", "minor", "accepted")); // 1.2
    agg.observe(obs("gen-c", "minor", "accepted")); // 1.4

    const all = agg.getAll();
    for (let i = 1; i < all.length; i++) {
      expect((all[i - 1] as GeneratorWeightRecord).weight).toBeGreaterThanOrEqual(
        (all[i] as GeneratorWeightRecord).weight,
      );
    }
  });

  it("returns empty array when no observations", () => {
    const agg = new GeneratorPriorityAggregator();
    expect(agg.getAll()).toHaveLength(0);
  });
});

// ── reset ─────────────────────────────────────────────────────

describe("reset", () => {
  it("clears all accumulated state", () => {
    const agg = new GeneratorPriorityAggregator();
    agg.observe(obs("gen-a", "minor", "accepted"));
    agg.observe(obs("gen-b", "minor", "rejected"));
    agg.reset();

    expect(agg.getAll()).toHaveLength(0);
    expect(agg.getWeight("gen-a", "minor")).toBe(1.0);
  });
});

// ── custom config ─────────────────────────────────────────────

describe("custom config", () => {
  it("respects custom boostOnAccept", () => {
    const agg = new GeneratorPriorityAggregator({ config: { boostOnAccept: 0.5 } });
    agg.observe(obs("gen-a", "minor", "accepted"));
    expect(agg.getWeight("gen-a", "minor")).toBeCloseTo(1.5);
  });

  it("respects custom decayOnReject", () => {
    const agg = new GeneratorPriorityAggregator({ config: { decayOnReject: 0.5 } });
    agg.observe(obs("gen-a", "minor", "rejected"));
    expect(agg.getWeight("gen-a", "minor")).toBeCloseTo(0.5);
  });

  it("respects custom initialWeight", () => {
    const agg = new GeneratorPriorityAggregator({ config: { initialWeight: 2.0 } });
    agg.observe(obs("gen-a", "minor", "accepted"));
    expect(agg.getWeight("gen-a", "minor")).toBeCloseTo(2.2);
  });
});

// ── lastUpdatedAt ─────────────────────────────────────────────

describe("lastUpdatedAt", () => {
  it("is set on first observe", () => {
    const before = new Date();
    const agg = new GeneratorPriorityAggregator();
    agg.observe(obs("gen-a", "minor", "accepted"));
    const after = new Date();

    const rec = agg.getAll()[0];
    expect(rec?.lastUpdatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(rec?.lastUpdatedAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it("updates lastUpdatedAt on subsequent observes", async () => {
    const agg = new GeneratorPriorityAggregator();
    agg.observe(obs("gen-a", "minor", "accepted"));
    const firstUpdate = agg.getAll()[0]?.lastUpdatedAt.getTime() ?? 0;

    // Ensure time advances
    await new Promise((r) => setTimeout(r, 10));
    agg.observe(obs("gen-a", "minor", "rejected"));
    const secondUpdate = agg.getAll()[0]?.lastUpdatedAt.getTime() ?? 0;

    expect(secondUpdate).toBeGreaterThan(firstUpdate);
  });
});
