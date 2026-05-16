/**
 * AuditDetail — full payload view for one execution log entry.
 *
 * Renders four sections:
 *   1. Summary (action, actor, status, duration, channel, error)
 *   2. Input / Output JSON
 *   3. State transition (from → to) when present
 *   4. ExecutionMeta snapshot (Spec 65) when present
 *
 * Rules evaluated by the execution are NOT yet exposed by the
 * `executionLogList` query — see follow-up note in the audit-api
 * module. When that field becomes available, add a fifth section here.
 */

import { Badge, Button } from "@linchkit/ui-kit/components";
import { ArrowRight, ExternalLink, Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { type AuditDetail, queryAuditDetail } from "../lib/audit-api";

export interface AuditDetailViewProps {
  /** Execution id (`_linchkit.executions.id`). */
  executionId: string;
  /** Called when the user closes the panel. */
  onClose: () => void;
}

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "succeeded") return "default";
  if (status === "failed" || status === "blocked") return "destructive";
  return "secondary";
}

function JsonBlock({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <pre className="max-h-72 overflow-auto rounded-md border bg-muted/40 p-3 text-xs leading-relaxed">
      <code>{text}</code>
    </pre>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <div className="text-sm">{children}</div>
    </div>
  );
}

export function AuditDetailView(props: AuditDetailViewProps) {
  const { executionId, onClose } = props;
  const { t } = useTranslation();
  const [detail, setDetail] = useState<AuditDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    queryAuditDetail(executionId)
      .then((row) => {
        if (cancelled) return;
        setDetail(row);
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
  }, [executionId]);

  return (
    <aside
      className="flex h-full w-full max-w-xl flex-col border-l bg-background"
      aria-label={t("audit.detail.title", "Execution detail")}
    >
      <header className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2 min-w-0">
          <ExternalLink className="size-4 text-muted-foreground shrink-0" />
          <h2 className="truncate text-sm font-semibold">
            {detail?.action ?? t("audit.detail.title", "Execution detail")}
          </h2>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label={t("common.close", "Close")}>
          <X className="size-4" />
        </Button>
      </header>

      <div className="flex-1 overflow-auto px-4 py-3">
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        ) : !detail ? (
          <div className="text-sm text-muted-foreground">
            {t("audit.detail.notFound", "Execution not found.")}
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            {/* ── Summary ──────────────────────────────── */}
            <section className="grid grid-cols-2 gap-3">
              <Field label={t("audit.detail.executionId", "Execution ID")}>
                <code className="break-all text-xs">{detail.id}</code>
              </Field>
              <Field label={t("audit.detail.status", "Status")}>
                <Badge variant={statusVariant(detail.status)}>{detail.status}</Badge>
              </Field>
              <Field label={t("audit.detail.action", "Action")}>{detail.action}</Field>
              <Field label={t("audit.detail.duration", "Duration")}>{detail.durationMs} ms</Field>
              <Field label={t("audit.detail.actor", "Actor")}>
                {detail.actorId ? (
                  <span>
                    <span className="text-muted-foreground">{detail.actorType ?? "?"}:</span>{" "}
                    <code className="text-xs">{detail.actorId}</code>
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">—</span>
                )}
              </Field>
              <Field label={t("audit.detail.entity", "Entity")}>
                {detail.entity ? (
                  <span>
                    <code className="text-xs">{detail.entity}</code>
                    {detail.recordId && (
                      <span className="text-muted-foreground"> / {detail.recordId}</span>
                    )}
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">—</span>
                )}
              </Field>
              <Field label={t("audit.detail.channel", "Channel")}>
                {detail.channel ?? <span className="text-xs text-muted-foreground">—</span>}
              </Field>
              <Field label={t("audit.detail.capability", "Capability")}>
                {detail.capability ?? <span className="text-xs text-muted-foreground">—</span>}
              </Field>
              <Field label={t("audit.detail.startedAt", "Started")}>
                <span className="text-xs">{new Date(detail.startedAt).toLocaleString()}</span>
              </Field>
              <Field label={t("audit.detail.completedAt", "Completed")}>
                <span className="text-xs">
                  {detail.completedAt ? new Date(detail.completedAt).toLocaleString() : "—"}
                </span>
              </Field>
            </section>

            {/* ── Error ──────────────────────────────────── */}
            {detail.errorMessage && (
              <section className="rounded-md border border-destructive/40 bg-destructive/10 p-3">
                <div className="text-[11px] uppercase tracking-wider text-destructive/80">
                  {t("audit.detail.error", "Error")}
                </div>
                {detail.errorCode && (
                  <code className="mt-1 block text-xs text-destructive">{detail.errorCode}</code>
                )}
                <p className="mt-1 text-sm text-destructive">{detail.errorMessage}</p>
              </section>
            )}

            {/* ── State transition ───────────────────────── */}
            {detail.stateTransitionTo && (
              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {t("audit.detail.stateTransition", "State transition")}
                </h3>
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{detail.stateTransitionFrom ?? "∅"}</Badge>
                  <ArrowRight className="size-3.5 text-muted-foreground" />
                  <Badge variant="secondary">{detail.stateTransitionTo}</Badge>
                </div>
              </section>
            )}

            {/* ── Input / output ────────────────────────── */}
            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {t("audit.detail.input", "Input")}
              </h3>
              <JsonBlock value={detail.input} />
            </section>
            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {t("audit.detail.output", "Output")}
              </h3>
              <JsonBlock value={detail.output} />
            </section>

            {/* ── Meta ──────────────────────────────────── */}
            {detail.meta && Object.keys(detail.meta).length > 0 && (
              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {t("audit.detail.meta", "Execution meta (Spec 65)")}
                </h3>
                <JsonBlock value={detail.meta} />
              </section>
            )}

            {/* TODO(spec-14, spec-11): show rules_evaluated[] once the
                executionLogList GraphQL projection exposes that field.
                See cap-adapter-server/src/system-data-provider.ts:
                rules_evaluated is captured in the in-memory log entry
                but not yet projected through the system schema. */}
          </div>
        )}
      </div>
    </aside>
  );
}

export default AuditDetailView;
