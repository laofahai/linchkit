/**
 * Overlay Proposal Executor
 *
 * Executes overlay changes when a proposal is committed.
 * Also provides auto-approval evaluation for low-risk overlay changes.
 *
 * Auto-approval policy:
 *   - Adding an optional field (required !== true) → auto-approve
 *   - Adding a required field → manual approval required
 *   - Updating or deleting a field → manual approval required
 */

import type { OverlayStore } from "../types/overlay";
import type {
  OverlayChangeDefinition,
  ProposalChange,
  ProposalDefinition,
} from "../types/proposal";

// ── Auto-approval evaluation ──────────────────────────────

/**
 * Determine whether an overlay proposal change can be auto-approved.
 *
 * Only `create` operations for optional fields are considered low-risk.
 * Everything else (required fields, updates, deletes) requires manual review.
 */
export function canAutoApproveOverlayChange(change: ProposalChange): boolean {
  if (change.target !== "overlay") return false;
  if (change.operation !== "create") return false;

  const def = change.definition;
  if (!def || !isOverlayChangeDefinition(def)) return false;

  // Required fields need manual approval
  if (def.overlay.config.required === true) return false;

  return true;
}

/**
 * Check whether ALL overlay changes in a proposal qualify for auto-approval.
 * Returns false if the proposal contains any non-overlay changes or any
 * overlay change that requires manual review.
 */
export function canAutoApproveOverlayProposal(proposal: ProposalDefinition): boolean {
  if (proposal.changes.length === 0) return false;

  // All changes must be overlay changes AND auto-approvable
  return proposal.changes.every(
    (change) => change.target === "overlay" && canAutoApproveOverlayChange(change),
  );
}

// ── Proposal execution ────────────────────────────────────

/**
 * Execute overlay changes from a committed proposal against an OverlayStore.
 *
 * Called after a proposal transitions to "committed" status.
 * Processes each overlay change in order:
 *   - create → addOverlay
 *   - update → updateOverlay (finds by entityName + fieldName)
 *   - delete → removeOverlay (finds by entityName + fieldName)
 */
export async function executeOverlayProposal(options: {
  proposal: ProposalDefinition;
  store: OverlayStore;
}): Promise<void> {
  const { proposal, store } = options;

  for (const change of proposal.changes) {
    if (change.target !== "overlay") continue;

    const def = change.definition;
    if (!def || !isOverlayChangeDefinition(def)) {
      throw new Error(`Overlay change "${change.name}" is missing a valid OverlayChangeDefinition`);
    }

    switch (change.operation) {
      case "create": {
        await store.addOverlay({
          entityName: def.entityName,
          fieldName: def.overlay.fieldName,
          fieldType: def.overlay.fieldType,
          config: def.overlay.config,
          status: "active",
          proposalId: proposal.id,
          createdBy: proposal.author.id,
        });
        break;
      }

      case "update": {
        const existing = await findOverlayByField(store, def.entityName, def.overlay.fieldName);
        if (!existing) {
          throw new Error(
            `Cannot update overlay: field "${def.overlay.fieldName}" not found on entity "${def.entityName}"`,
          );
        }
        await store.updateOverlay(existing.id, {
          fieldType: def.overlay.fieldType,
          config: def.overlay.config,
        });
        break;
      }

      case "delete": {
        const existing = await findOverlayByField(store, def.entityName, def.overlay.fieldName);
        if (!existing) {
          throw new Error(
            `Cannot delete overlay: field "${def.overlay.fieldName}" not found on entity "${def.entityName}"`,
          );
        }
        // Deprecate rather than hard-delete for audit trail
        await store.updateOverlay(existing.id, { status: "deprecated" });
        break;
      }
    }
  }
}

// ── Helpers ───────────────────────────────────────────────

/** Type guard for OverlayChangeDefinition */
function isOverlayChangeDefinition(def: unknown): def is OverlayChangeDefinition {
  return (
    typeof def === "object" &&
    def !== null &&
    "kind" in def &&
    (def as OverlayChangeDefinition).kind === "overlay"
  );
}

/** Find an overlay record by entity name and field name */
async function findOverlayByField(store: OverlayStore, entityName: string, fieldName: string) {
  const overlays = await store.getOverlays(entityName);
  return overlays.find((o) => o.fieldName === fieldName) ?? null;
}
