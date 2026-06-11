/**
 * TraceDetailPanel — per-trace content drill-down for /admin/ai-traces
 * (Spec 69 — "Langfuse-class observability", issue #350).
 *
 * Side Sheet that opens when a trace row is selected on the AI-traces page and
 * shows the trace's per-call generations: model, token split, cost, latency,
 * status, and the prompt messages + completion. All content is rendered
 * exactly as the server returns it — the server already redacts; the UI never
 * adds a "reveal raw" affordance.
 *
 * Data source audit:
 * - All data: DYNAMIC — fetched from GET /api/ai/traces/:id/generations on
 *   open; refetched when a different trace is selected.
 */

import {
  Badge,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  Skeleton,
} from "@linchkit/ui-kit/components";
import { ActivityIcon, ShieldOffIcon, XCircleIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type AIGeneration,
  type AITrace,
  type AITraceStatus,
  fetchTraceGenerations,
} from "../lib/ai-traces-client";
import { resolveStoredResult, type StoredGenerationsResult } from "../lib/trace-detail-state";

// ── Constants ────────────────────────────────────────────

/** Max generations requested per trace (server hard-caps anyway). */
const GENERATION_LIMIT = 100;

// ── Shared format helpers (also used by the list page) ───

/** Map a trace/generation status to a Badge class (ok=green, error=red, partial=amber). */
export function statusBadgeClass(status: AITraceStatus): string {
  switch (status) {
    case "ok":
      return "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400";
    case "error":
      return "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400";
    default:
      // partial
      return "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400";
  }
}

/** Format a USD cost, or "—" when zero/absent (per spec — `$0.000026`, `—` when 0). */
export function formatCost(cost: number | undefined): string {
  if (!cost) return "—";
  return `$${cost.toFixed(6)}`;
}

/** Format a latency in ms (`420ms`, `1.25s`), or "—" when invalid. */
function formatLatency(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

// ── Sub-components ───────────────────────────────────────

function PanelSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 3 }).map((_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton
        <Skeleton key={i} className="h-32 w-full" />
      ))}
    </div>
  );
}

/** Redacted text block (prompt message / completion) — monospace, pre-wrap. */
function ContentBlock({ label, content }: { label: string; content: string }) {
  return (
    <div className="space-y-1">
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <pre className="whitespace-pre-wrap break-words rounded-md bg-muted/50 p-2 font-mono text-xs">
        {content}
      </pre>
    </div>
  );
}

function GenerationCard({ generation }: { generation: AIGeneration }) {
  const { t } = useTranslation();
  return (
    <div className="rounded-lg border p-3 space-y-3">
      {/* Model / provider / status */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-medium text-sm" title={generation.model}>
            {generation.model}
          </div>
          <div className="text-xs text-muted-foreground">
            {t("aiTraces.detail.provider", "Provider")}: {generation.provider}
          </div>
        </div>
        <Badge
          variant="secondary"
          className={`shrink-0 text-[10px] ${statusBadgeClass(generation.status)}`}
        >
          {t(`aiTraces.status.${generation.status}`, generation.status)}
        </Badge>
      </div>

      {/* Metrics */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-muted-foreground">
        <span>
          {t("aiTraces.detail.tokens", "Tokens")}: {(generation.inputTokens ?? 0).toLocaleString()}{" "}
          / {(generation.outputTokens ?? 0).toLocaleString()}
        </span>
        <span>
          {t("aiTraces.detail.cost", "Cost")}: {formatCost(generation.cost)}
        </span>
        <span>
          {t("aiTraces.detail.latency", "Latency")}: {formatLatency(generation.latencyMs)}
        </span>
      </div>

      {/* Optional flags */}
      {(generation.cached || generation.partial || generation.fallbackUsed) && (
        <div className="flex flex-wrap gap-1.5">
          {generation.cached && (
            <Badge variant="outline" className="text-[10px]">
              {t("aiTraces.detail.cached", "Cached")}
            </Badge>
          )}
          {generation.partial && (
            <Badge variant="outline" className="text-[10px]">
              {t("aiTraces.detail.partial", "Partial")}
            </Badge>
          )}
          {generation.fallbackUsed && (
            <Badge variant="outline" className="text-[10px]">
              {t("aiTraces.detail.fallback", "Fallback")}: {generation.fallbackUsed}
            </Badge>
          )}
        </div>
      )}

      {/* Error detail */}
      {generation.error && (
        <div className="flex items-start gap-1.5 rounded-md bg-red-50 p-2 text-xs text-red-700 dark:bg-red-950/30 dark:text-red-400">
          <XCircleIcon className="mt-0.5 size-3.5 shrink-0" />
          <span className="break-words">{generation.error}</span>
        </div>
      )}

      {/* Prompt messages (redacted server-side, displayed as-is) */}
      <div className="space-y-2">
        <div className="text-xs font-medium">{t("aiTraces.detail.prompt", "Prompt")}</div>
        {generation.messages.length === 0 ? (
          // Mirror the completion section's empty fallback: an empty messages
          // array (fully redacted / never recorded) must not leave the heading
          // orphaned with nothing beneath it.
          <p className="text-xs italic text-muted-foreground">
            {t("aiTraces.detail.noMessages", "No prompt messages recorded")}
          </p>
        ) : (
          generation.messages.map((message, i) => (
            <ContentBlock
              // biome-ignore lint/suspicious/noArrayIndexKey: messages are static per generation
              key={i}
              label={t(`aiTraces.detail.role.${message.role}`, message.role)}
              content={message.content}
            />
          ))
        )}
      </div>

      {/* Completion (redacted server-side; empty for streaming calls) */}
      <div className="space-y-2">
        <div className="text-xs font-medium">{t("aiTraces.detail.completion", "Completion")}</div>
        {generation.completion ? (
          <pre className="whitespace-pre-wrap break-words rounded-md bg-muted/50 p-2 font-mono text-xs">
            {generation.completion}
          </pre>
        ) : (
          <p className="text-xs italic text-muted-foreground">
            {t("aiTraces.detail.noCompletion", "No completion recorded (streaming or empty)")}
          </p>
        )}
      </div>
    </div>
  );
}

// ── Main component ───────────────────────────────────────

export function TraceDetailPanel({
  trace,
  onOpenChange,
}: {
  /** The selected trace, or null when the panel is closed. */
  trace: AITrace | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  // The fetched result, tagged with the traceId it belongs to. Rendering goes
  // through `resolveStoredResult` so a result for trace A is NEVER shown under
  // trace B's header (not even for the one frame before the fetch effect for B
  // commits) — the skeleton shows instead.
  const [stored, setStored] = useState<StoredGenerationsResult | null>(null);

  // Monotonic request token: a slow in-flight fetch for a previously selected
  // trace must not overwrite the result of a newer selection (same stale-guard
  // pattern as the list page).
  const reqSeq = useRef(0);

  const traceId = trace?.traceId;
  useEffect(() => {
    if (!traceId) {
      // Panel closed: drop the previous trace's generations instead of
      // retaining them in memory for the lifetime of the page.
      setStored(null);
      return;
    }
    const seq = ++reqSeq.current;
    const controller = new AbortController();
    fetchTraceGenerations({
      traceId,
      limit: GENERATION_LIMIT,
      signal: controller.signal,
    })
      .then((next) => {
        // Drop a stale response superseded by a newer selection, or one whose
        // request was aborted (panel closed / unmounted).
        if (seq !== reqSeq.current || controller.signal.aborted) return;
        setStored({ traceId, result: next });
      })
      .catch(() => {
        // fetchTraceGenerations never rejects by construction; this guard only
        // keeps the skeleton from sticking forever if that invariant changes.
        if (seq !== reqSeq.current || controller.signal.aborted) return;
        setStored({
          traceId,
          result: { kind: "error", message: "Failed to load trace generations" },
        });
      });
    // Abort the in-flight fetch when the selection changes or the panel closes.
    return () => controller.abort();
  }, [traceId]);

  // Null while closed, loading, or when `stored` belongs to a previous trace.
  const result = resolveStoredResult(stored, traceId);
  const generations = result?.kind === "ok" ? result.generations : [];

  return (
    <Sheet open={trace !== null} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
        <SheetHeader className="border-b px-4 py-3">
          <SheetTitle className="text-sm">
            {t("aiTraces.detail.title", "Trace Detail")}
            {trace && <span className="ml-2 font-normal text-muted-foreground">{trace.name}</span>}
          </SheetTitle>
          {trace && (
            <SheetDescription className="break-all font-mono text-xs">
              {trace.traceId}
            </SheetDescription>
          )}
        </SheetHeader>

        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          {/* Loading skeleton — panel open but no result for THIS trace yet
              (covers both the in-flight fetch and the pre-effect frame after
              switching traces). */}
          {traceId !== undefined && result === null && <PanelSkeleton />}

          {/* Permission-denied state */}
          {result?.kind === "denied" && (
            <div className="flex flex-col items-center justify-center gap-3 py-16 text-muted-foreground">
              <ShieldOffIcon className="size-10 opacity-30" />
              <p className="text-sm">
                {t("aiTraces.denied", "You don't have permission to view AI traces.")}
              </p>
            </div>
          )}

          {/* Error banner */}
          {result?.kind === "error" && (
            <div className="flex items-center gap-2 rounded-lg bg-red-50 p-4 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-400">
              <XCircleIcon className="size-4 shrink-0" />
              {t("aiTraces.detail.fetchError", "Failed to load trace detail")}: {result.message}
            </div>
          )}

          {/* Empty state */}
          {result?.kind === "ok" && generations.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-3 py-16 text-muted-foreground">
              <ActivityIcon className="size-10 opacity-30" />
              <p className="text-sm">
                {t("aiTraces.detail.empty", "No generations recorded for this trace")}
              </p>
            </div>
          )}

          {/* Generation cards */}
          {result?.kind === "ok" &&
            generations.map((generation) => (
              <GenerationCard key={generation.id} generation={generation} />
            ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}
