import { describe, expect, it } from "bun:test";
import type { CreateProposalOptions, ProposalEngine } from "../src";
import {
  bumpVersion,
  createProposalEngine,
  validatePhase1,
  validateProposal,
} from "../src/server-entry";

// ── Test fixtures ───────────────────────────────────────

const baseProposalOptions: CreateProposalOptions = {
  title: "Add product schema",
  description: "Add a product schema with name, price, and category fields",
  author: { type: "human", id: "user-1", name: "Alice" },
  capability: "inventory_management",
  changeType: "minor",
  changes: [
    {
      target: "entity",
      operation: "create",
      name: "product",
      definition: {
        name: "product",
        label: "Product",
        fields: {
          name: { type: "string", required: true, default: "", label: "Name" },
          price: { type: "number", required: true, default: 0, label: "Price" },
          category: {
            type: "enum",
            label: "Category",
            options: [
              { value: "electronics", label: "Electronics" },
              { value: "clothing", label: "Clothing" },
            ],
          },
        },
      },
    },
  ],
};

function createTestEngine(): ProposalEngine {
  return createProposalEngine();
}

// ── ProposalEngine: createProposal ──────────────────────

describe("ProposalEngine.createProposal", () => {