/**
 * ProposalValidationFindings — Spec 09 §4.5 review surface.
 *
 * Renders a proposal's validation findings — especially Phase 3 (compatibility
 * / breaking-reference) errors and warnings — so a reviewer can see that a
 * proposal would break existing references before approving it.
 *
 * Layout: one bordered section per non-skipped phase that carries findings.
 * Errors use destructive styling; warnings use amber/advisory styling. Each
 * finding shows its `code` (mono) + `message`, plus optional `target` / `field`
 * context. The compatibility phase (Phase 3) is emphasised and sorted first.
 *
 * Purely presentational and READ-ONLY: it never validates, approves, applies,
 * or mutates anything. If `validationResult` is absent, all phases are
 * skipped/clean, or data is partial, it renders a subtle "no issues" line (or
 * nothing when `hideWhenEmpty`) and never crashes.
 */

import { Badge, Card, CardContent, CardHeader, CardTitle } from "@linchkit/ui-kit/components";
import { AlertTriangleIcon, CheckCircle2Icon, ShieldAlertIcon, XCircleIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ProposalValidationFinding, ProposalValidationResult } from "../lib/proposal-api";
import {
  type FindingTone,
  type PhaseWithFindings,
  selectPhasesWithFindings,
} from "./proposal-validation-findings-helpers";

// ── Component props ────────────────────────────────────────

export interface ProposalValidationFindingsProps {
  /** The proposal's validation result. Null/undefined → renders nothing/empty. */
  result: ProposalValidationResult | null | undefined;
  /** When true, render nothing at all if there are no findings. */
  hideWhenEmpty?: boolean;
  /** Optional className for the outer wrapper. */
  className?: string;
}

// ── Tone styling (mirrors proposal-impact-preview tones) ───

const FINDING_BLOCK_CLASS: Record<FindingTone, string> = {
  error: "rounded-md border border-destructive/30 bg-destructive/5 p-2.5",
  warning: "rounded-md border border-amber-500/30 bg-amber-500/5 p-2.5",
};

const FINDING_CODE_CLASS: Record<FindingTone, string> = {
  error: "font-mono text-[11px] text-destructive",
  warning: "font-mono text-[11px] text-amber-700 dark:text-amber-400",
};

// ── Single finding row ─────────────────────────────────────

function FindingRow({ finding, tone }: { finding: ProposalValidationFinding; tone: FindingTone }) {
  const Icon = tone === "error" ? XCircleIcon : AlertTriangleIcon;
  const iconClass = tone === "error" ? "text-destructive" : "text-amber-500";

  // Compose optional target/field context defensively.
  const context = [finding.target, finding.field].filter(Boolean).join(" · ");

  return (
    <div className={FINDING_BLOCK_CLASS[tone]}>
      <div className="flex items-start gap-2">
        <Icon className={`h-3.5 w-3.5 shrink-0 mt-0.5 ${iconClass}`} />
        <div className="min-w-0 text-xs">
          <div className={FINDING_CODE_CLASS[tone]}>{finding.code}</div>
          <div className="mt-0.5 text-foreground">{finding.message}</div>
          {context && <div className="mt-0.5 text-[11px] text-muted-foreground">{context}</div>}
        </div>
      </div>
    </div>
  );
}

// ── One phase section ──────────────────────────────────────

function PhaseSection({ phase }: { phase: PhaseWithFindings }) {
  const { t } = useTranslation();
  const titleKey = phase.isCompatibility
    ? "proposals.findings.compatibilityTitle"
    : "proposals.findings.phaseTitle";

  return (
    <Card
      className={`border-l-4 ${phase.errors.length > 0 ? "border-l-destructive" : "border-l-amber-500"}`}
    >
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          {phase.isCompatibility ? (
            <ShieldAlertIcon className="h-4 w-4 text-muted-foreground" />
          ) : (
            <AlertTriangleIcon className="h-4 w-4 text-muted-foreground" />
          )}
          {t(titleKey, { phase: phase.phase })}
          {phase.errors.length > 0 && (
            <Badge
              variant="outline"
              className="text-[10px] bg-destructive/10 text-destructive border-destructive/30"
            >
              {t("proposals.findings.errorCount", { count: phase.errors.length })}
            </Badge>
          )}
          {phase.warnings.length > 0 && (
            <Badge
              variant="outline"
              className="text-[10px] bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30"
            >
              {t("proposals.findings.warningCount", { count: phase.warnings.length })}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1.5 pt-0">
        {phase.errors.map((finding) => (
          <FindingRow
            key={`err-${finding.code}-${finding.target ?? ""}-${finding.field ?? ""}-${finding.message}`}
            finding={finding}
            tone="error"
          />
        ))}
        {phase.warnings.map((finding) => (
          <FindingRow
            key={`warn-${finding.code}-${finding.target ?? ""}-${finding.field ?? ""}-${finding.message}`}
            finding={finding}
            tone="warning"
          />
        ))}
      </CardContent>
    </Card>
  );
}

// ── Main component ─────────────────────────────────────────

export function ProposalValidationFindings({
  result,
  hideWhenEmpty = false,
  className,
}: ProposalValidationFindingsProps) {
  const { t } = useTranslation();
  const phases = selectPhasesWithFindings(result);

  if (phases.length === 0) {
    if (hideWhenEmpty) return null;
    // No non-skipped phase carries findings here, so distinguish only
    // "validated, all clean" (a result is present) from "no validation result".
    const messageKey = result ? "proposals.findings.clean" : "proposals.findings.empty";
    return (
      <div className={`flex items-center gap-2 text-xs text-muted-foreground ${className ?? ""}`}>
        <CheckCircle2Icon className="h-3.5 w-3.5 text-emerald-500" />
        <span>{t(messageKey)}</span>
      </div>
    );
  }

  return (
    <div className={`space-y-3 ${className ?? ""}`}>
      <h3 className="text-sm font-semibold">{t("proposals.findings.heading")}</h3>
      {phases.map((phase) => (
        <PhaseSection key={phase.phase} phase={phase} />
      ))}
    </div>
  );
}
