/**
 * AiSuggestionBadge — Inline overlay for an AI-suggested field value.
 *
 * Shows the suggested value in blue with accept/reject mini buttons.
 * Appears below the field input when the field has an AI suggestion.
 */

import { Button } from "@linchkit/ui-kit/components";
import { Check, Info, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AiFieldSuggestion } from "../lib/ai-api";

export interface AiSuggestionBadgeProps {
  suggestion: AiFieldSuggestion;
  onAccept: () => void;
  onReject: () => void;
}

/** Format a suggestion value for display */
function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function AiSuggestionBadge({ suggestion, onAccept, onReject }: AiSuggestionBadgeProps) {
  const { t } = useTranslation();

  return (
    <div className="mt-1 flex items-start gap-1.5 rounded-md border border-blue-200 bg-blue-50 px-2 py-1.5 text-xs dark:border-blue-800 dark:bg-blue-950/50 animate-in fade-in slide-in-from-top-1 duration-200">
      <div className="flex-1 min-w-0">
        <span className="font-medium text-blue-700 dark:text-blue-300">
          {formatValue(suggestion.value)}
        </span>
        {suggestion.reason && (
          <span className="ml-1.5 text-blue-500/70 dark:text-blue-400/70">
            <Info className="inline-block size-3 mr-0.5 -mt-0.5" />
            {suggestion.reason}
          </span>
        )}
      </div>
      <div className="flex items-center gap-0.5 shrink-0">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-5 text-green-600 hover:text-green-700 hover:bg-green-100 dark:text-green-400 dark:hover:bg-green-900/30"
          onClick={onAccept}
          title={t("ai.accept", "Accept")}
        >
          <Check className="size-3" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-5 text-red-500 hover:text-red-600 hover:bg-red-100 dark:text-red-400 dark:hover:bg-red-900/30"
          onClick={onReject}
          title={t("ai.reject", "Reject")}
        >
          <X className="size-3" />
        </Button>
      </div>
    </div>
  );
}
