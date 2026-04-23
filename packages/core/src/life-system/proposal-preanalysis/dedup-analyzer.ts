/**
 * Dedup analyzer — Spec 55 §7.3 stage 1.
 *
 * Compares a candidate Proposal against the current pending-proposal set and
 * returns near-matches plus an exact match (if any). Structural equality is
 * defined over `(target_entity, change_kind, payload_hash)` per the spec.
 *
 * Algorithm notes:
 *   - "similar" = same target entity + same change operation + same payload hash
 *     on at least one change entry. Many proposals mutate only one artifact so
 *     this is tight in practice.
 *   - "exactMatch" = same change-set cardinality AND every (target, operation, hash)
 *     tuple in the candidate is present in the other proposal. This avoids a false
 *     positive when a candidate is a proper subset of a larger pending proposal.
 *   - Hashing is FNV-1a over a stable JSON serialization of the change entry.
 *     Cheap, dependency-free, collision rate is acceptable for this use case.
 */

import type { ProposalChange, ProposalDefinition } from "../../types/proposal";
import type { DedupResult, PendingProposalStore, PreAnalyzer } from "./types";

/**
 * Stable stringify — produces a canonical JSON string so logically-equal
 * payloads hash identically. Delegates to `JSON.stringify` with a replacer so
 * we inherit its handling of `undefined` (omitted from objects, becomes `null`
 * inside arrays) instead of rolling our own and diverging.
 *
 * - Plain objects: entries sorted by key. Entries whose value is `undefined`
 *   are dropped (matches JSON.stringify, avoids spurious "key":undefined in
 *   manual template-string paths).
 * - Arrays: natural order preserved. `[undefined]` and `[]` serialize
 *   differently because the replacer returns `null` for undefined inside
 *   arrays (JSON.stringify default behavior).
 * - `Date` instances: emitted as ISO-8601 strings so two different timestamps
 *   never collide to the same "{}" the way the previous impl did.
 */
function stableStringify(value: unknown): string {
  const replacer = (_key: string, v: unknown): unknown => {
    if (v instanceof Date) return v.toISOString();
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const entries = Object.entries(v as Record<string, unknown>).filter(
        ([, val]) => val !== undefined,
      );
      entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return Object.fromEntries(entries);
    }
    return v;
  };
  return JSON.stringify(value, replacer);
}

/** FNV-1a 32-bit hash, rendered as 8-char lowercase hex. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // Prime multiplication with 32-bit wrap.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Per-change fingerprint (target entity + operation + payload hash). */
interface ChangeFingerprint {
  target: string;
  operation: string;
  hash: string;
}

function fingerprintChange(change: ProposalChange): ChangeFingerprint {
  // `name` disambiguates by artifact identity; `definition` + `diff` captures
  // the payload shape. Both are included so renames and semantic changes differ.
  const payload = {
    name: change.name,
    definition: change.definition ?? null,
    diff: change.diff ?? null,
  };
  return {
    target: change.target,
    operation: change.operation,
    hash: fnv1a(stableStringify(payload)),
  };
}

function fingerprintProposal(proposal: ProposalDefinition): {
  perChange: ChangeFingerprint[];
  aggregate: string;
} {
  const perChange = proposal.changes.map(fingerprintChange);
  // Aggregate hash is order-independent — sort fingerprint keys before hashing.
  const keys = perChange.map((f) => `${f.target}:${f.operation}:${f.hash}`).sort();
  return { perChange, aggregate: fnv1a(keys.join("|")) };
}

function hasOverlap(a: ChangeFingerprint[], b: ChangeFingerprint[]): boolean {
  const keyOf = (f: ChangeFingerprint) => `${f.target}:${f.operation}:${f.hash}`;
  const bKeys = new Set(b.map(keyOf));
  for (const fp of a) {
    if (bKeys.has(keyOf(fp))) return true;
  }
  return false;
}

function isExactMatch(a: ChangeFingerprint[], b: ChangeFingerprint[]): boolean {
  if (a.length !== b.length) return false;
  const keyOf = (f: ChangeFingerprint) => `${f.target}:${f.operation}:${f.hash}`;
  const aKeys = a.map(keyOf).sort();
  const bKeys = b.map(keyOf).sort();
  for (let i = 0; i < aKeys.length; i++) {
    if (aKeys[i] !== bKeys[i]) return false;
  }
  return true;
}

/** Status values considered "pending" when the store itself returns all proposals. */
const PENDING_STATUSES = new Set(["draft", "validating", "validated"]);

export interface CreateDedupAnalyzerOptions {
  /** Where to fetch the candidate's peer set. */
  store: PendingProposalStore;
  /**
   * Optional status allow-list override. Defaults to `draft|validating|validated`
   * which aligns with Spec 55's "pending review" concept.
   */
  pendingStatuses?: ReadonlySet<string>;
}

export function createDedupAnalyzer(
  opts: CreateDedupAnalyzerOptions,
): PreAnalyzer<"dedup", DedupResult> {
  const pending = opts.pendingStatuses ?? PENDING_STATUSES;

  return {
    stage: "dedup",
    name: "default-dedup-analyzer",
    async analyze(proposal: ProposalDefinition): Promise<DedupResult> {
      const candidate = fingerprintProposal(proposal);
      const peers = await opts.store.listPending();

      const similar: ProposalDefinition[] = [];
      let exactMatch: ProposalDefinition | null = null;

      for (const peer of peers) {
        if (peer.id === proposal.id) continue;
        if (!pending.has(peer.status)) continue;

        const peerFp = fingerprintProposal(peer);
        if (hasOverlap(candidate.perChange, peerFp.perChange)) {
          similar.push(peer);
          if (!exactMatch && isExactMatch(candidate.perChange, peerFp.perChange)) {
            exactMatch = peer;
          }
        }
      }

      return {
        similar,
        exactMatch,
        payloadHash: candidate.aggregate,
      };
    },
  };
}
