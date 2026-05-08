/**
 * Tests for `limitCatalogToRelevant()` — Spec 52 Phase 1 hardening (#262).
 *
 * Coverage matches the issue's checklist:
 *   1. Small catalog passes through unchanged (K not exceeded).
 *   2. Word-overlap ranking orders relevant entity first.
 *   3. Entity-cap (K) enforced.
 *   4. Per-entity action cap enforced.
 *   5. Stable order on score ties.
 *   6. Substring partial match (singular vs plural).
 *   7. Empty prompt edge case → top-K by original order.
 */

import { describe, expect, test } from "bun:test";
import type { ActionCatalogEntry } from "@linchkit/cap-ai-provider";
import { limitCatalogToRelevant } from "../src/lib/relevant-actions";

// ── Fixture helpers ─────────────────────────────────────────

function action(opts: {
  entity: string;
  name: string;
  label?: string;
  description?: string;
  fields?: Array<{ name: string; type?: string; required?: boolean }>;
}): ActionCatalogEntry {
  return {
    name: opts.name,
    entity: opts.entity,
    label: opts.label ?? opts.name,
    description: opts.description,
    inputFields: (opts.fields ?? []).map((f) => ({
      name: f.name,
      type: f.type ?? "string",
      required: f.required === true,
    })),
  };
}

/**
 * Generate `count` synthetic entities each with a single create action.
 * Names are deterministic (`entity_001`, `create_entity_001`, ...) so
 * tests can assert on shape without coupling to specific business names.
 */
function syntheticCatalog(count: number): ActionCatalogEntry[] {
  const out: ActionCatalogEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    const idx = String(i + 1).padStart(3, "0");
    out.push(
      action({
        entity: `entity_${idx}`,
        name: `create_entity_${idx}`,
        label: `Create Entity ${idx}`,
      }),
    );
  }
  return out;
}

// ── Test 1 — small catalog passthrough ──────────────────────

describe("limitCatalogToRelevant — small catalog passthrough", () => {
  test("returns input unchanged when entity count is at or below maxEntities", () => {
    const catalog = syntheticCatalog(5);
    const out = limitCatalogToRelevant({
      catalog,
      prompt: "create something",
      maxEntities: 20,
      maxActionsPerEntity: 20,
    });
    expect(out.length).toBe(catalog.length);
    expect(out.map((e) => e.name)).toEqual(catalog.map((e) => e.name));
  });
});

// ── Test 2 — word-overlap ranking ───────────────────────────

describe("limitCatalogToRelevant — word-overlap ranking", () => {
  test("entity whose name matches the prompt ranks first", () => {
    // Three entities, K capped at 1 so only the top scorer survives — that
    // exercises the ranking instead of just relying on passthrough.
    const catalog: ActionCatalogEntry[] = [
      action({ entity: "user", name: "create_user", label: "Create User" }),
      action({ entity: "product", name: "create_product", label: "Create Product" }),
      action({ entity: "order", name: "create_order", label: "Create Order" }),
    ];
    const out = limitCatalogToRelevant({
      catalog,
      prompt: "create order",
      maxEntities: 1,
      maxActionsPerEntity: 20,
    });
    expect(out.length).toBe(1);
    expect(out[0]?.entity).toBe("order");
  });
});

// ── Test 3 — entity cap enforced ────────────────────────────

describe("limitCatalogToRelevant — entity cap enforced", () => {
  test("output retains exactly maxEntities groups for a 30-entity catalog", () => {
    const catalog = syntheticCatalog(30);
    const out = limitCatalogToRelevant({
      catalog,
      prompt: "create something",
      maxEntities: 20,
      maxActionsPerEntity: 20,
    });
    const distinctEntities = new Set(out.map((e) => e.entity));
    expect(distinctEntities.size).toBe(20);
  });
});

// ── Test 4 — per-entity action cap ──────────────────────────

describe("limitCatalogToRelevant — per-entity action cap enforced", () => {
  test("entity with 30 actions is capped to maxActionsPerEntity", () => {
    // Build a single entity with 30 actions, plus 25 dummy entities so the
    // entity-cap also engages.
    const orderActions: ActionCatalogEntry[] = [];
    for (let i = 0; i < 30; i += 1) {
      const idx = String(i + 1).padStart(2, "0");
      orderActions.push(
        action({ entity: "order", name: `op_order_${idx}`, label: `Op Order ${idx}` }),
      );
    }
    const filler = syntheticCatalog(25);
    const catalog = [...orderActions, ...filler];
    const out = limitCatalogToRelevant({
      catalog,
      prompt: "order",
      maxEntities: 20,
      maxActionsPerEntity: 20,
    });
    const orderOut = out.filter((e) => e.entity === "order");
    expect(orderOut.length).toBe(20);
  });
});

// ── Test 5 — stable order on ties ───────────────────────────

describe("limitCatalogToRelevant — stable order on ties", () => {
  test("three score-zero entities preserve original order", () => {
    // Prompt has nothing in common with any candidate — every entity scores 0.
    const catalog: ActionCatalogEntry[] = [
      action({ entity: "alpha", name: "act_alpha" }),
      action({ entity: "beta", name: "act_beta" }),
      action({ entity: "gamma", name: "act_gamma" }),
    ];
    const out = limitCatalogToRelevant({
      catalog,
      prompt: "xyzzy plugh quux",
      // Force ranking path: maxEntities < grouped.length triggers scoring.
      maxEntities: 2,
      maxActionsPerEntity: 20,
    });
    expect(out.map((e) => e.entity)).toEqual(["alpha", "beta"]);
  });
});

// ── Test 6 — substring partial match ────────────────────────

describe("limitCatalogToRelevant — substring partial match", () => {
  test("plural prompt token still matches singular entity name", () => {
    // 21 entities → entity-cap (default 20) engages; the relevance ranker
    // must lift `department` above the unrelated synthetic entities via a
    // partial-substring match.
    const filler = syntheticCatalog(20);
    const dept = action({
      entity: "department",
      name: "create_department",
      label: "Create Department",
    });
    const catalog = [...filler, dept];
    const out = limitCatalogToRelevant({
      catalog,
      prompt: "departments",
      maxEntities: 1,
      maxActionsPerEntity: 20,
    });
    expect(out.length).toBe(1);
    expect(out[0]?.entity).toBe("department");
  });
});

// ── Test 8 — small entity count, large action count ─────────

describe("limitCatalogToRelevant — small entity count + large action count", () => {
  test("ranks actions even when grouped.length <= maxEntities (codex P1)", () => {
    // Single entity with 25 actions, only one matches the prompt. Default
    // K is 20, so the matching action sits at original index 24 — a naive
    // first-N truncation would drop it. The relevance pass must lift it
    // into the kept window (codex P1 review on PR #283).
    const actions: ActionCatalogEntry[] = [];
    for (let i = 0; i < 24; i += 1) {
      const idx = String(i + 1).padStart(2, "0");
      actions.push(action({ entity: "order", name: `noop_order_${idx}` }));
    }
    actions.push(action({ entity: "order", name: "ship_order", label: "Ship Order" }));

    const out = limitCatalogToRelevant({
      catalog: actions,
      prompt: "ship order",
      maxEntities: 20,
      maxActionsPerEntity: 20,
    });

    // Output is exactly 20 actions, the matching one is included.
    expect(out.length).toBe(20);
    expect(out.some((e) => e.name === "ship_order")).toBe(true);
  });
});

// ── Test 9 — snake_case identifier tokenization ─────────────

describe("limitCatalogToRelevant — snake_case action name", () => {
  test("matches prompt 'submit purchase request' against 'submit_purchase_request' (codex P2)", () => {
    // Default K is 20; we have 25 entities total so the entity-cap engages
    // and ranking is mandatory. The intended action's identifier is
    // snake_case (`submit_purchase_request`) — when the tokenizer keeps
    // `_` as part of a token, the prompt's three space-separated words
    // never align with the identifier and ranking misses (codex P2).
    const filler = syntheticCatalog(24);
    const target = action({
      entity: "purchase_request",
      name: "submit_purchase_request",
      label: "Submit Purchase Request",
    });
    const catalog = [...filler, target];

    const out = limitCatalogToRelevant({
      catalog,
      prompt: "submit purchase request",
      maxEntities: 1,
      maxActionsPerEntity: 20,
    });

    expect(out.length).toBe(1);
    expect(out[0]?.entity).toBe("purchase_request");
  });
});

// ── Test 7 — empty prompt edge case ─────────────────────────

describe("limitCatalogToRelevant — empty prompt", () => {
  test("empty prompt returns top-K by original order", () => {
    const catalog = syntheticCatalog(30);
    const out = limitCatalogToRelevant({
      catalog,
      prompt: "",
      maxEntities: 20,
      maxActionsPerEntity: 20,
    });
    // First 20 entities by original order, in order.
    expect(out.length).toBe(20);
    expect(out.map((e) => e.entity)).toEqual(catalog.slice(0, 20).map((e) => e.entity));
  });
});
