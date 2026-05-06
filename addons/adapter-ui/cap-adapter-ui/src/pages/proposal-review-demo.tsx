/**
 * ProposalReviewDemoPage — `/admin/proposals/preview-demo`.
 *
 * Demo route for ProposalImpactPreview (Spec 55 §7.3). Renders the panel
 * against several mock ProposalPreAnalysisResult fixtures so reviewers can
 * see every render branch (full data, errors, skipped, partial, empty).
 *
 * This page is intentionally a fixture playground — when a real Proposal
 * review page lands, the panel is dropped in by importing the component.
 */

import type { ProposalPreAnalysisResult } from "@linchkit/core";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@linchkit/ui-kit/components";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ProposalImpactPreview } from "@/components/proposal-impact-preview";

// ── Mock fixtures ──────────────────────────────────────────

interface Fixture {
  id: string;
  labelKey: string;
  result: ProposalPreAnalysisResult | null;
}

const NOW = new Date("2026-05-06T10:00:00Z");

const fullFixture: ProposalPreAnalysisResult = {
  proposalId: "prop_full_001",
  analyzedAt: NOW,
  totalDurationMs: 184,
  allStagesSucceeded: true,
  stages: {
    dedup: {
      stage: "dedup",
      status: "ok",
      durationMs: 22,
      data: {
        payloadHash: "sha256:9a3f…b21",
        exactMatch: null,
        similar: [
          {
            id: "prop_2025_0042",
            title: "Add priority field to task entity",
            description: "",
            author: { type: "ai", id: "ai-claude", name: "Claude" },
            capability: "demo",
            changeType: "minor",
            changes: [],
            impact: {
              schemasAffected: [],
              actionsAffected: [],
              rulesAffected: [],
              dependentsAffected: [],
              migrationRequired: false,
            },
            status: "draft",
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      },
    },
    conflict: {
      stage: "conflict",
      status: "ok",
      durationMs: 31,
      data: {
        notes: "Checked 12 active rules and 3 state machines.",
        conflicts: [
          {
            kind: "rule",
            targetId: "task.priority_required",
            message: "New default priority value contradicts active 'priority_required' rule.",
          },
          {
            kind: "state_transition",
            targetId: "task.in_progress→done",
            message: "Proposed transition guard already validates priority elsewhere.",
          },
          {
            kind: "proposal",
            targetId: "prop_2025_0042",
            message: "Pending proposal also touches task.priority — review both together.",
          },
        ],
      },
    },
    impact: {
      stage: "impact",
      status: "ok",
      durationMs: 91,
      data: {
        affectedRecordCount: 14_237,
        sampleRecordIds: [
          "task_a1b2",
          "task_c3d4",
          "task_e5f6",
          "task_0001",
          "task_0002",
          "task_0003",
        ],
        probedEntities: ["task", "task_audit"],
        reason: undefined,
      },
    },
    backtest: {
      stage: "backtest",
      status: "ok",
      durationMs: 40,
      data: {
        windowDays: 30,
        hypotheticalTriggerCount: 412,
        summary: "187 of 412 hypothetical triggers matched recently rejected outcomes.",
      },
    },
  },
};

const errorFixture: ProposalPreAnalysisResult = {
  proposalId: "prop_err_002",
  analyzedAt: NOW,
  totalDurationMs: 19,
  allStagesSucceeded: false,
  stages: {
    dedup: {
      stage: "dedup",
      status: "error",
      durationMs: 9,
      error: { code: "STORE_UNAVAILABLE", message: "PendingProposalStore did not respond." },
    },
    conflict: {
      stage: "conflict",
      status: "skipped",
      durationMs: 0,
    },
    impact: {
      stage: "impact",
      status: "ok",
      durationMs: 10,
      data: {
        affectedRecordCount: 0,
        sampleRecordIds: [],
        probedEntities: [],
        reason: "not-a-data-change",
      },
    },
    backtest: {
      stage: "backtest",
      status: "skipped",
      durationMs: 0,
    },
  },
};

const partialFixture: ProposalPreAnalysisResult = {
  proposalId: "prop_partial_003",
  analyzedAt: NOW,
  totalDurationMs: 11,
  allStagesSucceeded: true,
  stages: {
    dedup: {
      stage: "dedup",
      status: "ok",
      durationMs: 11,
      data: {
        payloadHash: "sha256:0000…0001",
        exactMatch: null,
        similar: [],
      },
    },
    // conflict / impact / backtest deliberately omitted to exercise the
    // "stage missing entirely" branch.
  },
};

const fixtures: Fixture[] = [
  {
    id: "full",
    labelKey: "proposals.preanalysis.demo.fixtures.full",
    result: fullFixture,
  },
  {
    id: "error",
    labelKey: "proposals.preanalysis.demo.fixtures.error",
    result: errorFixture,
  },
  {
    id: "partial",
    labelKey: "proposals.preanalysis.demo.fixtures.partial",
    result: partialFixture,
  },
  {
    id: "empty",
    labelKey: "proposals.preanalysis.demo.fixtures.empty",
    result: null,
  },
];

// ── Page ───────────────────────────────────────────────────

export function ProposalReviewDemoPage() {
  const { t } = useTranslation();
  const [activeId, setActiveId] = useState<string>(fixtures[0]?.id ?? "full");
  const active = fixtures.find((f) => f.id === activeId) ?? fixtures[0];

  return (
    <div className="p-4 space-y-4 max-w-4xl mx-auto">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("proposals.preanalysis.demo.title")}</CardTitle>
          <CardDescription>{t("proposals.preanalysis.demo.subtitle")}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {fixtures.map((f) => (
              <Button
                key={f.id}
                size="sm"
                variant={f.id === activeId ? "default" : "outline"}
                onClick={() => setActiveId(f.id)}
              >
                {t(f.labelKey)}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      <ProposalImpactPreview result={active?.result} />
    </div>
  );
}
