/**
 * EventHandlersPanel — side drawer showing per-handler delivery history
 * for one event.
 *
 * Backed by `eventsClient.getHandlerHistory(eventId)`. Until per-handler
 * tracking lands (Spec 66 §2.4) the server returns one wildcard `"*"`
 * row representing the aggregate status — the panel surfaces that
 * verbatim with an "aggregate" hint instead of pretending it's a
 * single named handler.
 */

import {
  Badge,
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@linchkit/ui-kit/components";
import { CheckCircle2, CircleSlash, Loader2, X, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { type EventStatus, getHandlerHistory, type HandlerHistoryEntry } from "../lib/eventsClient";

// ── Constants ───────────────────────────────────────────

/** Maximum characters of an error message rendered inline before truncation. */
const ERROR_PREVIEW_LIMIT = 120;

// ── Helpers ─────────────────────────────────────────────

/**
 * Truncate `value` to `limit` characters; appends an ellipsis when
 * truncation actually happens. Used to keep one-line error previews
 * from blowing out the table cell. Exported so the test can assert the
 * exact behaviour without re-implementing it.
 */
export function truncateError(value: string, limit: number = ERROR_PREVIEW_LIMIT): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}…`;
}

function statusVariant(status: EventStatus): "default" | "secondary" | "destructive" | "outline" {
  if (status === "completed") return "default";
  if (status === "failed" || status === "dead_letter") return "destructive";
  if (status === "processing") return "secondary";
  return "outline";
}

function StatusIcon({ status }: { status: EventStatus }) {
  if (status === "completed") {
    return (
      <CheckCircle2
        className="size-4 text-emerald-600"
        aria-label={status}
        data-testid="handler-status-icon-completed"
      />
    );
  }
  if (status === "failed" || status === "dead_letter") {
    return (
      <XCircle
        className="size-4 text-destructive"
        aria-label={status}
        data-testid="handler-status-icon-failed"
      />
    );
  }
  if (status === "processing") {
    return (
      <Loader2
        className="size-4 animate-spin text-muted-foreground"
        aria-label={status}
        data-testid="handler-status-icon-processing"
      />
    );
  }
  return (
    <CircleSlash
      className="size-4 text-muted-foreground"
      aria-label={status}
      data-testid="handler-status-icon-pending"
    />
  );
}

// ── Props ───────────────────────────────────────────────

export interface EventHandlersPanelProps {
  /** Event id to load history for; the panel hides when null. */
  eventId: string | null;
  /** Called when the user closes the panel. */
  onClose: () => void;
}

// ── Component ───────────────────────────────────────────

export function EventHandlersPanel(props: EventHandlersPanelProps) {
  const { eventId, onClose } = props;
  const { t } = useTranslation();

  const [history, setHistory] = useState<HandlerHistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!eventId) {
      setHistory([]);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    getHandlerHistory(eventId)
      .then((rows) => {
        if (cancelled) return;
        setHistory(rows);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  if (!eventId) return null;

  return (
    <aside
      className="flex h-full w-full max-w-md flex-col border-l bg-background"
      aria-label={t("events.handlers.title", "Handler history")}
      id={`event-handlers-${eventId}`}
      data-testid="event-handlers-panel"
    >
      <header className="flex items-center justify-between border-b px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold">
            {t("events.handlers.title", "Handler history")}
          </h2>
          <p className="truncate text-[11px] text-muted-foreground">
            <code>{eventId}</code>
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label={t("common.close", "Close")}>
          <X className="size-4" />
        </Button>
      </header>

      <div className="flex-1 overflow-auto px-3 py-3">
        {loading ? (
          <div className="flex h-24 items-center justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive">
            {error}
          </div>
        ) : history.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("events.handlers.empty", "No handler invocations recorded.")}
          </p>
        ) : (
          <div className="rounded-md border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("events.handlers.handler", "Handler")}</TableHead>
                  <TableHead className="w-24">{t("events.handlers.status", "Status")}</TableHead>
                  <TableHead className="w-20 text-right">
                    {t("events.handlers.duration", "ms")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.map((row) => (
                  <HandlerRow
                    // history rows lack a stable id; combine the row's
                    // observable fields so two distinct deliveries of the
                    // same handler (different status / duration / error)
                    // still produce a unique key inside a single render.
                    key={`${row.handler}|${row.status}|${row.durationMs ?? ""}|${row.error ?? ""}`}
                    row={row}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </aside>
  );
}

function HandlerRow({ row }: { row: HandlerHistoryEntry }) {
  const { t } = useTranslation();
  const isWildcard = row.handler === "*";
  return (
    <>
      <TableRow data-testid="handler-history-row">
        <TableCell className="font-medium">
          {isWildcard ? (
            <span className="text-xs text-muted-foreground">
              {t("events.handlers.aggregate", "(aggregate)")}
            </span>
          ) : (
            <code className="text-xs">{row.handler}</code>
          )}
        </TableCell>
        <TableCell>
          <div className="flex items-center gap-1.5">
            <StatusIcon status={row.status} />
            <Badge variant={statusVariant(row.status)} className="text-[10px]">
              {row.status}
            </Badge>
          </div>
        </TableCell>
        <TableCell className="text-right text-xs">
          {typeof row.durationMs === "number" ? row.durationMs : "—"}
        </TableCell>
      </TableRow>
      {row.error && (
        <TableRow data-testid="handler-history-error">
          <TableCell colSpan={3} className="bg-destructive/5">
            <p
              className="break-all text-[11px] text-destructive"
              title={row.error}
              data-testid="handler-history-error-text"
            >
              {truncateError(row.error)}
            </p>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

export default EventHandlersPanel;
