/**
 * BulkActionDialog — Run a chosen action against every selected record.
 *
 * Wraps `POST /api/actions/batch` (Spec 16 §3.1) via `executeBatchAction`,
 * which handles the 500-item server cap by chunking client-side. Three
 * outcome buckets are rendered: succeeded (green), failed (red, with the
 * server-provided reason), rolledBack (yellow, only present under
 * `all_or_nothing` strategy when a later item triggered a rollback).
 */

import type {
  BatchActionsResult,
  BatchTransactionStrategy,
  ViewAction,
} from "@linchkit/core/types";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@linchkit/ui-kit/components";
import { AlertCircle, CheckCircle2, PlayCircle, Undo2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useEntityLabel } from "../../i18n/use-entity-label";
import { executeBatchAction } from "../../lib/batch-actions";

// ── Types ────────────────────────────────────────────────────

type Phase = "select" | "running" | "done";

export interface BulkActionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Selected record ids fed into the batch. */
  selectedIds: string[];
  /** Actions exposed for this list's entity (typically `view.actions`). */
  actions: ViewAction[];
  /**
   * Optional resolver that returns a per-action transaction strategy. When
   * the action declaration has a transactional contract, return
   * `'all_or_nothing'`; otherwise return `'partial'` (or omit / return
   * `undefined` to fall back to the default).
   */
  resolveStrategy?: (actionName: string) => BatchTransactionStrategy | undefined;
  /** Called after a successful run so callers can refresh data. */
  onCompleted?: (result: BatchActionsResult) => void;
}

// ── Component ────────────────────────────────────────────────

export function BulkActionDialog({
  open,
  onOpenChange,
  selectedIds,
  actions,
  resolveStrategy,
  onCompleted,
}: BulkActionDialogProps) {
  const { t } = useTranslation();
  const { resolveLabel } = useEntityLabel();

  const [phase, setPhase] = useState<Phase>("select");
  const [actionName, setActionName] = useState<string>("");
  const [result, setResult] = useState<BatchActionsResult | null>(null);

  // Filter to actions a list-page operator can reasonably invoke per row.
  // Form-only actions (e.g. wizards) are excluded — they need a single record
  // context, not a batch one.
  const applicableActions = useMemo(
    () => actions.filter((a) => (a.position ?? "row") !== "form-header"),
    [actions],
  );

  const reset = useCallback(() => {
    setPhase("select");
    setActionName("");
    setResult(null);
  }, []);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) reset();
      onOpenChange(next);
    },
    [onOpenChange, reset],
  );

  const handleRun = useCallback(async () => {
    if (!actionName || selectedIds.length === 0) return;
    setPhase("running");
    const strategy = resolveStrategy?.(actionName) ?? "partial";
    const aggregated = await executeBatchAction({
      actionName,
      recordIds: selectedIds,
      strategy,
    });
    setResult(aggregated);
    setPhase("done");
  }, [actionName, selectedIds, resolveStrategy]);

  const handleClose = useCallback(() => {
    if (result) onCompleted?.(result);
    handleOpenChange(false);
  }, [result, onCompleted, handleOpenChange]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PlayCircle className="size-4" />
            {t("bulkAction.title", "Run batch action")}
          </DialogTitle>
          <DialogDescription>
            {t(
              "bulkAction.description",
              "Choose an action to run against {{count}} selected records.",
              { count: selectedIds.length },
            )}
          </DialogDescription>
        </DialogHeader>

        {/* ── Choose action ───────────────────────────────────── */}
        {phase === "select" && (
          <div className="space-y-4">
            {applicableActions.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">
                {t("bulkAction.noActions", "No actions available for the selected records.")}
              </p>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="bulk-action-select" className="text-sm font-medium">
                  {t("bulkAction.action", "Action")}
                </Label>
                <Select value={actionName} onValueChange={setActionName}>
                  <SelectTrigger id="bulk-action-select">
                    <SelectValue
                      placeholder={t("bulkAction.choosePlaceholder", "Select an action…")}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {applicableActions.map((a) => (
                      <SelectItem key={a.action} value={a.action}>
                        {resolveLabel(a.label, a.action)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                {t("common.cancel")}
              </Button>
              <Button disabled={!actionName || applicableActions.length === 0} onClick={handleRun}>
                {t("bulkAction.runOnCount", "Run on {{count}} records", {
                  count: selectedIds.length,
                })}
              </Button>
            </DialogFooter>
          </div>
        )}

        {/* ── Running ─────────────────────────────────────────── */}
        {phase === "running" && (
          <div className="space-y-2 py-8">
            <div className="text-center text-sm text-muted-foreground">
              {t("bulkAction.running", "Running action against selected records…")}
            </div>
          </div>
        )}

        {/* ── Done ────────────────────────────────────────────── */}
        {phase === "done" && result && (
          <BulkActionResultPanel result={result} onClose={handleClose} />
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Result panel ────────────────────────────────────────────

interface BulkActionResultPanelProps {
  result: BatchActionsResult;
  onClose: () => void;
}

function BulkActionResultPanel({ result, onClose }: BulkActionResultPanelProps) {
  const { t } = useTranslation();
  const succeededCount = result.succeeded.length;
  const failedCount = result.failed.length;
  const rolledBackCount = result.rolledBack?.length ?? 0;

  // Headline icon: green if everything succeeded, yellow on rollback, red on
  // any net failure, neutral when there's nothing to report.
  const Headline = (() => {
    if (failedCount === 0 && rolledBackCount === 0 && succeededCount > 0) {
      return <CheckCircle2 className="size-10 text-green-500" />;
    }
    if (rolledBackCount > 0) {
      return <Undo2 className="size-10 text-yellow-500" />;
    }
    return <AlertCircle className="size-10 text-destructive" />;
  })();

  return (
    <div className="space-y-4">
      <div className="flex flex-col items-center gap-3 py-2">
        {Headline}
        <p className="text-sm font-medium">
          {t("bulkAction.summary", "{{ok}} succeeded, {{fail}} failed", {
            ok: succeededCount,
            fail: failedCount,
          })}
        </p>
      </div>

      {succeededCount > 0 && (
        <section
          aria-label="succeeded"
          className="rounded-md border border-green-500/30 bg-green-500/5 p-3"
        >
          <h4 className="mb-1 text-sm font-medium text-green-600 dark:text-green-400">
            {t("bulkAction.succeeded", "Succeeded ({{count}})", { count: succeededCount })}
          </h4>
          <p className="text-xs text-muted-foreground">
            {t("bulkAction.succeededDescription", "Records updated successfully.")}
          </p>
        </section>
      )}

      {failedCount > 0 && (
        <section
          aria-label="failed"
          className="rounded-md border border-destructive/30 bg-destructive/5 p-3"
        >
          <h4 className="mb-2 text-sm font-medium text-destructive">
            {t("bulkAction.failed", "Failed ({{count}})", { count: failedCount })}
          </h4>
          <ul className="max-h-36 space-y-1 overflow-y-auto">
            {result.failed.map((f) => (
              <li key={`${f.index}-${f.error.code}`} className="text-xs text-muted-foreground">
                <span className="font-mono">#{f.index}</span>:{" "}
                <span className="font-medium text-destructive">{f.error.code}</span>{" "}
                {f.error.message}
              </li>
            ))}
          </ul>
        </section>
      )}

      {rolledBackCount > 0 && (
        <section
          aria-label="rolled-back"
          className="rounded-md border border-yellow-500/30 bg-yellow-500/5 p-3"
        >
          <h4 className="mb-1 text-sm font-medium text-yellow-700 dark:text-yellow-400">
            {t("bulkAction.rolledBack", "Rolled back ({{count}})", {
              count: rolledBackCount,
            })}
          </h4>
          <p className="text-xs text-muted-foreground">
            {t(
              "bulkAction.rolledBackDescription",
              "These items succeeded but were undone because a later item failed.",
            )}
          </p>
        </section>
      )}

      <DialogFooter>
        <Button onClick={onClose}>{t("common.close")}</Button>
      </DialogFooter>
    </div>
  );
}
