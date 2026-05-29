import { describe, expect, it } from "bun:test";
import {
  createProposalGitCommitter,
  type ProposalGhRunner,
  type ProposalGitCommitterRunResult,
  type ProposalGitRunner,
} from "../../engine/proposal-git-committer";
import { ROLLBACK_CANDIDATE_TAG } from "../../engine/rollback-insight-emitter";
import { validateProposal } from "../../engine/validation-engine";
import {
  createDefaultInsightTranslatorRegistry,
  createInsightTranslatorRegistry,
  insightTranslatorKey,
  rollbackCandidateTranslator,
  schemaNoViewTranslator,
} from "../../life-system/insight-to-proposal";
import type { Insight } from "../../types/life-system";
import type { ProposalDefinition } from "../../types/proposal";
import type { ViewDefinition } from "../../types/view";

const FROZEN_NOW = new Date("2026-05-07T00:00:00.000Z");

const makeStructuralInsight = (overrides: Partial<Insight> = {}): Insight => ({
  id: "insight_1",
  type: "structural",
  confidence: 1.0,
  impact: "low",
  evidence: {
    signals: [],
    context: { kind: "schema_no_view", target: undefined },
  },
  summary: 'Schema "purchase_request" has no view defined.',
  causality: "structural",
  entity: "purchase_request",
  createdAt: FROZEN_NOW,
  ...overrides,
});

/**
 * Fixture mirroring RollbackInsightEmitter's output: a `type:"anomaly"` insight
 * tagged `rollback_candidate` carrying the failed-proposal evidence context.
 */
const makeRollbackInsight = (overrides: Partial<Insight> = {}): Insight => ({
  id: "rollback-insight:proposal_abc",
  type: "anomaly",
  confidence: 0.9,
  impact: "high",
  evidence: {
    signals: [],
    context: {
      proposalId: "proposal_abc",
      capability: "cap-life-demo",
      signalRef: "purchase_request:approval_latency",
      baselineValue: 120,
      targetValue: 60,
      currentValue: 180,
    },
  },
  summary:
    'Merged proposal "proposal_abc" on capability "cap-life-demo" failed its successMetric. Rollback candidate.',
  causality: "causal",
  entity: "cap-life-demo",
  createdAt: FROZEN_NOW,
  tags: [ROLLBACK_CANDIDATE_TAG],
  ...overrides,
});

describe("insightTranslatorKey", () => {
  it("builds structural keys from evidence.context.kind", () => {
    const insight = makeStructuralInsight();
    expect(insightTranslatorKey(insight)).toBe("structural:schema_no_view");
  });

  it("falls back to a sentinel when structural kind is missing", () => {
    const insight = makeStructuralInsight({
      evidence: { signals: [], context: {} },
    });
    expect(insightTranslatorKey(insight)).toBe("structural:unknown");
  });

  it("uses bare insight type for non-structural insights", () => {
    const insight: Insight = {
      ...makeStructuralInsight(),
      type: "anomaly",
      causality: "correlational",
    };
    expect(insightTranslatorKey(insight)).toBe("anomaly");
  });

  it("routes rollback_candidate-tagged anomalies to a dedicated key", () => {
    const insight = makeRollbackInsight();
    expect(insightTranslatorKey(insight)).toBe("anomaly:rollback_candidate");
  });

  it("does NOT hijack ordinary anomaly insights that lack the tag (regression guard)", () => {
    // Same anomaly shape, but no rollback_candidate tag — must stay bare.
    const untagged = makeRollbackInsight({ tags: ["something_else"] });
    expect(insightTranslatorKey(untagged)).toBe("anomaly");

    const noTags = makeRollbackInsight({ tags: undefined });
    expect(insightTranslatorKey(noTags)).toBe("anomaly");
  });
});

describe("schemaNoViewTranslator", () => {
  it("emits an add-view ProposalDefinition tracing back to the insight", async () => {
    const insight = makeStructuralInsight();
    const proposal = await schemaNoViewTranslator(insight, {
      now: () => FROZEN_NOW,
      idGenerator: () => "proposal_test_1",
    });

    expect(proposal).not.toBeNull();
    if (!proposal) throw new Error("expected proposal");

    expect(proposal.id).toBe("proposal_test_1");
    expect(proposal.status).toBe("draft");
    expect(proposal.changeType).toBe("minor");
    expect(proposal.capability).toBe("evolution");
    expect(proposal.author).toEqual({
      type: "ai",
      id: "insight-translator",
      name: "Insight Translator",
    });
    expect(proposal.createdAt).toBe(FROZEN_NOW);
    expect(proposal.updatedAt).toBe(FROZEN_NOW);
    expect(proposal.description).toBe(insight.summary);
    expect(proposal.title).toContain("purchase_request");

    expect(proposal.changes).toHaveLength(1);
    const change = proposal.changes[0];
    if (!change) throw new Error("expected one change");
    expect(change.target).toBe("view");
    expect(change.operation).toBe("create");
    expect(change.name).toBe("purchase_request_default_list");

    const def = change.definition as ViewDefinition;
    expect(def.entity).toBe("purchase_request");
    expect(def.type).toBe("list");
    expect(Array.isArray(def.fields)).toBe(true);

    expect(proposal.impact.schemasAffected).toEqual(["purchase_request"]);
    expect(proposal.impact.migrationRequired).toBe(false);

    // Evidence is attached as a sidecar that traces back to the insight.
    const sidecar = (proposal as unknown as { evidence: { context: Record<string, unknown> } })
      .evidence;
    expect(sidecar).toBeDefined();
    expect(sidecar.context.insightId).toBe(insight.id);
    expect(sidecar.context.kind).toBe("schema_no_view");
  });

  it("returns null for non-structural insights", async () => {
    const insight: Insight = {
      ...makeStructuralInsight(),
      type: "anomaly",
      causality: "correlational",
    };
    const result = await schemaNoViewTranslator(insight, {});
    expect(result).toBeNull();
  });

  it("returns null when structural kind is not schema_no_view", async () => {
    const insight = makeStructuralInsight({
      evidence: { signals: [], context: { kind: "rule_never_triggered" } },
    });
    const result = await schemaNoViewTranslator(insight, {});
    expect(result).toBeNull();
  });

  it("does not mutate the originating insight evidence", async () => {
    const original = makeStructuralInsight();
    const beforeContext = { ...original.evidence.context };
    await schemaNoViewTranslator(original, {});
    expect(original.evidence.context).toEqual(beforeContext);
    // Translator-side context mutation must not have leaked back.
    expect((original.evidence.context as { insightId?: string }).insightId).toBeUndefined();
  });
});

describe("rollbackCandidateTranslator", () => {
  it("emits a draft/major rollback proposal with an inverse successMetric", async () => {
    const insight = makeRollbackInsight();
    const proposal = await rollbackCandidateTranslator(insight, {
      now: () => FROZEN_NOW,
      idGenerator: () => "proposal_rollback_1",
    });

    expect(proposal).not.toBeNull();
    if (!proposal) throw new Error("expected proposal");

    expect(proposal.id).toBe("proposal_rollback_1");
    expect(proposal.status).toBe("draft");
    expect(proposal.changeType).toBe("major");
    // Capability is resolved from evidence, not the default.
    expect(proposal.capability).toBe("cap-life-demo");
    expect(proposal.author).toEqual({
      type: "ai",
      id: "rollback-translator",
      name: "Rollback Translator",
    });
    expect(proposal.createdAt).toBe(FROZEN_NOW);
    expect(proposal.updatedAt).toBe(FROZEN_NOW);
    expect(proposal.description).toBe(insight.summary);
    expect(proposal.title).toContain("proposal_abc");
    expect(proposal.title).toContain("cap-life-demo");

    // Single revert change with a fixed, validation-safe name. The target
    // proposalId is carried out-of-band (diff + evidence sidecar), not in `name`.
    expect(proposal.changes).toHaveLength(1);
    const change = proposal.changes[0];
    if (!change) throw new Error("expected one change");
    expect(change.target).toBe("revert");
    expect(change.operation).toBe("update");
    expect(change.name).toBe("revert");
    // The proposalId being reverted survives in the human-readable diff.
    expect(change.diff).toContain("proposal_abc");
    // A revert carries no definition file.
    expect(change.definition).toBeUndefined();

    // INVERSE successMetric: baseline = regressed current, target = pre-merge baseline.
    expect(proposal.successMetric).toBeDefined();
    expect(proposal.successMetric?.insightRef).toBe(insight.id);
    expect(proposal.successMetric?.signalRef).toBe("purchase_request:approval_latency");
    expect(proposal.successMetric?.baselineValue).toBe(180); // was currentValue
    expect(proposal.successMetric?.targetValue).toBe(120); // was baselineValue

    // Conservative impact — only the reverted capability is re-affected.
    expect(proposal.impact.dependentsAffected).toEqual(["cap-life-demo"]);
    expect(proposal.impact.migrationRequired).toBe(false);

    // Evidence sidecar traces back to the insight and the proposal being reverted.
    // It mirrors schemaNoViewTranslator: provenance nested under `.context` and
    // the sidecar enumerable so JSON.stringify / the git committer can read it.
    const sidecar = (
      proposal as unknown as {
        evidence: {
          context: {
            revertProposalId: string;
            insightId: string;
            capability: string;
            signalRef: string;
          };
        };
      }
    ).evidence;
    expect(sidecar).toBeDefined();
    expect(sidecar.context.revertProposalId).toBe("proposal_abc");
    expect(sidecar.context.insightId).toBe(insight.id);
    expect(sidecar.context.capability).toBe("cap-life-demo");
    expect(sidecar.context.signalRef).toBe("purchase_request:approval_latency");

    // Enumerability parity with schemaNoViewTranslator: the sidecar survives a
    // JSON round-trip (a non-enumerable sidecar would be silently dropped).
    const roundTripped = JSON.parse(JSON.stringify(proposal)) as {
      evidence?: { context?: { insightId?: string } };
    };
    expect(roundTripped.evidence?.context?.insightId).toBe(insight.id);
  });

  it("honours ctx.now and ctx.idGenerator overrides (frozen-clock determinism)", async () => {
    const altNow = new Date("2030-01-01T00:00:00.000Z");
    const proposal = await rollbackCandidateTranslator(makeRollbackInsight(), {
      now: () => altNow,
      idGenerator: () => "proposal_frozen",
    });
    if (!proposal) throw new Error("expected proposal");
    expect(proposal.id).toBe("proposal_frozen");
    expect(proposal.createdAt).toBe(altNow);
    expect(proposal.updatedAt).toBe(altNow);
  });

  it("declines (null) for an anomaly WITHOUT the rollback_candidate tag", async () => {
    const untagged = makeRollbackInsight({ tags: ["other"] });
    expect(await rollbackCandidateTranslator(untagged, {})).toBeNull();
  });

  it("declines (null) when evidence.context.proposalId is missing", async () => {
    const missing = makeRollbackInsight({
      evidence: {
        signals: [],
        context: { capability: "cap-life-demo", signalRef: "x" },
      },
    });
    expect(await rollbackCandidateTranslator(missing, {})).toBeNull();
  });

  it("declines (null) when evidence.context.proposalId is an empty string", async () => {
    const empty = makeRollbackInsight({
      evidence: {
        signals: [],
        context: { proposalId: "", capability: "cap-life-demo" },
      },
    });
    expect(await rollbackCandidateTranslator(empty, {})).toBeNull();
  });

  it("declines (null) for a non-anomaly insight even if tagged", async () => {
    const structuralTagged = makeStructuralInsight({ tags: [ROLLBACK_CANDIDATE_TAG] });
    expect(await rollbackCandidateTranslator(structuralTagged, {})).toBeNull();
  });

  it("does NOT throw and declines (null) for a malformed insight with undefined/null evidence", async () => {
    // FINDING 1 regression guard: runtime Insights (deserialized from storage,
    // or malformed) may carry an undefined/null `evidence` despite the type
    // saying it is required. The translator must access it defensively and
    // decline rather than throw a TypeError.
    const undefinedEvidence = makeRollbackInsight({
      evidence: undefined,
    } as unknown as Partial<Insight>);
    let result: unknown;
    expect(() => {
      result = rollbackCandidateTranslator(undefinedEvidence, {});
    }).not.toThrow();
    expect(await result).toBeNull();

    const nullEvidence = makeRollbackInsight({
      evidence: null,
    } as unknown as Partial<Insight>);
    expect(() => rollbackCandidateTranslator(nullEvidence, {})).not.toThrow();
    expect(await rollbackCandidateTranslator(nullEvidence, {})).toBeNull();
  });

  it("falls back to insight.entity for capability when context.capability is absent", async () => {
    // FINDING 2: a rollback must target the capability that owns the regressed
    // proposal. When evidence.context.capability is missing/empty, the fallback
    // prefers the insight's own entity over the generic DEFAULT_CAPABILITY.
    const insight = makeRollbackInsight({
      entity: "cap-purchase",
      evidence: {
        signals: [],
        // No `capability` key — forces the fallback chain.
        context: { proposalId: "proposal_abc", signalRef: "x" },
      },
    });
    const proposal = await rollbackCandidateTranslator(insight, {
      now: () => FROZEN_NOW,
      idGenerator: () => "proposal_rollback_entity",
    });
    if (!proposal) throw new Error("expected proposal");

    // Resolved from insight.entity, NOT the "evolution" default nor ctx override.
    expect(proposal.capability).toBe("cap-purchase");
    expect(proposal.impact.dependentsAffected).toEqual(["cap-purchase"]);
    expect(proposal.title).toContain("cap-purchase");
    expect(proposal.changes[0]?.diff).toContain("cap-purchase");

    const sidecar = (proposal as unknown as { evidence: { context: { capability: string } } })
      .evidence;
    expect(sidecar.context.capability).toBe("cap-purchase");
  });

  it("produces a draft that PASSES validateProposal() (reaches the approval gate)", async () => {
    // FINDING 1 regression guard: the draft revert Proposal must survive Phase-1
    // validation, otherwise submitProposal() never sets status "validated" and
    // approveProposal() can never run — freezing the draft forever. The fixed
    // valid `name` plus the revert MISSING_DEFINITION skip make this pass.
    const proposal = await rollbackCandidateTranslator(makeRollbackInsight(), {
      now: () => FROZEN_NOW,
      idGenerator: () => "proposal_rollback_validate",
    });
    if (!proposal) throw new Error("expected proposal");

    const result = validateProposal({ proposal });
    // No phase may report an error.
    expect(result.passed).toBe(true);
    const allErrors = result.phases.flatMap((p) => p.errors);
    expect(allErrors).toEqual([]);
    // Governance safety is untouched — the translator still emits a draft.
    expect(proposal.status).toBe("draft");
  });

  it("stamps revertSha on the revert change from evidence.context.mergedSha", async () => {
    // Slice B: the merged commit SHA threaded end-to-end (committer → outcome →
    // effect-verifier → rollback Insight) lands on the typed revertSha field so a
    // rollback executor can `git revert` the EXACT commit, not just name the proposal.
    const sha = "abc1234def5678";
    const insight = makeRollbackInsight({
      evidence: {
        signals: [],
        context: {
          proposalId: "proposal_abc",
          capability: "cap-life-demo",
          signalRef: "purchase_request:approval_latency",
          baselineValue: 120,
          targetValue: 60,
          currentValue: 180,
          mergedSha: sha,
        },
      },
    });
    const proposal = await rollbackCandidateTranslator(insight, {
      now: () => FROZEN_NOW,
      idGenerator: () => "proposal_rollback_sha",
    });
    if (!proposal) throw new Error("expected proposal");

    const change = proposal.changes[0];
    if (!change) throw new Error("expected one change");
    expect(change.revertSha).toBe(sha);
    // The SHA also surfaces in the human-readable diff for reviewers.
    expect(change.diff).toContain(sha);
    // ...and is mirrored on the evidence sidecar for provenance.
    const sidecar = (proposal as unknown as { evidence: { context: { revertSha?: string } } })
      .evidence;
    expect(sidecar.context.revertSha).toBe(sha);
    // Governance unchanged — stamping a SHA never auto-executes anything.
    expect(proposal.status).toBe("draft");
  });

  it("omits revertSha when evidence carries no mergedSha (still a valid draft)", async () => {
    // The upstream chain may lack a SHA (out-of-band merge / pre-SHA-capture).
    // The draft must still be produced, just without the optional revertSha.
    const proposal = await rollbackCandidateTranslator(makeRollbackInsight(), {
      now: () => FROZEN_NOW,
      idGenerator: () => "proposal_rollback_no_sha",
    });
    if (!proposal) throw new Error("expected proposal");

    const change = proposal.changes[0];
    if (!change) throw new Error("expected one change");
    // Absent rather than an empty string, so consumers can branch on undefined.
    expect(change.revertSha).toBeUndefined();
    expect("revertSha" in change).toBe(false);
    expect(proposal.status).toBe("draft");
  });

  it("ignores a non-string/empty mergedSha (no revertSha stamped)", async () => {
    for (const bad of ["", 12345, null]) {
      const insight = makeRollbackInsight({
        evidence: {
          signals: [],
          context: { proposalId: "proposal_abc", capability: "cap-life-demo", mergedSha: bad },
        },
      });
      const proposal = await rollbackCandidateTranslator(insight, {
        idGenerator: () => "proposal_rollback_bad_sha",
      });
      if (!proposal) throw new Error("expected proposal");
      expect(proposal.changes[0]?.revertSha).toBeUndefined();
    }
  });
});

describe("InsightTranslatorRegistry", () => {
  it("translates via the registered translator", async () => {
    const registry = createInsightTranslatorRegistry();
    registry.register("structural:schema_no_view", schemaNoViewTranslator);

    const insight = makeStructuralInsight();
    const result = await registry.translate(insight);
    expect(result).not.toBeNull();
    expect(result?.changes[0]?.target).toBe("view");
  });

  it("returns null for unsupported insight kinds without throwing", async () => {
    const registry = createInsightTranslatorRegistry();
    registry.register("structural:schema_no_view", schemaNoViewTranslator);

    const unsupported = makeStructuralInsight({
      id: "insight_unsupported",
      evidence: { signals: [], context: { kind: "field_constant_value" } },
      summary: "Field is always the same value.",
    });
    const result = await registry.translate(unsupported);
    expect(result).toBeNull();
  });

  it("supports register / unregister / has / keys", () => {
    const registry = createInsightTranslatorRegistry();
    expect(registry.has("structural:schema_no_view")).toBe(false);

    registry.register("structural:schema_no_view", schemaNoViewTranslator);
    expect(registry.has("structural:schema_no_view")).toBe(true);
    expect(registry.keys()).toContain("structural:schema_no_view");

    registry.unregister("structural:schema_no_view");
    expect(registry.has("structural:schema_no_view")).toBe(false);
  });

  it("default registry is pre-loaded with the structural schema_no_view translator", async () => {
    const registry = createDefaultInsightTranslatorRegistry();
    expect(registry.has("structural:schema_no_view")).toBe(true);

    const insight = makeStructuralInsight();
    const result = await registry.translate(insight, {
      now: () => FROZEN_NOW,
      idGenerator: () => "proposal_default_1",
    });
    expect(result?.id).toBe("proposal_default_1");
  });

  it("default registry round-trips a rollback_candidate insight to a draft rollback proposal", async () => {
    const registry = createDefaultInsightTranslatorRegistry();
    expect(registry.has("anomaly:rollback_candidate")).toBe(true);

    const rollbackInsight = makeRollbackInsight();
    const result = await registry.translate(rollbackInsight, {
      now: () => FROZEN_NOW,
      idGenerator: () => "proposal_rollback_default",
    });

    expect(result).not.toBeNull();
    expect(result?.id).toBe("proposal_rollback_default");
    expect(result?.status).toBe("draft");
    expect(result?.changeType).toBe("major");
    expect(result?.changes[0]?.target).toBe("revert");
    expect(result?.changes[0]?.name).toBe("revert");
    expect(result?.successMetric?.insightRef).toBe(rollbackInsight.id);
  });

  it("a translator that returns null does not throw and propagates null", async () => {
    const registry = createInsightTranslatorRegistry();
    registry.register("structural:schema_no_view", () => null);
    const insight = makeStructuralInsight();
    const result = await registry.translate(insight);
    expect(result).toBeNull();
  });
});

describe("rollback proposal provenance (committer path)", () => {
  // FINDING 2 regression guard: ProposalGitCommitter.readSourceInsights reads
  // `evidence.context.insightId`. The rollback sidecar must nest under `.context`
  // (enumerable) so the source insight is preserved in the commit/PR metadata.
  const ok = (stdout = ""): ProposalGitCommitterRunResult => ({ stdout, stderr: "", exitCode: 0 });
  const absent = (): ProposalGitCommitterRunResult => ({
    stdout: "",
    stderr: "not found",
    exitCode: 1,
  });

  it("recovers the source insight id from the sidecar into the commit + PR body", async () => {
    const insight = makeRollbackInsight();
    const draft = await rollbackCandidateTranslator(insight, {
      now: () => FROZEN_NOW,
      idGenerator: () => "proposal_rollback_committer",
    });
    if (!draft) throw new Error("expected proposal");
    // The committer only acts on an approved proposal; flip status for the test.
    const proposal: ProposalDefinition = { ...draft, status: "approved" };
    // The non-enumerable→enumerable sidecar is defined via Object.defineProperty,
    // so the object spread above does NOT copy it — re-attach it onto the copy.
    Object.defineProperty(proposal, "evidence", {
      value: (draft as unknown as { evidence: unknown }).evidence,
      enumerable: true,
      writable: false,
      configurable: false,
    });

    let capturedCommitMessage = "";
    let capturedPrBody = "";
    const gitRunner: ProposalGitRunner = async (args) => {
      // Report both branch-existence probes as "absent" so the flow proceeds.
      if (args[0] === "rev-parse" && args[1] === "--verify") return absent();
      if (args[0] === "ls-remote") return absent();
      if (args[0] === "rev-parse" && args[1] === "HEAD") return ok("deadbeef\n");
      if (args[0] === "commit") {
        const idx = args.indexOf("-m");
        capturedCommitMessage = idx >= 0 ? (args[idx + 1] ?? "") : "";
      }
      return ok();
    };
    const ghRunner: ProposalGhRunner = async (args) => {
      const idx = args.indexOf("--body");
      capturedPrBody = idx >= 0 ? (args[idx + 1] ?? "") : "";
      return ok("https://github.com/acme/linchkit/pull/123\n");
    };

    const committer = createProposalGitCommitter({ rootDir: "/repo", gitRunner, ghRunner });
    await committer.commitAndOpenPR(proposal, ["/repo/file.ts"]);

    // The originating insight id flows into both the commit trailer and PR body,
    // proving provenance survived the (now nested + enumerable) sidecar.
    expect(capturedCommitMessage).toContain(`Source-Insights: ${insight.id}`);
    expect(capturedPrBody).toContain(insight.id);
  });
});
