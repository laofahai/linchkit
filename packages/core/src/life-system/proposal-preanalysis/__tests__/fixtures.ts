/**
 * Shared test fixtures for proposal-preanalysis tests.
 */

import type {
  ProposalAuthor,
  ProposalChange,
  ProposalDefinition,
  ProposalImpact,
  ProposalStatus,
} from "../../../types/proposal";

const DEFAULT_AUTHOR: ProposalAuthor = { type: "human", id: "u1", name: "Test" };

const DEFAULT_IMPACT: ProposalImpact = {
  schemasAffected: [],
  actionsAffected: [],
  rulesAffected: [],
  dependentsAffected: [],
  migrationRequired: false,
};

export interface MakeProposalOptions {
  id?: string;
  status?: ProposalStatus;
  changes?: ProposalChange[];
  capability?: string;
}

export function makeProposal(opts: MakeProposalOptions = {}): ProposalDefinition {
  const id = opts.id ?? "prop_test";
  const changes: ProposalChange[] = opts.changes ?? [
    {
      target: "entity",
      operation: "update",
      name: "purchase_request",
      diff: "add priority field",
    },
  ];
  return {
    id,
    title: `Proposal ${id}`,
    description: "test proposal",
    author: DEFAULT_AUTHOR,
    capability: opts.capability ?? "purchase_management",
    changeType: "minor",
    changes,
    impact: { ...DEFAULT_IMPACT },
    status: opts.status ?? "draft",
    createdAt: new Date("2026-04-23T00:00:00Z"),
    updatedAt: new Date("2026-04-23T00:00:00Z"),
  };
}
