/**
 * Shared fixtures for the proposal-materialize test suites (split out to keep each
 * `*.test.ts` under the 500-line cap). The code-generation provider is ALWAYS an
 * injected fake here — no real model is ever called.
 */

import type { ProposalChange, ProposalDefinition } from "@linchkit/core";
import type { CodeGenerationProvider, QualityGateRunner } from "@linchkit/core/server";
import type { MaterializeEngine } from "../src/proposal-materialize-api";

/** A syntactically valid generated source the fake code-gen provider returns. */
export const GOOD = "export const deduct_inventory = 1;";

/** Build a DRAFT proposal with a single materializable `deduct_inventory` action. */
export function makeProposal(overrides: Partial<ProposalDefinition> = {}): ProposalDefinition {
  const now = new Date();
  return {
    id: "prop-abc12345",
    title: "Add deduct_inventory action",
    description: "When an order is approved, deduct inventory",
    author: { type: "ai", id: "pattern-detector", name: "Pattern Detector" },
    capability: "cap-demo",
    changeType: "minor",
    changes: [{ target: "action", operation: "create", name: "deduct_inventory" }],
    impact: {
      schemasAffected: [],
      actionsAffected: ["deduct_inventory"],
      rulesAffected: [],
      dependentsAffected: [],
      migrationRequired: false,
    },
    status: "draft",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as ProposalDefinition;
}

/** Code-gen provider spy returning a fixed source (or throwing). Records call count. */
export function makeProvider(opts: { source?: string; throws?: boolean } = {}): {
  provider: CodeGenerationProvider;
  calls: { count: number };
} {
  const calls = { count: 0 };
  const provider: CodeGenerationProvider = {
    async generateCode() {
      calls.count += 1;
      if (opts.throws) throw new Error("model exploded");
      return opts.source ?? GOOD;
    },
  };
  return { provider, calls };
}

/** A gate that passes everything (no Bun transpiler dependency in unit tests). */
export const PASS_GATE: QualityGateRunner = { check: async () => [] };

/** Engine fake that mirrors the real draft-only `updateProposal` contract. */
export function makeEngine(proposal: ProposalDefinition | undefined): {
  engine: MaterializeEngine;
  updates: Array<{ id: string; changes?: ProposalChange[] }>;
} {
  const updates: Array<{ id: string; changes?: ProposalChange[] }> = [];
  let current = proposal;
  const engine: MaterializeEngine = {
    getProposal(id) {
      if (!current || current.id !== id) throw new Error(`Proposal "${id}" not found`);
      return current;
    },
    updateProposal(id, u) {
      if (!current || current.id !== id) throw new Error(`Proposal "${id}" not found`);
      if (current.status !== "draft") {
        throw new Error(`Cannot update proposal "${id}": expected status "draft"`);
      }
      updates.push({ id, changes: u.changes });
      current = { ...current, changes: u.changes ?? current.changes };
      return current;
    },
  };
  return { engine, updates };
}
