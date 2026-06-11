/**
 * NlRuleDrafter — "say it → it exists" (说→有) rule drafting affordance.
 *
 * A focused, self-contained surface for turning a natural-language utterance
 * into a GOVERNED rule draft via `POST /api/ai/resolve-schema-intent`. Placed on
 * the Evolution page (the proposal / evolution management surface) so the draft
 * it produces sits next to the review pipeline it feeds.
 *
 * Hard rule ("AI Never Modifies Production Directly"): the endpoint persists a
 * `draft`-status Proposal only — this component NEVER submits, approves, or
 * applies anything. On a `proposal_draft` outcome it surfaces the draft and
 * links the user into the existing Proposal review surface.
 *
 * Outcome handling mirrors `ai-assistant.tsx`'s `resolveIntent` UX:
 *  - proposal_draft → draft card (id / status / confidence) + "review" link.
 *  - clarification  → show the question; the input stays so the user can refine.
 *  - no_match       → show the reason.
 *  - unavailable    → graceful "AI not configured" message (503).
 *  - error          → user-friendly error state.
 */

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@linchkit/ui-kit/components";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangleIcon,
  ExternalLinkIcon,
  HelpCircleIcon,
  Loader2Icon,
  SearchXIcon,
  SparklesIcon,
  WandSparklesIcon,
} from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { type ResolveSchemaIntentResult, resolveSchemaIntent } from "../lib/api";

/**
 * Format a confidence score (0-1) as a percentage. Defensive against
 * NaN/Infinity/undefined leaking from a malformed AI response.
 */
function formatConfidencePct(confidence: number | undefined): string {
  if (confidence == null || !Number.isFinite(confidence)) return "—";
  return `${Math.round(confidence * 100)}%`;
}

export function NlRuleDrafter() {
  const { t } = useTranslation();
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ResolveSchemaIntentResult | null>(null);

  const handleSubmit = useCallback(async () => {
    const trimmed = prompt.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      const outcome = await resolveSchemaIntent(trimmed);
      setResult(outcome);
      // On a successful draft, clear the input so a stale prompt does not look
      // like it is still pending. For clarification we KEEP the prompt so the
      // user can refine and resubmit without retyping.
      if (outcome.kind === "proposal_draft") {
        setPrompt("");
      }
    } catch (err) {
      // resolveSchemaIntent maps transport errors internally, but a defensive
      // catch keeps an unexpected throw (e.g. handleUnauthorized, or storage
      // access denied) from becoming an unhandled rejection with no UI feedback.
      setResult({
        kind: "error",
        message: err instanceof Error ? err.message : "Schema intent resolution failed",
      });
    } finally {
      setSubmitting(false);
    }
  }, [prompt, submitting]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleSubmit();
      }
    },
    [handleSubmit],
  );

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <SparklesIcon className="size-4 text-primary" />
          {t("nlRule.title")}
        </CardTitle>
        <CardDescription>{t("nlRule.subtitle")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-end gap-2">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t("nlRule.placeholder")}
            aria-label={t("nlRule.title")}
            rows={2}
            className="flex-1 resize-none rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            disabled={submitting}
          />
          <Button
            size="sm"
            onClick={() => void handleSubmit()}
            disabled={submitting || prompt.trim().length === 0}
          >
            {submitting ? (
              <Loader2Icon className="mr-1 size-3.5 animate-spin" />
            ) : (
              <WandSparklesIcon className="mr-1 size-3.5" />
            )}
            {t("nlRule.draft")}
          </Button>
        </div>

        {result && <SchemaIntentOutcome result={result} t={t} />}
      </CardContent>
    </Card>
  );
}

// ── Outcome renderer ─────────────────────────────────────

function SchemaIntentOutcome({
  result,
  t,
}: {
  result: ResolveSchemaIntentResult;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  switch (result.kind) {
    case "proposal_draft": {
      const { draft } = result;
      return (
        <div className="rounded-md border bg-muted/40 p-3 space-y-2" data-testid="draft-outcome">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-sm font-medium">
              <SparklesIcon className="size-3.5 text-primary" />
              {draft.ruleName ?? t("nlRule.draftCreated")}
            </div>
            <div className="flex items-center gap-1.5">
              <Badge variant="secondary" className="text-[10px] uppercase">
                {draft.proposalStatus ?? "draft"}
              </Badge>
              <Badge variant="outline" className="text-[10px]">
                {formatConfidencePct(draft.confidence)}
              </Badge>
            </div>
          </div>
          {draft.explanation && (
            <p className="text-xs text-muted-foreground">{draft.explanation}</p>
          )}
          <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
            {draft.targetEntity && (
              <span>
                {t("nlRule.targetEntity")}:{" "}
                <span className="font-medium">{draft.targetEntity}</span>
              </span>
            )}
            {draft.proposalId && (
              <span>
                {t("nlRule.proposalId")}: <span className="font-mono">{draft.proposalId}</span>
              </span>
            )}
          </div>
          {/* Route the user to the existing review surface — this component never
              approves or applies; review/approval stays human-gated there. */}
          <Link to={"/admin/proposals" as "/"}>
            <Button variant="outline" size="sm" className="h-7 gap-1 text-xs">
              <ExternalLinkIcon className="size-3" />
              {t("nlRule.reviewDraft")}
            </Button>
          </Link>
        </div>
      );
    }

    case "clarification":
      return (
        <div
          className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/30"
          data-testid="clarification-outcome"
        >
          <HelpCircleIcon className="mt-0.5 size-4 shrink-0 text-amber-500" />
          <div className="space-y-1">
            {result.question && (
              <p className="text-sm text-amber-700 dark:text-amber-300">{result.question}</p>
            )}
            <p className="text-[11px] text-muted-foreground">{t("nlRule.refineHint")}</p>
          </div>
        </div>
      );

    case "no_match":
      return (
        <div
          className="flex items-start gap-2 rounded-md border bg-muted/40 p-3"
          data-testid="no-match-outcome"
        >
          <SearchXIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            {result.reason ?? result.message ?? t("nlRule.noMatch")}
          </p>
        </div>
      );

    case "unavailable":
      return (
        <div
          className="flex items-start gap-2 rounded-md border border-dashed bg-muted/40 p-3"
          data-testid="unavailable-outcome"
        >
          <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            {result.message ?? t("nlRule.notConfigured")}
          </p>
        </div>
      );

    case "error":
      return (
        <div
          className="flex items-start gap-2 rounded-md bg-destructive/10 p-3"
          data-testid="error-outcome"
        >
          <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
          <p className="text-sm text-destructive">{result.message || t("nlRule.error")}</p>
        </div>
      );
  }
}
