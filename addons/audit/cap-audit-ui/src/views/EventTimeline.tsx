/**
 * EventTimeline — vertical timeline of persisted events with per-row
 * "view handlers" toggle and "replay" trigger.
 *
 * The page-level container (EventsPage) owns the selected event id +
 * the dialog open state; this view just renders rows and emits intents
 * so it stays render-cheap and trivially mockable in tests.
 */

import { Badge, Button } from "@linchkit/ui-kit/components";
import { AlertCircle, Loader2, PlayCircle, RefreshCw, ScrollText } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type EventListOptions,
  type EventStatus,
  type EventSummary,
  list as listEvents,
} from "../lib/eventsClient";

// ── Helpers ─────────────────────────────────────────────

const PAGE_LIMIT = 50;

function statusVariant(status: EventStatus): "default" | "secondary" | "destructive" | "outline" {
  if (status === "completed") return "default";
  if (status === "failed" || status === "dead_letter") return "destructive";
  if (status === "processing") return "secondary";
  return "outline";
}

/**
 * Format an ISO timestamp using `Intl.DateTimeFormat` so output is
 * stable across runtimes (the JS default `toLocaleString()` varies by
 * runtime locale). Mirrors the helper in AuditList/AuditDetail.
 */
export function formatTimestamp(iso: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

// ── Props ───────────────────────────────────────────────

export interface EventTimelineProps {
  /** Optional pre-applied filter; defaults to "all events, newest first". */
  filter?: EventListOptions;
  /** Currently expanded event (handler panel visible). */
  expandedEventId?: string | null;
  /** Fired when the user toggles "view handlers" on a row. */
  onToggleHandlers?: (eventId: string | null) => void;
  /** Fired when the user clicks "replay" on a row. */
  onReplay?: (event: EventSummary) => void;
}

// ── Component ───────────────────────────────────────────

export function EventTimeline(props: EventTimelineProps) {
  const { filter, expandedEventId = null, onToggleHandlers, onReplay } = props;
  const { t, i18n } = useTranslation();

  const [events, setEvents] = useState<EventSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Monotonic request id — guards against an older fetch resolving last
  // and overwriting the result of a newer fetch.
  const seqRef = useRef(0);

  const refetch = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await listEvents({ ...filter, limit: PAGE_LIMIT });
      if (seq !== seqRef.current) return;
      setEvents(result.events);
      setTotal(result.total);
    } catch (err) {
      if (seq !== seqRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
      setEvents([]);
      setTotal(0);
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  function toggleHandlers(eventId: string) {
    if (!onToggleHandlers) return;
    onToggleHandlers(expandedEventId === eventId ? null : eventId);
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">{t("events.timeline.title", "Event Timeline")}</h1>
          <p className="text-xs text-muted-foreground">
            {t(
              "events.timeline.subtitle",
              "Every domain event persisted to _linchkit.events with per-handler delivery state.",
            )}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={refetch}
          disabled={loading}
          aria-label={t("common.refresh", "Refresh")}
        >
          <RefreshCw className={`mr-1 size-3.5 ${loading ? "animate-spin" : ""}`} />
          {t("common.refresh", "Refresh")}
        </Button>
      </div>

      {/* Error banner */}
      {error && (
        <div
          className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive"
          role="alert"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && events.length === 0 && (
        <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
          {t("events.timeline.empty", "No events match the current filter.")}
        </div>
      )}

      {/* Loading spinner — only when there are no rows yet */}
      {loading && events.length === 0 && (
        <div className="flex h-24 items-center justify-center">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      )}

      {/* Timeline */}
      {events.length > 0 && (
        <ol
          className="relative ml-3 border-l border-border"
          aria-label={t("events.timeline.title", "Event Timeline")}
          data-testid="event-timeline"
        >
          {events.map((event) => {
            const expanded = expandedEventId === event.id;
            return (
              <li
                key={event.id}
                className="ml-4 py-3"
                data-testid="event-timeline-row"
                data-event-id={event.id}
              >
                <span className="absolute -left-1.5 mt-1 flex size-3 items-center justify-center rounded-full border border-border bg-background">
                  <ScrollText className="size-2 text-muted-foreground" />
                </span>

                <div className="flex flex-wrap items-center gap-2">
                  <time
                    className="font-mono text-xs text-muted-foreground"
                    dateTime={event.createdAt}
                  >
                    {formatTimestamp(event.createdAt, i18n.language)}
                  </time>
                  <Badge variant="outline" className="text-xs">
                    {event.sourceAction ?? "—"}
                  </Badge>
                  <span className="font-medium text-sm">{event.eventType}</span>
                  <Badge variant={statusVariant(event.status)}>{event.status}</Badge>
                  {event.sourceExecutionId && (
                    <code
                      className="text-[11px] text-muted-foreground"
                      title={event.sourceExecutionId}
                    >
                      exec:{event.sourceExecutionId.slice(0, 8)}
                    </code>
                  )}
                </div>

                {event.errorMessage && (
                  <p className="mt-1 text-xs text-destructive">{event.errorMessage}</p>
                )}

                <div className="mt-2 flex items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => toggleHandlers(event.id)}
                    aria-expanded={expanded}
                    aria-controls={`event-handlers-${event.id}`}
                  >
                    {expanded
                      ? t("events.timeline.hideHandlers", "Hide handlers")
                      : t("events.timeline.viewHandlers", "View handlers")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => onReplay?.(event)}
                    aria-label={t("events.timeline.replay", "Replay event")}
                  >
                    <PlayCircle className="mr-1 size-3.5" />
                    {t("events.timeline.replay", "Replay")}
                  </Button>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {/* Footer */}
      <div className="text-xs text-muted-foreground">
        {t("events.timeline.totalCount", {
          defaultValue: "{{count}} events",
          count: total,
        })}
      </div>
    </div>
  );
}

export default EventTimeline;
