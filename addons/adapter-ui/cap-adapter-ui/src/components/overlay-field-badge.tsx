/**
 * OverlayFieldBadge — Subtle visual indicator for runtime overlay (custom) fields.
 *
 * Displays a small puzzle piece icon to distinguish overlay fields from
 * code-defined entity fields. Used in both AutoForm labels and AutoList column headers.
 */

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@linchkit/ui-kit/components";
import { Puzzle } from "lucide-react";
import { useTranslation } from "react-i18next";

interface OverlayFieldBadgeProps {
  /** Additional CSS class names */
  className?: string;
}

export function OverlayFieldBadge({ className }: OverlayFieldBadgeProps) {
  const { t } = useTranslation();

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Puzzle
            className={`size-3 text-muted-foreground/50 shrink-0 ${className ?? ""}`}
            aria-label={t("overlay.fieldBadge", "Custom field")}
          />
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          {t("overlay.fieldBadgeTooltip", "Runtime custom field (overlay)")}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
