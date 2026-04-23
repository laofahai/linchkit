/**
 * Impact analyzer — Spec 55 §7.3 stage 3.
 *
 * Estimates how many stored records would be affected if the candidate proposal
 * is applied. Data-changing targets (entity, state, overlay) hit the injected
 * DataProvider for a count + sample. Code-only targets (view, action, event, rule,
 * flow) report `affectedRecordCount: 0` with a `reason` so downstream consumers
 * can explain "nothing stored changes" to the reviewer.
 *
 * This analyzer deliberately does NOT walk semantic relations or compute cascading
 * impacts — that belongs to a dedicated ImpactAnalysis module. The goal here is a
 * fast, first-order estimate suitable for the pre-analysis pipeline.
 */

import type {
  ProposalChange,
  ProposalChangeTarget,
  ProposalDefinition,
} from "../../types/proposal";
import type { ImpactDataProvider, ImpactResult, PreAnalyzer } from "./types";

/** Default sample size. Small so the analyzer stays cheap even against large tables. */
const DEFAULT_SAMPLE_LIMIT = 5;

/**
 * Targets that touch stored records. Any other target (view, action, event, rule,
 * flow) is code-only for the purposes of first-order impact estimation.
 *
 * `overlay` is included because overlays may change how existing records are
 * interpreted (validation, visibility) even when they don't rewrite rows.
 */
const DATA_TARGETS: ReadonlySet<ProposalChangeTarget> = new Set<ProposalChangeTarget>([
  "entity",
  "state",
  "overlay",
]);

/**
 * A data-target change is impactable only when it can affect pre-existing rows.
 * Creating a brand-new entity has no prior rows, so it produces zero first-order
 * impact even though the target is `entity` — skip it here to avoid probing a
 * table that does not exist yet.
 */
function isImpactableChange(change: ProposalChange): boolean {
  if (!DATA_TARGETS.has(change.target)) return false;
  if (change.target === "entity" && change.operation === "create") return false;
  return true;
}

/** Resolve the entity name a data-target change operates on. */
function resolveEntityName(change: ProposalChange): string | null {
  if (change.target === "entity") {
    // Entity changes — `name` IS the entity name.
    return change.name || null;
  }
  if (change.target === "state") {
    // State machines belong to the entity named in StateDefinition.entity; the
    // state-machine `name` (e.g. "purchase_request_status") is NOT the table.
    const def = change.definition as { entity?: string } | undefined;
    return def?.entity ?? null;
  }
  if (change.target === "overlay") {
    // OverlayChangeDefinition carries an entityName field; fall back to `name`.
    const def = change.definition as { entityName?: string } | undefined;
    return def?.entityName ?? change.name ?? null;
  }
  return null;
}

export interface CreateImpactAnalyzerOptions {
  /** Data provider used to count + sample records. */
  dataProvider: ImpactDataProvider;
  /** Max number of sample record IDs to fetch. Default: 5. */
  sampleLimit?: number;
}

export function createImpactAnalyzer(
  opts: CreateImpactAnalyzerOptions,
): PreAnalyzer<"impact", ImpactResult> {
  const sampleLimit = Math.max(0, opts.sampleLimit ?? DEFAULT_SAMPLE_LIMIT);

  return {
    stage: "impact",
    name: "default-impact-analyzer",
    async analyze(proposal: ProposalDefinition): Promise<ImpactResult> {
      const dataChanges = proposal.changes.filter(isImpactableChange);

      if (dataChanges.length === 0) {
        return {
          affectedRecordCount: 0,
          sampleRecordIds: [],
          probedEntities: [],
          reason: "not-a-data-change",
        };
      }

      // Collect unique entities referenced across all data-target changes.
      const probedEntities: string[] = [];
      const seenEntities = new Set<string>();
      for (const change of dataChanges) {
        const entity = resolveEntityName(change);
        if (entity && !seenEntities.has(entity)) {
          seenEntities.add(entity);
          probedEntities.push(entity);
        }
      }

      if (probedEntities.length === 0) {
        return {
          affectedRecordCount: 0,
          sampleRecordIds: [],
          probedEntities: [],
          reason: "entity-unresolved",
        };
      }

      // Query the data provider. Count is summed across all probed entities.
      // A shared sample pool is collected so reviewers always see a handful of ids.
      let totalCount = 0;
      const sampleIds: string[] = [];
      for (const entity of probedEntities) {
        const count = await opts.dataProvider.countRecords(entity);
        totalCount += count;

        if (sampleIds.length < sampleLimit) {
          const remaining = sampleLimit - sampleIds.length;
          const ids = await opts.dataProvider.sampleRecordIds(entity, remaining);
          sampleIds.push(...ids);
        }
      }

      return {
        affectedRecordCount: totalCount,
        sampleRecordIds: sampleIds.slice(0, sampleLimit),
        probedEntities,
      };
    },
  };
}
