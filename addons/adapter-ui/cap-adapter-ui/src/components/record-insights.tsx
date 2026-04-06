/**
 * RecordInsights — Collapsible panel showing AI-generated insights for a record.
 *
 * Fetches analysis on demand via POST /api/ai/analyze-record, then renders
 * each insight as a card with severity icon, title, and description.
 * Risk insights show severity badge, recommendation insights show "Apply" button,
 * related record insights show clickable links.
 *
 * See spec 52 — AI Deep Integration, P2 Record Analysis.
 */

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@linchkit/ui-kit/components";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangleIcon,
  BrainCircuitIcon,
  ChevronDownIcon,
  GitCompareArrowsIcon,
  InfoIcon,
  LightbulbIcon,
  LinkIcon,
  Loader2Icon,
  ShieldAlertIcon,
  SparklesIcon,
  TimerIcon,
} from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

// ── Types (mirrors core RecordInsight) ──────────────────────

interface RecordInsight {
  type: "comparison" | "timeline" | "risk" | "recommendation" | "related";
  severity: "info" | "warning" | "critical";
  title: string;
  description: string;
  data?: {
    comparison?: { current: number; average: number; field: string };
    relatedRecords?: Array<{ id: string; entity: string; label: string }>;
    suggestedAction?: { action: string; input: Record<string, unknown> };
  };
}

interface RecordAnalysis {
  recordId: string;
  entityName: string;
  insights: RecordInsight[];
  generatedAt: string;
  model: string;
}

// ── Props ───────────────────────────────────────────────────

export interface RecordInsightsProps {
  entityName: string;
  recordId: string;
  onApplyAction?: (action: string, input: Record<string, unknown>) => void;
}

// ── API call ────────────────────────────────────────────────

async function fetchRecordAnalysis(
  entityName: string,
  recordId: string,
): Promise<RecordAnalysis | null> {
  const res = await fetch("/api/ai/analyze-record", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entityName, recordId }),
  });
  if (!res.ok) return null;
  const json = await res.json();
  return json.data ?? null;
}

// ── Insight type config ─────────────────────────────────────

const TYPE_CONFIG: Record<string, { icon: typeof InfoIcon; color: string }> = {
  comparison: { icon: GitCompareArrowsIcon, color: "text-blue-500" },
  timeline: { icon: TimerIcon, color: "text-indigo-500" },
  risk: { icon: ShieldAlertIcon, color: "text-red-500" },
  recommendation: { icon: LightbulbIcon, color: "text-amber-500" },
  related: { icon: LinkIcon, color: "text-purple-500" },
};

const SEVERITY_CONFIG: Record<string, { variant: "default" | "secondary" | "destructive" }> = {
  info: { variant: "secondary" },
  warning: { variant: "default" },
  critical: { variant: "destructive" },
};

// ── Insight Card ────────────────────────────────────────────

function InsightCard({
  insight,
  onApplyAction,
}: {
  insight: RecordInsight;
  onApplyAction?: (action: string, input: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation();
  const cfg = TYPE_CONFIG[insight.type] ?? { icon: InfoIcon, color: "text-muted-foreground" };
  const Icon = cfg.icon;
  const sevCfg = SEVERITY_CONFIG[insight.severity] ?? { variant: "secondary" as const };

  return (
    <div className="flex items-start gap-2.5 rounded-md border p-2.5">
      <Icon className={`mt-0.5 size-4 shrink-0 ${cfg.color}`} />
      <div className="flex-1 min-w-0 space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium leading-snug">{insight.title}</span>
          {(insight.severity === "warning" || insight.severity === "critical") && (
            <Badge variant={sevCfg.variant} className="text-[9px] px-1 py-0">
              {insight.severity}
            </Badge>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground leading-relaxed">{insight.description}</p>

        {/* Comparison data */}
        {insight.data?.comparison && (
          <div className="text-[11px] text-muted-foreground">
            {insight.data.comparison.field}: {insight.data.comparison.current} (
            {t("ai.insights.avg")}: {insight.data.comparison.average})
          </div>
        )}

        {/* Related record links */}
        {insight.data?.relatedRecords && insight.data.relatedRecords.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            {insight.data.relatedRecords.map((rec) => (
              <Link
                key={`${rec.entity}-${rec.id}`}
                to={"/entities/$name/$id" as "/"}
                params={{ name: rec.entity, id: rec.id }}
                className="text-[11px] text-primary hover:underline"
              >
                {rec.label}
              </Link>
            ))}
          </div>
        )}

        {/* Recommendation action button */}
        {insight.data?.suggestedAction && onApplyAction && (
          <Button
            variant="outline"
            size="sm"
            className="h-6 text-[10px] mt-1"
            onClick={() => {
              const sa = insight.data?.suggestedAction;
              if (!sa) return;
              const { action, input } = sa;
              onApplyAction(action, input);
            }}
          >
            <SparklesIcon className="mr-1 size-3" />
            {t("ai.insights.apply")}
          </Button>
        )}
      </div>
    </div>
  );
}

// ── Main Component ──────────────────────────────────────────

export function RecordInsights({ entityName, recordId, onApplyAction }: RecordInsightsProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [analysis, setAnalysis] = useState<RecordAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetched, setFetched] = useState(false);

  const handleAnalyze = useCallback(async () => {
    if (fetched) return; // already fetched
    setLoading(true);
    setError(null);
    try {
      const result = await fetchRecordAnalysis(entityName, recordId);
      setAnalysis(result);
      setFetched(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("ai.insights.error"));
    } finally {
      setLoading(false);
    }
  }, [entityName, recordId, fetched, t]);

  const handleToggle = useCallback(
    (isOpen: boolean) => {
      setOpen(isOpen);
      if (isOpen && !fetched && !loading) {
        handleAnalyze();
      }
    },
    [fetched, loading, handleAnalyze],
  );

  return (
    <Card>
      <Collapsible open={open} onOpenChange={handleToggle}>
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer select-none py-3 px-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <BrainCircuitIcon className="size-4 text-purple-500" />
                <CardTitle className="text-sm">{t("ai.insights.title")}</CardTitle>
                {analysis && analysis.insights.length > 0 && (
                  <Badge variant="secondary" className="text-[10px]">
                    {analysis.insights.length}
                  </Badge>
                )}
              </div>
              <ChevronDownIcon
                className={`size-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
              />
            </div>
          </CardHeader>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <CardContent className="pt-0 pb-3 px-4">
            {loading && (
              <div className="flex items-center gap-2 py-4 justify-center">
                <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
                <span className="text-xs text-muted-foreground">{t("ai.insights.analyzing")}</span>
              </div>
            )}

            {error && (
              <div className="flex items-center gap-2 py-3">
                <AlertTriangleIcon className="size-3.5 text-destructive" />
                <span className="text-xs text-destructive">{error}</span>
              </div>
            )}

            {!loading && !error && analysis && analysis.insights.length === 0 && (
              <p className="text-xs text-muted-foreground py-3 text-center">
                {t("ai.insights.noInsights")}
              </p>
            )}

            {!loading && analysis && analysis.insights.length > 0 && (
              <div className="space-y-2">
                {analysis.insights.map((insight, idx) => (
                  <InsightCard
                    // biome-ignore lint/suspicious/noArrayIndexKey: insights have no stable ID
                    key={`${insight.type}-${insight.title}-${idx}`}
                    insight={insight}
                    onApplyAction={onApplyAction}
                  />
                ))}
              </div>
            )}

            {!loading && !fetched && !error && (
              <div className="flex justify-center py-3">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs gap-1.5"
                  onClick={handleAnalyze}
                >
                  <SparklesIcon className="size-3" />
                  {t("ai.insights.analyze")}
                </Button>
              </div>
            )}
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
