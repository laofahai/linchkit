/**
 * EventReplayDialog — confirmation modal for re-dispatching a persisted event.
 *
 * Two-phase UI:
 *  1. Form — confirm event id, toggle dry run, optionally restrict to a
 *     named handler (comma list — the wire format `eventsClient.replayEvent`
 *     accepts).
 *  2. Result — render the returned `ReplayReport` (delivered / failed
 *     counts + per-handler outcome).
 *
 * Submit calls `eventsClient.replayEvent` with `{ dryRun, handlers }` —
 * empty strings are normalised to `undefined` so the server omits the
 * filter and runs every registered handler.
 */

import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from "@linchkit/ui-kit/components";
import { AlertCircle, CheckCircle2, Loader2, PlayCircle, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { type ReplayReport, replayEvent } from "../lib/eventsClient";

// ── Props ───────────────────────────────────────────────

export interface EventReplayDialogProps {
  /** Controls visibility — the page-level owner gates this. */
  open: boolean;
  /** Event id pinned for replay; `null` when no event is selected. */
  eventId: string | null;
  /** Display label (eventType or sourceAction) shown in the body. */
  eventLabel?: string;
  /** Fired when the dialog requests close (cancel, ESC, backdrop). */
  onOpenChange: (open: boolean) => void;
  /**
   * Fired after a successful replay so the parent can refresh the
   * timeline / handler panel. Always fires AFTER `setReport` so the
   * parent can read the report from its own snapshot if needed.
   */
  onSuccess?: (report: ReplayReport) => void;
}

// ── Component ───────────────────────────────────────────

export function EventReplayDialog(props: EventReplayDialogProps) {
  const { open, eventId, eventLabel, onOpenChange, onSuccess } = props;
  const { t } = useTranslation();

  const [dryRun, setDryRun] = useState(true);
  const [handlerFilter, setHandlerFilter] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ReplayReport | null>(null);

  // Reset transient state whenever the dialog is reopened on a new event
  // so a stale ReplayReport from the previous event doesn't briefly
  // render in the new modal before submit.
  useEffect(() => {
    if (open) {
      setDryRun(true);
      setHandlerFilter("");
      setSubmitting(false);
      setError(null);
      setReport(null);
    }
  }, [open]);

  async function handleSubmit() {
    if (!eventId || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const handlers = handlerFilter.trim() || undefined;
      const result = await replayEvent(eventId, { dryRun, handlers });
      setReport(result);
      onSuccess?.(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("events.replay.title", "Replay event")}</DialogTitle>
          <DialogDescription>
            {t(
              "events.replay.description",
              "Re-dispatch the event through its registered handlers. The original event row is never modified.",
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {/* Target event */}
          <div className="rounded-md border bg-muted/30 p-3 text-xs">
            <div className="font-medium">
              {eventLabel ?? t("events.replay.targetFallback", "Event")}
            </div>
            <code className="break-all text-[11px] text-muted-foreground">{eventId ?? "—"}</code>
          </div>

          {/* Dry run */}
          <div className="flex items-center gap-2 text-sm">
            <Checkbox
              id="event-replay-dry-run"
              checked={dryRun}
              onCheckedChange={(v) => setDryRun(v === true)}
              aria-label={t("events.replay.dryRun", "Dry run")}
              data-testid="event-replay-dry-run"
            />
            <Label htmlFor="event-replay-dry-run" className="text-sm font-normal">
              {t(
                "events.replay.dryRunHint",
                "Dry run — resolve candidate handlers without invoking them.",
              )}
            </Label>
          </div>

          {/* Handler filter */}
          <div className="flex flex-col gap-1">
            <Label htmlFor="event-replay-handler" className="text-xs">
              {t("events.replay.handlerFilterLabel", "Restrict to handler (optional)")}
            </Label>
            <Input
              id="event-replay-handler"
              value={handlerFilter}
              onChange={(e) => setHandlerFilter(e.target.value)}
              placeholder="cap-cache:invalidate"
              className="h-8"
              data-testid="event-replay-handler-filter"
            />
          </div>

          {/* Error */}
          {error && (
            <div
              className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive"
              role="alert"
            >
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Result */}
          {report && <ReplaySummary report={report} />}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            {report ? t("common.close", "Close") : t("events.replay.cancel", "Cancel")}
          </Button>
          {!report && (
            <Button
              type="button"
              onClick={handleSubmit}
              disabled={!eventId || submitting}
              data-testid="event-replay-submit"
            >
              {submitting ? (
                <Loader2 className="mr-1 size-3.5 animate-spin" />
              ) : (
                <PlayCircle className="mr-1 size-3.5" />
              )}
              {dryRun
                ? t("events.replay.submitDry", "Run dry replay")
                : t("events.replay.submit", "Replay now")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Result summary ──────────────────────────────────────

function ReplaySummary({ report }: { report: ReplayReport }) {
  const { t } = useTranslation();
  return (
    <section
      className="rounded-md border p-3 text-sm"
      aria-label={t("events.replay.summary", "Replay summary")}
      data-testid="event-replay-summary"
    >
      <header className="mb-2 flex items-center gap-2">
        <span className="font-medium">
          {report.dryRun
            ? t("events.replay.summaryDryHeading", "Dry run result")
            : t("events.replay.summaryHeading", "Replay result")}
        </span>
        <Badge variant="default">
          {t("events.replay.delivered", { defaultValue: "{{n}} delivered", n: report.delivered })}
        </Badge>
        {report.failed > 0 && (
          <Badge variant="destructive">
            {t("events.replay.failed", { defaultValue: "{{n}} failed", n: report.failed })}
          </Badge>
        )}
      </header>

      {report.handlers.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("events.replay.noHandlers", "No registered handlers matched this event.")}
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {report.handlers.map((h) => (
            <li
              // Server-returned outcomes are stable within a report. The
              // combined (handler,status,error) tuple is unique even when
              // the same handler appears twice with different errors —
              // sufficient for a single report's render lifecycle.
              key={`${h.handler}|${h.status}|${h.error ?? ""}`}
              className="flex items-start gap-2 text-xs"
              data-testid="event-replay-handler-outcome"
            >
              {h.status === "success" ? (
                <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />
              ) : (
                <XCircle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
              )}
              <div className="min-w-0">
                <code className="break-all">{h.handler}</code>
                {h.error && <p className="text-destructive break-words">{h.error}</p>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default EventReplayDialog;
