/**
 * AI Insights Panel — shown on workspace dashboard
 *
 * Displays AI-detected patterns and suggestions, each with
 * confidence level and action buttons.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "@tanstack/react-router";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Skeleton,
} from "@linchkit/ui-kit/components";
import {
  AlertTriangleIcon,
  ArrowRight,
  BotIcon,
  BrainCircuitIcon,
  LightbulbIcon,
  ShieldCheckIcon,
  SparklesIcon,
  TrendingUpIcon,
  ZapIcon,
} from "lucide-react";
import { type AIInsight, fetchAIInsights } from "@/lib/proposal-api";

// ── Category config ──────────────────────────────────────

const CATEGORY_CONFIG: Record<string, {
  icon: typeof LightbulbIcon;
  color: string;
  bgColor: string;
}> = {
  rule_suggestion: {
    icon: ShieldCheckIcon,
    color: "text-blue-600 dark:text-blue-400",
    bgColor: "bg-blue-50 dark:bg-blue-950",
  },
  default_value: {
    icon: SparklesIcon,
    color: "text-purple-600 dark:text-purple-400",
    bgColor: "bg-purple-50 dark:bg-purple-950",
  },
  validation: {
    icon: ShieldCheckIcon,
    color: "text-green-600 dark:text-green-400",
    bgColor: "bg-green-50 dark:bg-green-950",
  },
  optimization: {
    icon: TrendingUpIcon,
    color: "text-orange-600 dark:text-orange-400",
    bgColor: "bg-orange-50 dark:bg-orange-950",
  },
  anomaly: {
    icon: AlertTriangleIcon,
    color: "text-red-600 dark:text-red-400",
    bgColor: "bg-red-50 dark:bg-red-950",
  },
};

// ── Confidence bar ───────────────────────────────────────

function ConfidenceBadge({ confidence }: { confidence: number }) {
  const pct = Math.round(confidence * 100);
  const color = pct >= 80
    ? "text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-950 border-green-200 dark:border-green-800"
    : pct >= 60
      ? "text-yellow-600 dark:text-yellow-400 bg-yellow-50 dark:bg-yellow-950 border-yellow-200 dark:border-yellow-800"
      : "text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950 border-red-200 dark:border-red-800";

  return (
    <Badge variant="outline" className={`text-[10px] gap-1 ${color}`}>
      {pct}%
    </Badge>
  );
}

// ── Insight item ─────────────────────────────────────────

function InsightItem({ insight }: { insight: AIInsight }) {
  const { t } = useTranslation();
  const defaultCfg = { icon: LightbulbIcon, color: "text-blue-600 dark:text-blue-400", bgColor: "bg-blue-50 dark:bg-blue-950" };
  const cfg = CATEGORY_CONFIG[insight.category] ?? defaultCfg;
  const Icon = cfg.icon;

  return (
    <div className="flex items-start gap-3 rounded-md border p-3">
      {/* Icon */}
      <div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${cfg.bgColor}`}>
        <Icon className={`h-4 w-4 ${cfg.color}`} />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <p className="text-sm leading-snug mb-1.5">{insight.description}</p>
        <div className="flex items-center gap-2 flex-wrap">
          <ConfidenceBadge confidence={insight.confidence} />
          {insight.relatedSchema && (
            <Badge variant="outline" className="text-[10px]">
              {insight.relatedSchema}
              {insight.relatedField ? `.${insight.relatedField}` : ""}
            </Badge>
          )}
          {insight.dataPoints && (
            <span className="text-[10px] text-muted-foreground">
              {t("insights.dataPoints", { count: insight.dataPoints })}
            </span>
          )}
        </div>
        <div className="mt-2">
          <Link to={"/schemas/proposal" as "/"}>
            <Button variant="outline" size="sm" className="h-6 text-[11px] gap-1">
              <ZapIcon className="h-3 w-3" />
              {t("insights.reviewProposal")}
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}

// ── Main panel ───────────────────────────────────────────

export function AIInsightsPanel() {
  const { t } = useTranslation();
  const [insights, setInsights] = useState<AIInsight[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchAIInsights()
      .then(setInsights)
      .catch(() => setInsights([]))
      .finally(() => setLoading(false));
  }, []);

  // Show nothing if no insights
  if (!loading && insights.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BrainCircuitIcon className="h-4 w-4 text-purple-500" />
            <div>
              <CardTitle className="text-sm">{t("insights.title")}</CardTitle>
              <CardDescription className="text-xs">
                {t("insights.subtitle")}
              </CardDescription>
            </div>
          </div>
          <Link
            to={"/schemas/proposal" as "/"}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {t("workspace.viewAll")}
            <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex items-start gap-3">
                <Skeleton className="h-8 w-8 rounded-lg" />
                <div className="flex-1 space-y-1">
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-3 w-32" />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-3">
            {insights.slice(0, 4).map((insight) => (
              <InsightItem key={insight.id} insight={insight} />
            ))}
            {insights.length > 4 && (
              <Link
                to={"/schemas/proposal" as "/"}
                className="block text-center text-xs text-muted-foreground hover:text-foreground transition-colors py-1"
              >
                {t("insights.viewMore", { count: insights.length - 4 })}
              </Link>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
