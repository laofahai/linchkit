/**
 * SchemaProposalCard — the in-product chat channel of "say → exists" (说→有).
 *
 * When a user types a schema-change utterance into the AI assistant
 * ("raise the manager-approval threshold to 20000"), `resolveSchemaIntent`
 * mints a GOVERNED `draft`-status Proposal. This card surfaces that draft and
 * carries it through the human-gated graduation path:
 *
 *     approve phase → Approve → approveProposal()  → graduate phase
 *     graduate phase → Open PR → graduateProposal() → done (renders the PR link)
 *
 * Unlike {@link ActionProposalCard} this card has NO Execute button — it never
 * runs a runtime Action. It only approves a draft and opens a PR (graduation
 * NEVER merges). All mutations stay double-human-gated per the hard rule
 * "AI Never Modifies Production Directly".
 *
 * State is split into two orthogonal axes so the JSX guards stay trivial and an
 * error never loses track of which step to retry:
 *   - `phase`  — which step the card is on: `approve` → `graduate` → `done`.
 *   - `busy`   — whether the current phase's request is in flight.
 *   - `error`  — the last failure's message (cleared when a request starts).
 * A failed approve stays in `phase: "approve"`; a failed graduate stays in
 * `phase: "graduate"` — so the right button is always the one offered for retry.
 *
 * Display derivation + the graduate-result mapping live in
 * `schema-proposal-card-helpers` so they can be unit-tested without a DOM
 * (this package's tests are logic-only). This file is rendering + I/O only.
 */

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@linchkit/ui-kit/components";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  CodeIcon,
  ExternalLinkIcon,
  GitPullRequestIcon,
  Loader2Icon,
  SparklesIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SchemaIntentDraft } from "../lib/ai-api";
import { approveProposal, graduateProposal } from "../lib/proposal-api";
import { mapGraduateResult, toSchemaProposalDisplay } from "./schema-proposal-card-helpers";

// ── Props ────────────────────────────────────────────────

export interface SchemaProposalCardProps {
  /** The draft minted by `resolveSchemaIntent` (`proposal_draft` arm). */
  draft: SchemaIntentDraft;
  /** Called once graduation opens a PR — the host removes the card. */
  onGraduated?: (prUrl: string) => void;
  /** Called when the user dismisses the card without acting. */
  onDismiss?: () => void;
}

/** Which step of the approve → graduate flow the card is on. */
type Phase = "approve" | "graduate" | "done";

// ── Component ────────────────────────────────────────────

export function SchemaProposalCard({ draft, onGraduated, onDismiss }: SchemaProposalCardProps) {
  const { t } = useTranslation();
  const display = toSchemaProposalDisplay(draft);
  const [phase, setPhase] = useState<Phase>("approve");
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [prUrl, setPrUrl] = useState<string | null>(null);

  const handleApprove = useCallback(async () => {
    if (!display.proposalId) {
      setErrorMessage(t("schemaProposal.missingId"));
      return;
    }
    setBusy(true);
    setErrorMessage(null);
    try {
      await approveProposal(display.proposalId);
      setPhase("graduate");
    } catch (err) {
      // Stay in the approve phase so the user can retry approval.
      setErrorMessage(err instanceof Error ? err.message : t("schemaProposal.approveError"));
    } finally {
      setBusy(false);
    }
  }, [display.proposalId, t]);

  const handleGraduate = useCallback(async () => {
    if (!display.proposalId) {
      setErrorMessage(t("schemaProposal.missingId"));
      return;
    }
    setBusy(true);
    setErrorMessage(null);
    try {
      const next = mapGraduateResult(await graduateProposal(display.proposalId));
      if (next.status === "done") {
        setPrUrl(next.prUrl);
        setPhase("done");
        onGraduated?.(next.prUrl);
      } else {
        // Stay in the graduate phase so the user can retry. `next.messageKey` is
        // an i18n key; append the server's raw message (when present) so the
        // reviewer sees the localized headline plus the specifics.
        const headline = t(next.messageKey);
        setErrorMessage(next.rawMessage ? `${headline} — ${next.rawMessage}` : headline);
      }
    } catch (err) {
      // A thrown graduateProposal (network/transport) must not leave the card
      // stuck in `busy`. Surface the error and stay in the graduate phase so the
      // user can retry.
      setErrorMessage(err instanceof Error ? err.message : t("schemaProposal.graduateError"));
    } finally {
      setBusy(false);
    }
  }, [display.proposalId, onGraduated, t]);

  const handleDismiss = useCallback(() => {
    onDismiss?.();
  }, [onDismiss]);

  return (
    <Card data-testid="schema-proposal-card">
      <CardHeader className="gap-1 pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-1.5 text-sm font-medium">
            <SparklesIcon className="size-3.5 text-primary" />
            {display.name ?? t("schemaProposal.draftCreated")}
          </CardTitle>
          <div className="flex items-center gap-1.5">
            <Badge variant="secondary" className="text-[10px] uppercase">
              {display.statusLabel}
            </Badge>
            <Badge variant="outline" className="text-[10px]">
              {display.confidencePct}
            </Badge>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className="text-[10px]">
            {display.isEntity ? t("schemaProposal.entityKind") : t("schemaProposal.ruleKind")}
          </Badge>
          {display.requiresCodeChange && (
            <Badge
              variant="default"
              className="gap-1 text-[10px]"
              data-testid="requires-code-badge"
            >
              <CodeIcon className="size-2.5" />
              {t("schemaProposal.requiresCode")}
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-2">
        {display.explanation && (
          <p className="text-xs text-muted-foreground">{display.explanation}</p>
        )}

        <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
          {display.targetEntity && (
            <span>
              {t("schemaProposal.targetEntity")}:{" "}
              <span className="font-medium">{display.targetEntity}</span>
            </span>
          )}
          {display.proposalId && (
            <span>
              {t("schemaProposal.proposalId")}:{" "}
              <span className="font-mono">{display.proposalId}</span>
            </span>
          )}
        </div>

        {display.diffSummary && (
          <pre className="overflow-x-auto rounded-md bg-muted/60 p-2 text-[11px] text-muted-foreground">
            {display.diffSummary}
          </pre>
        )}

        {/* Error banner — stays visible so the user can retry the same phase. */}
        {errorMessage && (
          <div className="flex items-start gap-1.5 rounded-md bg-destructive/10 p-2">
            <AlertTriangleIcon className="mt-0.5 size-3 shrink-0 text-destructive" />
            <p className="text-[11px] text-destructive">{errorMessage}</p>
          </div>
        )}

        {/* Graduated — render the PR link (or a "no link" note when empty). */}
        {phase === "done" && (
          <div className="flex items-start gap-1.5 rounded-md border border-green-200 bg-green-50 p-2 dark:border-green-900 dark:bg-green-950/30">
            <CheckCircle2Icon className="mt-0.5 size-3 shrink-0 text-green-600" />
            {prUrl ? (
              <a
                href={prUrl}
                target="_blank"
                rel="noreferrer"
                data-testid="schema-proposal-pr-link"
                className="inline-flex items-center gap-1 text-[11px] font-medium text-green-700 underline dark:text-green-300"
              >
                <ExternalLinkIcon className="size-3" />
                {t("schemaProposal.openedPr")}
              </a>
            ) : (
              <p className="text-[11px] text-green-700 dark:text-green-300">
                {t("schemaProposal.graduatedNoPr")}
              </p>
            )}
          </div>
        )}

        {/* Done — the card stays mounted so the PR link is readable; this lets
            the user dismiss it once they've followed (or noted) the link. */}
        {phase === "done" && (
          <div className="flex items-center justify-end pt-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={handleDismiss}
              data-testid="schema-proposal-done-dismiss"
            >
              <XIcon className="mr-1 size-3" />
              {t("schemaProposal.dismiss")}
            </Button>
          </div>
        )}

        {/* ── Approve phase ── */}
        {phase === "approve" && (
          <div className="flex items-center justify-end gap-2 pt-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={handleDismiss}
              disabled={busy}
            >
              <XIcon className="mr-1 size-3" />
              {t("schemaProposal.dismiss")}
            </Button>
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={() => void handleApprove()}
              disabled={busy}
              data-testid="schema-proposal-approve"
            >
              {busy ? (
                <Loader2Icon className="mr-1 size-3 animate-spin" />
              ) : (
                <CheckCircle2Icon className="mr-1 size-3" />
              )}
              {t("schemaProposal.approve")}
            </Button>
          </div>
        )}

        {/* ── Graduate phase ── */}
        {phase === "graduate" && (
          <div className="flex items-center justify-end gap-2 pt-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={handleDismiss}
              disabled={busy}
            >
              <XIcon className="mr-1 size-3" />
              {t("schemaProposal.dismiss")}
            </Button>
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={() => void handleGraduate()}
              disabled={busy}
              data-testid="schema-proposal-graduate"
            >
              {busy ? (
                <Loader2Icon className="mr-1 size-3 animate-spin" />
              ) : (
                <GitPullRequestIcon className="mr-1 size-3" />
              )}
              {t("schemaProposal.openPr")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
