/**
 * Conflict analyzer — Spec 55 §7.3 stage 2.
 *
 * Detects contradictions between a candidate Proposal and the surrounding
 * environment so a reviewer can be warned before the proposal is approved.
 *
 * Three conflict sources are checked, each opt-in via the corresponding option:
 *
 *   1. proposal-vs-proposal — another pending proposal already targets the same
 *      `(change.target, change.name)` artifact with non-empty changes.
 *   2. proposal-vs-rule — the candidate proposes a Rule whose `name` collides
 *      with an existing live Rule (the proposed rule would replace it).
 *   3. proposal-vs-state — the candidate proposes a State definition update that
 *      removes a state still referenced by an existing transition's `from`/`to`,
 *      which would invalidate the live transition.
 *
 * Design rules:
 *   - Each source is checked independently. A failure in one source is captured
 *     into `notes` and the analyzer keeps going — never throws from `analyze`.
 *   - The analyzer is side-effect-free and only reads from the supplied stores.
 *   - Heuristics are deliberately simple. Where a target shape doesn't expose
 *     enough info to detect a clean conflict (e.g. `definition` may be undefined
 *     on `update` operations) the analyzer documents the limitation in `notes`
 *     instead of guessing.
 */

import type {
  ProposalChange,
  ProposalChangeTarget,
  ProposalDefinition,
} from "../../types/proposal";
import type { RuleDefinition } from "../../types/rule";
import type { StateDefinition, Transition } from "../../types/state";
import type { ConflictFinding, ConflictResult, PendingProposalStore, PreAnalyzer } from "./types";

/** Read-only view over the live Rule registry. Sync or async. */
export interface LiveRuleStore {
  listRules(): Promise<RuleDefinition[]> | RuleDefinition[];
}

/** Read-only view over the live State-definition registry. Sync or async. */
export interface LiveStateStore {
  listStates(): Promise<StateDefinition[]> | StateDefinition[];
}

export interface CreateConflictAnalyzerOptions {
  /** Pending peers to check for proposal-vs-proposal conflicts. */
  pendingProposals: PendingProposalStore;
  /** Optional read-only registry of currently-active rules. */
  liveRules?: LiveRuleStore;
  /** Optional read-only registry of currently-active state definitions. */
  liveStates?: LiveStateStore;
  /**
   * Optional override for which proposal statuses count as "pending review".
   * Defaults to `draft|validating|validated` (matches Spec 55).
   */
  pendingStatuses?: ReadonlySet<string>;
}

/** Status values considered "pending" when a store returns all proposals. */
const DEFAULT_PENDING_STATUSES: ReadonlySet<string> = new Set(["draft", "validating", "validated"]);

/** Pluralize the source name for the error/skip note. */
function describeSource(source: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `${source}: ${msg}`;
}

/** Build a stable artifact key for proposal-vs-proposal grouping. */
function artifactKey(change: ProposalChange): string {
  return `${change.target}:${change.name}`;
}

/** A change is "non-empty" when it has either a definition or a diff payload. */
function isNonEmptyChange(change: ProposalChange): boolean {
  return change.definition !== undefined || (change.diff !== undefined && change.diff !== "");
}

/** Collect every artifact this proposal touches, keyed by `target:name`. */
function collectArtifacts(proposal: ProposalDefinition): Map<string, ProposalChange[]> {
  const out = new Map<string, ProposalChange[]>();
  for (const change of proposal.changes) {
    if (!change.name) continue;
    if (!isNonEmptyChange(change)) continue;
    const key = artifactKey(change);
    const bucket = out.get(key);
    if (bucket) {
      bucket.push(change);
    } else {
      out.set(key, [change]);
    }
  }
  return out;
}

/** Filter rule-target changes from the candidate. */
function ruleChanges(proposal: ProposalDefinition): ProposalChange[] {
  return proposal.changes.filter((c) => c.target === "rule" && c.operation !== "delete" && c.name);
}

/** Filter state-target update/delete changes (creates can't invalidate transitions). */
function stateChanges(proposal: ProposalDefinition): ProposalChange[] {
  return proposal.changes.filter(
    (c) => c.target === "state" && (c.operation === "update" || c.operation === "delete") && c.name,
  );
}

/** Try to read a `StateDefinition`-shaped object out of an unknown change definition. */
function readStateDefinition(value: unknown): StateDefinition | null {
  if (!value || typeof value !== "object") return null;
  const def = value as Partial<StateDefinition>;
  if (!Array.isArray(def.states)) return null;
  if (typeof def.name !== "string") return null;
  return def as StateDefinition;
}

/** Collect every state name referenced by a transition's `from` or `to`. */
function statesReferencedByTransition(transition: Transition): string[] {
  const refs: string[] = [];
  if (Array.isArray(transition.from)) {
    refs.push(...transition.from);
  } else if (typeof transition.from === "string") {
    refs.push(transition.from);
  }
  if (typeof transition.to === "string") {
    refs.push(transition.to);
  }
  return refs;
}

export function createConflictAnalyzer(
  options: CreateConflictAnalyzerOptions,
): PreAnalyzer<"conflict", ConflictResult> {
  const pendingStatuses = options.pendingStatuses ?? DEFAULT_PENDING_STATUSES;

  return {
    stage: "conflict",
    name: "default-conflict-analyzer",
    async analyze(proposal: ProposalDefinition): Promise<ConflictResult> {
      const conflicts: ConflictFinding[] = [];
      const noteFragments: string[] = [];
      const sourcesChecked: string[] = [];

      const candidateArtifacts = collectArtifacts(proposal);

      // ── 1. proposal-vs-proposal ────────────────────────────
      sourcesChecked.push("pendingProposals");
      try {
        const peers = await options.pendingProposals.listPending();
        for (const peer of peers) {
          if (peer.id === proposal.id) continue;
          if (!pendingStatuses.has(peer.status)) continue;

          const peerArtifacts = collectArtifacts(peer);
          for (const [key, peerChanges] of peerArtifacts) {
            const candidateChanges = candidateArtifacts.get(key);
            if (!candidateChanges || candidateChanges.length === 0) continue;
            // Both proposals touch the same artifact with payload — emit one
            // finding per (peer, artifact) pair so reviewers can see the breakdown.
            const [target, name] = splitArtifactKey(key);
            conflicts.push({
              kind: "proposal",
              targetId: peer.id,
              message: `Pending proposal "${peer.title}" (${peer.id}) also modifies ${target} "${name}" (${peerChanges.length} change(s))`,
            });
          }
        }
      } catch (err) {
        noteFragments.push(describeSource("pendingProposals", err));
      }

      // ── 2. proposal-vs-rule ────────────────────────────────
      const proposedRules = ruleChanges(proposal);
      if (options.liveRules && proposedRules.length > 0) {
        sourcesChecked.push("liveRules");
        try {
          const rules = await options.liveRules.listRules();
          const byName = new Map<string, RuleDefinition>();
          for (const r of rules) byName.set(r.name, r);

          for (const change of proposedRules) {
            const existing = byName.get(change.name);
            if (!existing) continue;
            conflicts.push({
              kind: "rule",
              targetId: existing.name,
              message: `Proposed rule "${change.name}" would replace existing live rule with the same name`,
            });
          }
        } catch (err) {
          noteFragments.push(describeSource("liveRules", err));
        }
      } else if (proposedRules.length > 0 && !options.liveRules) {
        noteFragments.push("liveRules: store not provided — skipped rule conflict checks");
      }

      // ── 3. proposal-vs-state ───────────────────────────────
      const proposedStates = stateChanges(proposal);
      if (options.liveStates && proposedStates.length > 0) {
        sourcesChecked.push("liveStates");
        try {
          const states = await options.liveStates.listStates();
          const byName = new Map<string, StateDefinition>();
          for (const s of states) byName.set(s.name, s);

          for (const change of proposedStates) {
            const existing = byName.get(change.name);
            if (!existing) continue;

            if (change.operation === "delete") {
              // Whole state-machine is being removed — every existing transition
              // referencing it becomes invalid by definition.
              if (existing.transitions.length > 0) {
                conflicts.push({
                  kind: "state_transition",
                  targetId: existing.name,
                  message: `Deleting state machine "${change.name}" would invalidate ${existing.transitions.length} live transition(s)`,
                });
              }
              continue;
            }

            // operation === "update": inspect proposed states against live transitions.
            const proposed = readStateDefinition(change.definition);
            if (!proposed) {
              // Update with no parsable definition — can't check; record so the
              // reviewer knows we couldn't analyze this change.
              noteFragments.push(
                `liveStates: skipped "${change.name}" — update definition missing or malformed`,
              );
              continue;
            }

            const proposedStateSet = new Set(proposed.states);
            const removed: string[] = [];
            for (const liveState of existing.states) {
              if (!proposedStateSet.has(liveState)) removed.push(liveState);
            }
            if (removed.length === 0) continue;

            for (const transition of existing.transitions) {
              const refs = statesReferencedByTransition(transition);
              const dropped = refs.filter((r) => removed.includes(r));
              if (dropped.length === 0) continue;
              conflicts.push({
                kind: "state_transition",
                targetId: existing.name,
                message: `Proposed update to state machine "${change.name}" removes state(s) [${dropped.join(", ")}] still used by transition action "${transition.action}"`,
              });
            }
          }
        } catch (err) {
          noteFragments.push(describeSource("liveStates", err));
        }
      } else if (proposedStates.length > 0 && !options.liveStates) {
        noteFragments.push("liveStates: store not provided — skipped state conflict checks");
      }

      const result: ConflictResult = { conflicts };
      if (noteFragments.length > 0) {
        result.notes = `checked: ${sourcesChecked.join(", ")}; ${noteFragments.join("; ")}`;
      } else {
        result.notes = `checked: ${sourcesChecked.join(", ") || "none"}`;
      }
      return result;
    },
  };
}

/** Inverse of `artifactKey`. The `target` is always one segment; `name` may contain colons. */
function splitArtifactKey(key: string): [ProposalChangeTarget, string] {
  const idx = key.indexOf(":");
  if (idx === -1) return [key as ProposalChangeTarget, ""];
  return [key.slice(0, idx) as ProposalChangeTarget, key.slice(idx + 1)];
}
